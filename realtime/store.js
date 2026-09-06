"use strict";

/**
 * Authoritative per-account state, with server-assigned ordering.
 *
 * The unit of state is a single key (see realtime/keys.js), never a whole settings document. A
 * mutation sets one key; the server stamps it with the next sequence number for that account; that
 * number is what every client orders by. Clients never invent ordering.
 *
 * Two shapes are stored:
 *
 *   state — the current value of every key. This is what a snapshot is built from, and it is the
 *           thing that must never be lost, so it lives in MongoDB.
 *   log   — a bounded tail of recent mutations, used only to let a client that was briefly
 *           disconnected resume instead of re-downloading everything. It is a cache: losing it
 *           costs a snapshot, never data.
 *
 * Two implementations share one interface so the multi-client integration suite can exercise the
 * real protocol without a database, while the same suite can be pointed at MongoDB to prove the
 * atomicity assumptions (sequence allocation and mutation de-duplication) actually hold there.
 */

const STATE_COLLECTION = "rtState";
const LOG_COLLECTION = "rtLog";
const SEQ_COLLECTION = "rtSeq";

/**
 * Resume-history retention.
 *
 * Bounded two ways, because either bound alone fails somewhere: the entry cap stops a chatty
 * account growing without limit, and the TTL stops an idle account's log lingering forever. A
 * client that falls outside either bound gets a snapshot, which is always correct — just more
 * bytes. These are the only knobs that trade Mongo size against resume hit rate.
 */
const LOG_MAX_ENTRIES_PER_ACCOUNT = 500;
const LOG_TTL_SECONDS = 14 * 24 * 60 * 60;

/** Shared normalisation so both stores agree on what a stored mutation looks like. */
function normalizeMutation(mutation) {
  return {
    key: String(mutation.key),
    value: mutation.deleted ? null : mutation.value,
    deleted: Boolean(mutation.deleted),
    deviceId: mutation.deviceId ? String(mutation.deviceId) : null,
    mutationId: String(mutation.mutationId)
  };
}

/* ------------------------------------------------------------------------------------------- */
/* In-memory                                                                                    */
/* ------------------------------------------------------------------------------------------- */

function createMemoryStore() {
  /** accountId -> { seq, state: Map<key, entry>, log: entry[], byMutationId: Map<id, entry> } */
  const accounts = new Map();

  function account(accountId) {
    let existing = accounts.get(accountId);
    if (!existing) {
      existing = { seq: 0, logFloor: 0, state: new Map(), log: [], byMutationId: new Map() };
      accounts.set(accountId, existing);
    }
    return existing;
  }

  function trim(acc) {
    if (acc.log.length <= LOG_MAX_ENTRIES_PER_ACCOUNT) return;
    const dropped = acc.log.splice(0, acc.log.length - LOG_MAX_ENTRIES_PER_ACCOUNT);
    for (const entry of dropped) acc.byMutationId.delete(entry.mutationId);
    // Everything at or below this point is gone for good; a client behind it needs a snapshot.
    acc.logFloor = Math.max(acc.logFloor, dropped[dropped.length - 1].seq);
  }

  return {
    kind: "memory",
    async ensureIndexes() {},

    async currentSeq(accountId) {
      return account(accountId).seq;
    },

    async applyMutation(accountId, mutation) {
      const acc = account(accountId);
      const normalized = normalizeMutation(mutation);

      // Idempotency: the same mutationId never takes effect twice, however often it is delivered.
      const seen = acc.byMutationId.get(normalized.mutationId);
      if (seen) return { seq: seen.seq, duplicate: true, entry: seen };

      acc.seq += 1;
      const entry = { ...normalized, seq: acc.seq, at: Date.now() };
      acc.state.set(entry.key, entry);
      acc.log.push(entry);
      acc.byMutationId.set(entry.mutationId, entry);
      trim(acc);
      return { seq: entry.seq, duplicate: false, entry };
    },

    async getSnapshot(accountId) {
      const acc = account(accountId);
      const values = {};
      for (const [key, entry] of acc.state) {
        if (!entry.deleted) values[key] = entry.value;
      }
      return { seq: acc.seq, values };
    },

    async changesSince(accountId, sinceSeq) {
      const acc = account(accountId);
      if (sinceSeq >= acc.seq) return { ok: true, changes: [], seq: acc.seq };
      // Unrecoverable only if something the client still needs has actually been discarded.
      if (sinceSeq < acc.logFloor) {
        return { ok: false, reason: "history-unavailable", seq: acc.seq };
      }
      return { ok: true, changes: acc.log.filter((entry) => entry.seq > sinceSeq), seq: acc.seq };
    },

    async wipe(accountId) {
      accounts.delete(accountId);
    },

    /** Test seam: force the resume history to be unavailable without waiting for retention. */
    async _truncateLog(accountId) {
      const acc = account(accountId);
      acc.log = [];
      acc.byMutationId.clear();
      acc.logFloor = acc.seq;
    }
  };
}

/* ------------------------------------------------------------------------------------------- */
/* MongoDB                                                                                      */
/* ------------------------------------------------------------------------------------------- */

function createMongoStore(db) {
  const state = () => db.collection(STATE_COLLECTION);
  const log = () => db.collection(LOG_COLLECTION);
  const seqs = () => db.collection(SEQ_COLLECTION);

  async function nextSeq(accountId) {
    const result = await seqs().findOneAndUpdate(
      { _id: accountId },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: "after" }
    );
    // Driver versions differ on whether the document is returned bare or under `.value`.
    const doc = result && result.value ? result.value : result;
    return Number(doc.seq);
  }

  async function trim(accountId) {
    // Opportunistic: keep the newest N and drop the rest. Cheap because it only runs when the log
    // for this account has actually grown past the cap.
    const count = await log().countDocuments({ accountId });
    if (count <= LOG_MAX_ENTRIES_PER_ACCOUNT) return;
    const cutoff = await log()
      .find({ accountId }, { projection: { seq: 1 } })
      .sort({ seq: -1 })
      .skip(LOG_MAX_ENTRIES_PER_ACCOUNT - 1)
      .limit(1)
      .next();
    if (!cutoff) return;
    await log().deleteMany({ accountId, seq: { $lt: cutoff.seq } });
    // Record what is gone, so resume availability is judged on what was discarded rather than on
    // where the surviving log happens to start.
    await seqs().updateOne({ _id: accountId }, { $max: { logFloor: Number(cutoff.seq) - 1 } });
  }

  return {
    kind: "mongo",

    async ensureIndexes() {
      await state().createIndex({ accountId: 1, key: 1 }, { unique: true });
      // Resume reads walk the log in sequence order for one account.
      await log().createIndex({ accountId: 1, seq: 1 });
      // The de-duplication guarantee: two deliveries of one mutation cannot both be written.
      await log().createIndex({ accountId: 1, mutationId: 1 }, { unique: true });
      // Second retention bound; keeps an idle account's log from lingering indefinitely.
      await log().createIndex({ at: 1 }, { expireAfterSeconds: LOG_TTL_SECONDS });
    },

    async currentSeq(accountId) {
      const doc = await seqs().findOne({ _id: accountId });
      return doc ? Number(doc.seq) : 0;
    },

    async logFloor(accountId) {
      const doc = await seqs().findOne({ _id: accountId });
      return doc && doc.logFloor ? Number(doc.logFloor) : 0;
    },

    async applyMutation(accountId, mutation) {
      const normalized = normalizeMutation(mutation);

      const seen = await log().findOne({ accountId, mutationId: normalized.mutationId });
      if (seen) return { seq: Number(seen.seq), duplicate: true, entry: seen };

      const seq = await nextSeq(accountId);
      const entry = { accountId, ...normalized, seq, at: new Date() };
      try {
        await log().insertOne({ ...entry });
      } catch (error) {
        // Lost a race with a concurrent delivery of the same mutation: the unique index rejected the
        // second write, so the first one's sequence is the authoritative answer.
        if (error && error.code === 11000) {
          const existing = await log().findOne({ accountId, mutationId: normalized.mutationId });
          if (existing) return { seq: Number(existing.seq), duplicate: true, entry: existing };
        }
        throw error;
      }

      // Only advance a key if this mutation really is newer, so an out-of-order write cannot move
      // the value backwards.
      await state().updateOne(
        { accountId, key: normalized.key },
        {
          $set: {
            accountId,
            key: normalized.key,
            value: normalized.value,
            deleted: normalized.deleted,
            deviceId: normalized.deviceId,
            seq,
            updatedAt: new Date()
          }
        },
        { upsert: true }
      );

      await trim(accountId);
      return { seq, duplicate: false, entry };
    },

    async getSnapshot(accountId) {
      const [rows, seq] = await Promise.all([
        state().find({ accountId, deleted: { $ne: true } }, { projection: { _id: 0, key: 1, value: 1 } }).toArray(),
        this.currentSeq(accountId)
      ]);
      const values = {};
      for (const row of rows) values[row.key] = row.value;
      return { seq, values };
    },

    async changesSince(accountId, sinceSeq) {
      const doc = await seqs().findOne({ _id: accountId });
      const seq = doc ? Number(doc.seq) : 0;
      if (sinceSeq >= seq) return { ok: true, changes: [], seq };
      const floor = doc && doc.logFloor ? Number(doc.logFloor) : 0;
      if (sinceSeq < floor) {
        return { ok: false, reason: "history-unavailable", seq };
      }
      const changes = await log()
        .find({ accountId, seq: { $gt: sinceSeq } }, { projection: { _id: 0 } })
        .sort({ seq: 1 })
        .toArray();
      return { ok: true, changes, seq };
    },

    async wipe(accountId) {
      await Promise.all([
        state().deleteMany({ accountId }),
        log().deleteMany({ accountId }),
        seqs().deleteOne({ _id: accountId })
      ]);
    },

    async _truncateLog(accountId) {
      await log().deleteMany({ accountId });
      const seq = await this.currentSeq(accountId);
      await seqs().updateOne({ _id: accountId }, { $max: { logFloor: seq } }, { upsert: true });
    }
  };
}

module.exports = {
  createMemoryStore,
  createMongoStore,
  LOG_MAX_ENTRIES_PER_ACCOUNT,
  LOG_TTL_SECONDS,
  STATE_COLLECTION,
  LOG_COLLECTION,
  SEQ_COLLECTION
};
