import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient } from "mongodb";
import storeModule from "../realtime/store.js";
import harness from "./harness.js";

const { createMongoStore, LOG_MAX_ENTRIES_PER_ACCOUNT, STATE_COLLECTION, LOG_COLLECTION, SEQ_COLLECTION } = storeModule;
const { startServer, TestClient, until, settle } = harness;

/**
 * The Mongo pass.
 *
 * Everything else in this suite runs against the in-memory store, which can only *assume* the two
 * properties the whole ordering model rests on: that sequence allocation is atomic, and that the
 * unique index genuinely prevents one mutation being recorded twice. Those are database
 * behaviours, so they are verified here against a real mongod — a disposable one on a temp path,
 * never the production Quipora database.
 */

let mongod;
let client;
let db;
let store;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db("quipora_realtime_scratch");
  store = createMongoStore(db);
  await store.ensureIndexes();
  const info = await client.db("admin").command({ buildInfo: 1 });
  console.log(`  [mongo] real mongod ${info.version}, scratch database "quipora_realtime_scratch"`);
}, 120_000);

afterAll(async () => {
  if (client) await client.close();
  if (mongod) await mongod.stop();
});

const account = () => `acct-${Math.random().toString(36).slice(2, 10)}`;

describe("index creation", () => {
  it("creates exactly the indexes the design depends on", async () => {
    const logIndexes = await db.collection(LOG_COLLECTION).listIndexes().toArray();
    const stateIndexes = await db.collection(STATE_COLLECTION).listIndexes().toArray();

    const byKey = (indexes) => Object.fromEntries(indexes.map((i) => [JSON.stringify(i.key), i]));
    const log = byKey(logIndexes);
    const state = byKey(stateIndexes);

    // One key per account: the state collection cannot hold two rows for the same key.
    expect(state['{"accountId":1,"key":1}'].unique).toBe(true);
    // Resume reads walk the log in sequence order for one account.
    expect(log['{"accountId":1,"seq":1}']).toBeTruthy();
    // The de-duplication guarantee.
    expect(log['{"accountId":1,"mutationId":1}'].unique).toBe(true);
    // Second retention bound.
    expect(log['{"at":1}'].expireAfterSeconds).toBe(14 * 24 * 60 * 60);
  });

  it("is idempotent — re-running ensureIndexes changes nothing", async () => {
    const before = await db.collection(LOG_COLLECTION).listIndexes().toArray();
    await store.ensureIndexes();
    const after = await db.collection(LOG_COLLECTION).listIndexes().toArray();
    expect(after.map((i) => i.name).sort()).toEqual(before.map((i) => i.name).sort());
  });
});

describe("sequence allocation", () => {
  it("is atomic under concurrent writers", async () => {
    // The core claim: N writers racing produce N distinct sequences with no duplicates and no gaps.
    const id = account();
    const WRITERS = 40;
    const results = await Promise.all(
      Array.from({ length: WRITERS }, (_, i) =>
        store.applyMutation(id, { mutationId: `m-${i}`, key: `settings.k${i}`, value: i })
      )
    );
    const sequences = results.map((r) => r.seq).sort((a, b) => a - b);
    expect(new Set(sequences).size).toBe(WRITERS);
    expect(sequences).toEqual(Array.from({ length: WRITERS }, (_, i) => i + 1));
    expect(await store.currentSeq(id)).toBe(WRITERS);
  });

  it("never regresses, even when writers interleave with readers", async () => {
    const id = account();
    const seen = [];
    for (let round = 0; round < 5; round += 1) {
      const batch = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          store.applyMutation(id, { mutationId: `r${round}-${i}`, key: "settings.same", value: `${round}-${i}` })
        )
      );
      seen.push(...batch.map((r) => r.seq));
      const current = await store.currentSeq(id);
      expect(current).toBe(Math.max(...seen));
    }
    const sorted = [...seen].sort((a, b) => a - b);
    expect(sorted).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
  });

  it("keeps counters independent per account", async () => {
    const a = account();
    const b = account();
    await Promise.all([
      ...Array.from({ length: 10 }, (_, i) => store.applyMutation(a, { mutationId: `a${i}`, key: "settings.x", value: i })),
      ...Array.from({ length: 3 }, (_, i) => store.applyMutation(b, { mutationId: `b${i}`, key: "settings.x", value: i }))
    ]);
    expect(await store.currentSeq(a)).toBe(10);
    expect(await store.currentSeq(b)).toBe(3);
  });
});

describe("unique-index de-duplication", () => {
  it("records one entry when the same mutation is submitted twice", async () => {
    const id = account();
    const first = await store.applyMutation(id, { mutationId: "dup", key: "settings.a", value: 1 });
    const second = await store.applyMutation(id, { mutationId: "dup", key: "settings.a", value: 999 });

    expect(second.duplicate).toBe(true);
    expect(second.seq).toBe(first.seq);
    expect(await db.collection(LOG_COLLECTION).countDocuments({ accountId: id, mutationId: "dup" })).toBe(1);
    // The replayed value never took effect.
    expect((await store.getSnapshot(id)).values["settings.a"]).toBe(1);
  });

  it("collapses a concurrent storm of one mutation to a single log entry and one sequence", async () => {
    const id = account();
    const results = await Promise.all(
      Array.from({ length: 25 }, () => store.applyMutation(id, { mutationId: "storm", key: "settings.a", value: 1 }))
    );
    const sequences = new Set(results.map((r) => r.seq));
    expect(sequences.size).toBe(1);
    expect(await db.collection(LOG_COLLECTION).countDocuments({ accountId: id, mutationId: "storm" })).toBe(1);
  });

  it("enforces the constraint at the database, not just in application code", async () => {
    const id = account();
    await store.applyMutation(id, { mutationId: "guard", key: "settings.a", value: 1 });
    await expect(
      db.collection(LOG_COLLECTION).insertOne({ accountId: id, mutationId: "guard", seq: 999, key: "settings.a", at: new Date() })
    ).rejects.toMatchObject({ code: 11000 });
  });
});

describe("state persistence", () => {
  it("stores one row per key and updates it in place", async () => {
    const id = account();
    await store.applyMutation(id, { mutationId: "s1", key: "settings.chat.showTimestamps", value: true });
    await store.applyMutation(id, { mutationId: "s2", key: "settings.chat.showTimestamps", value: false });
    const rows = await db.collection(STATE_COLLECTION).find({ accountId: id }).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe(false);
    expect(rows[0].seq).toBe(2);
  });

  it("persists channel state under its canonical key", async () => {
    const id = account();
    await store.applyMutation(id, { mutationId: "c1", key: "channel.twitch:tomcornishh.loggingEnabled", value: true });
    await store.applyMutation(id, { mutationId: "c2", key: "channel.irc:libera/quipora.favorite", value: true });
    const snapshot = await store.getSnapshot(id);
    expect(snapshot.values["channel.twitch:tomcornishh.loggingEnabled"]).toBe(true);
    expect(snapshot.values["channel.irc:libera/quipora.favorite"]).toBe(true);
    const stored = await db.collection(STATE_COLLECTION).findOne({ accountId: id, key: "channel.twitch:tomcornishh.loggingEnabled" });
    expect(stored.value).toBe(true);
  });

  it("survives a client reconnect because the state is in the database, not the socket", async () => {
    const id = account();
    await store.applyMutation(id, { mutationId: "p1", key: "settings.a", value: "persisted" });
    // A brand-new store object over the same database — as a redeployed container would be.
    const freshStore = createMongoStore(db);
    expect((await freshStore.getSnapshot(id)).values["settings.a"]).toBe("persisted");
    expect(await freshStore.currentSeq(id)).toBe(1);
  });
});

describe("resume and retention", () => {
  it("resumes from a sequence", async () => {
    const id = account();
    for (let i = 1; i <= 6; i += 1) {
      await store.applyMutation(id, { mutationId: `h${i}`, key: `settings.k${i}`, value: i });
    }
    const history = await store.changesSince(id, 3);
    expect(history.ok).toBe(true);
    expect(history.changes.map((c) => c.seq)).toEqual([4, 5, 6]);
  });

  it("bounds the log and falls back to a snapshot once history is gone", async () => {
    const id = account();
    const total = LOG_MAX_ENTRIES_PER_ACCOUNT + 30;
    for (let i = 1; i <= total; i += 1) {
      await store.applyMutation(id, { mutationId: `b${i}`, key: "settings.counter", value: i });
    }
    const count = await db.collection(LOG_COLLECTION).countDocuments({ accountId: id });
    expect(count).toBeLessThanOrEqual(LOG_MAX_ENTRIES_PER_ACCOUNT);

    const stale = await store.changesSince(id, 1);
    expect(stale.ok).toBe(false);
    expect(stale.reason).toBe("history-unavailable");

    // The snapshot is always correct, which is what makes the fallback safe.
    expect((await store.getSnapshot(id)).values["settings.counter"]).toBe(total);
    const recent = await store.changesSince(id, total - 3);
    expect(recent.ok).toBe(true);
    expect(recent.changes.map((c) => c.seq)).toEqual([total - 2, total - 1, total]);
  }, 120_000);
});

describe("account isolation", () => {
  it("never returns another account's state, history or sequence", async () => {
    const mine = account();
    const theirs = account();
    await store.applyMutation(mine, { mutationId: "m1", key: "settings.secretish", value: "mine" });
    await store.applyMutation(theirs, { mutationId: "t1", key: "settings.secretish", value: "theirs" });

    expect((await store.getSnapshot(mine)).values["settings.secretish"]).toBe("mine");
    const history = await store.changesSince(mine, 0);
    expect(history.changes.every((c) => c.accountId === mine)).toBe(true);
    expect(history.changes.map((c) => c.value)).toEqual(["mine"]);
  });

  it("wipes only the targeted account", async () => {
    const mine = account();
    const theirs = account();
    await store.applyMutation(mine, { mutationId: "w1", key: "settings.a", value: 1 });
    await store.applyMutation(theirs, { mutationId: "w2", key: "settings.a", value: 2 });
    await store.wipe(mine);

    expect(await store.currentSeq(mine)).toBe(0);
    expect((await store.getSnapshot(theirs)).values["settings.a"]).toBe(2);
    expect(await db.collection(LOG_COLLECTION).countDocuments({ accountId: theirs })).toBe(1);
    expect(await db.collection(SEQ_COLLECTION).countDocuments({ _id: theirs })).toBe(1);
  });
});

describe("end to end: real clients, real server, real MongoDB", () => {
  let server;
  const clients = [];

  const connect = async (options) => {
    const c = new TestClient(server.url, options);
    clients.push(c);
    await c.connect();
    return c;
  };

  beforeEach(async () => {
    server = await startServer({ store });
  });

  afterAll(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close()));
    if (server) await server.close();
  });

  it("propagates a change between two clients through MongoDB", async () => {
    const a = await connect({ deviceId: "A" });
    const b = await connect({ deviceId: "B" });
    await a.hello();
    await b.hello();
    await a.mutate("settings.chat.showTimestamps", true);
    await b.waitFor((m) => m.type === "delta" && m.key === "settings.chat.showTimestamps");

    expect(b.applied.get("settings.chat.showTimestamps")).toBe(true);
    const persisted = await db.collection(STATE_COLLECTION).findOne({ accountId: "account-1", key: "settings.chat.showTimestamps" });
    expect(persisted.value).toBe(true);
    await Promise.all(clients.splice(0).map((c) => c.close()));
    await server.close();
    server = null;
  });

  it("gives concurrent writes to the same key one order that every client agrees on", async () => {
    await store.wipe("account-1");
    server = await startServer({ store });
    const a = await connect({ deviceId: "A" });
    const b = await connect({ deviceId: "B" });
    const c = await connect({ deviceId: "C" });
    await a.hello();
    await b.hello();
    await c.hello();

    a.mutateNoWait("settings.contended", "A");
    b.mutateNoWait("settings.contended", "B");
    c.mutateNoWait("settings.contended", "C");
    await until(async () => [a, b, c].every((client_) => client_.lastSeq === 3));
    await settle(80);

    const winner = (await store.getSnapshot("account-1")).values["settings.contended"];
    for (const client_ of [a, b, c]) {
      expect(client_.applied.get("settings.contended"), client_.deviceId).toBe(winner);
      expect(client_.lastSeq).toBe(3);
    }
    // No duplicate authoritative events: three mutations, three log entries, three deltas each.
    expect(await db.collection(LOG_COLLECTION).countDocuments({ accountId: "account-1" })).toBe(3);
    for (const client_ of [a, b, c]) expect(client_.deltas).toHaveLength(3);
    await Promise.all(clients.splice(0).map((c) => c.close()));
    await server.close();
    server = null;
  });

  it("keeps concurrent writes to different keys all of them", async () => {
    await store.wipe("account-1");
    server = await startServer({ store });
    const a = await connect({ deviceId: "A" });
    const b = await connect({ deviceId: "B" });
    await a.hello();
    await b.hello();

    await Promise.all([
      a.mutate("settings.chat.showTimestamps", true),
      b.mutate("settings.appearance.chatFontSize", 18),
      a.mutate("channel.twitch:tomcornishh.favorite", true)
    ]);
    await until(async () => [a, b].every((client_) => client_.lastSeq === 3));
    await settle(80);

    const values = (await store.getSnapshot("account-1")).values;
    expect(values["settings.chat.showTimestamps"]).toBe(true);
    expect(values["settings.appearance.chatFontSize"]).toBe(18);
    expect(values["channel.twitch:tomcornishh.favorite"]).toBe(true);
    // ...and every CLIENT holds all three, not just the database. An out-of-order fan-out would
    // leave a client silently missing one of these while the database looked perfect.
    for (const client_ of [a, b]) {
      expect(client_.applied.get("settings.chat.showTimestamps"), client_.deviceId).toBe(true);
      expect(client_.applied.get("settings.appearance.chatFontSize"), client_.deviceId).toBe(18);
      expect(client_.applied.get("channel.twitch:tomcornishh.favorite"), client_.deviceId).toBe(true);
    }
    await Promise.all(clients.splice(0).map((c) => c.close()));
    await server.close();
    server = null;
  });

  it("reconnects after a backend restart and resumes from the database", async () => {
    await store.wipe("account-1");
    server = await startServer({ store });
    const a = await connect({ deviceId: "A" });
    await a.hello();
    await a.mutate("settings.survives", "yes");
    const seqBefore = a.lastSeq;

    // The process goes away; MongoDB does not — exactly what a redeploy looks like.
    await server.close();
    server = await startServer({ store });

    const back = await connect({ deviceId: "A", lastSeq: seqBefore });
    const ready = await back.hello();
    expect(ready.mode).toBe("resume");
    expect(ready.seq).toBe(seqBefore);
    await back.mutate("settings.afterRestart", true);
    expect((await store.getSnapshot("account-1")).values["settings.survives"]).toBe("yes");
    expect((await store.getSnapshot("account-1")).values["settings.afterRestart"]).toBe(true);
    await Promise.all(clients.splice(0).map((c) => c.close()));
    await server.close();
    server = null;
  });

  it("does not leak across accounts over live sockets", async () => {
    await store.wipe("account-1");
    await store.wipe("account-2");
    server = await startServer({ store });
    const mine = await connect({ deviceId: "mine" });
    const theirs = await connect({ deviceId: "theirs", token: harness.OTHER_TOKEN });
    await mine.hello();
    await theirs.hello();

    await mine.mutate("settings.private", "mine");
    await settle(120);

    expect(theirs.deltas).toHaveLength(0);
    expect(theirs.applied.size).toBe(0);
    expect((await store.getSnapshot("account-2")).values).toEqual({});
    await Promise.all(clients.splice(0).map((c) => c.close()));
    await server.close();
    server = null;
  });
});

describe("database consistency after the run", () => {
  it("passes a full validate on every realtime collection", async () => {
    for (const collection of [STATE_COLLECTION, LOG_COLLECTION, SEQ_COLLECTION]) {
      const result = await db.command({ validate: collection, full: true });
      console.log(`  [mongo] validate ${collection}: valid=${result.valid} errors=${(result.errors || []).length} warnings=${(result.warnings || []).length}`);
      expect(result.valid, `${collection} failed validation`).toBe(true);
      expect(result.errors || []).toEqual([]);
    }
  });

  it("holds no duplicate keys in state and no duplicate mutation ids in the log", async () => {
    const dupState = await db.collection(STATE_COLLECTION).aggregate([
      { $group: { _id: { accountId: "$accountId", key: "$key" }, n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } }
    ]).toArray();
    expect(dupState).toEqual([]);

    const dupLog = await db.collection(LOG_COLLECTION).aggregate([
      { $group: { _id: { accountId: "$accountId", mutationId: "$mutationId" }, n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } }
    ]).toArray();
    expect(dupLog).toEqual([]);
  });

  it("holds no duplicate sequence numbers within any account", async () => {
    const dupSeq = await db.collection(LOG_COLLECTION).aggregate([
      { $group: { _id: { accountId: "$accountId", seq: "$seq" }, n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } }
    ]).toArray();
    expect(dupSeq).toEqual([]);
  });

  it("never records a log entry above its account's counter", async () => {
    // A sequence regression would show up here as a log entry the counter does not cover.
    const counters = Object.fromEntries(
      (await db.collection(SEQ_COLLECTION).find({}).toArray()).map((d) => [d._id, d.seq])
    );
    const overflowing = await db.collection(LOG_COLLECTION).aggregate([
      { $group: { _id: "$accountId", maxSeq: { $max: "$seq" } } }
    ]).toArray();
    for (const row of overflowing) {
      expect(row.maxSeq, `account ${row._id}`).toBeLessThanOrEqual(counters[row._id]);
    }
  });
});

describe("fan-out stays in sequence order under load", () => {
  it("delivers every key to every client when many writes race", async () => {
    // Without per-account serialisation the server awaits the database per mutation and can emit
    // deltas out of order. Clients treat the sequence as a high-water mark, so an out-of-order
    // delta is not merely late — it is discarded, and a change to a *different* key vanishes on
    // that client while the database still looks perfect. This is the regression guard for that.
    await store.wipe("account-1");
    const server_ = await startServer({ store });
    const a = new TestClient(server_.url, { deviceId: "A" });
    const b = new TestClient(server_.url, { deviceId: "B" });
    await a.connect();
    await b.connect();
    await a.hello();
    await b.hello();

    const KEYS = 24;
    for (let i = 0; i < KEYS; i += 1) {
      const writer = i % 2 === 0 ? a : b;
      writer.mutateNoWait(`settings.k${i}`, i);
    }

    await until(async () => a.lastSeq === KEYS && b.lastSeq === KEYS, 8000);
    await settle(120);

    for (const client_ of [a, b]) {
      for (let i = 0; i < KEYS; i += 1) {
        expect(client_.applied.get(`settings.k${i}`), `${client_.deviceId} missing settings.k${i}`).toBe(i);
      }
      // Every delta arrived in ascending sequence order.
      const sequences = client_.deltas.map((d) => d.seq);
      expect(sequences).toEqual([...sequences].sort((x, y) => x - y));
    }

    const snapshot = await store.getSnapshot("account-1");
    expect(Object.keys(snapshot.values)).toHaveLength(KEYS);

    await a.close();
    await b.close();
    await server_.close();
  }, 30_000);
});
