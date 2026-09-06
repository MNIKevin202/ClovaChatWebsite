"use strict";

/**
 * Cloud chat logs.
 *
 * Chat is high-volume — a single active profile can hold hundreds of thousands of messages — so
 * this is built around the constraint that storage is finite and paid for, not as an afterthought:
 *
 * - **Day-batched documents**, not one per message. A document is `(accountId, channel, day, part)`
 *   holding an array of lines, which mirrors the desktop logger's daily rotation, keeps the index
 *   small, and makes retention a matter of dropping whole days.
 * - **Parts**, because MongoDB documents cap at 16 MB. A busy channel rolls onto part 2 rather than
 *   failing the write at midnight on a raid.
 * - **A TTL index** so old logs expire without anyone running a cleanup job.
 * - **Per-request and per-day caps** so a buggy or hostile client cannot fill the disk.
 *
 * Deliberately NOT routed through the realtime socket: that carries per-key settings deltas under a
 * 200-mutations/10s flood guard, and a chat firehose would either trip it constantly or force the
 * guard open for everything else.
 */

const RETENTION_DAYS = 30;
const MAX_LINES_PER_DOC = 5000;
const MAX_LINES_PER_REQUEST = 1000;
const MAX_LINE_LENGTH = 2000;
/** A hard ceiling per account per day, across every channel. Beyond this, writes are refused. */
const MAX_LINES_PER_ACCOUNT_DAY = 200_000;

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

async function ensureIndexes(db) {
  const logs = db.collection("chatLogs");
  await logs.createIndex({ accountId: 1, channel: 1, day: -1, part: -1 });
  await logs.createIndex({ accountId: 1, day: -1 });
  // Mongo drops the document once expiresAt passes; retention needs no scheduled job.
  await logs.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
}

function normalizeChannel(value) {
  const channel = String(value || "").trim().toLowerCase();
  if (!channel || channel.length > 100) return "";
  return channel.startsWith("#") ? channel : `#${channel}`;
}

function expiryFor(day) {
  const base = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(base)) return new Date(Date.now() + RETENTION_DAYS * 86_400_000);
  return new Date(base + RETENTION_DAYS * 86_400_000);
}

/**
 * Appends a batch to one channel-day.
 *
 * Returns `{ ok, stored, reason }`. A refusal is not an error: the client is told how many lines
 * landed so it can keep the remainder locally rather than silently dropping them.
 */
async function appendLines(db, accountId, { channel, day, lines }) {
  const normalized = normalizeChannel(channel);
  if (!normalized) return { ok: false, stored: 0, reason: "Invalid channel." };
  if (!DAY_PATTERN.test(String(day || ""))) return { ok: false, stored: 0, reason: "Invalid day." };
  if (!Array.isArray(lines) || lines.length === 0) return { ok: true, stored: 0 };
  if (lines.length > MAX_LINES_PER_REQUEST) return { ok: false, stored: 0, reason: "Too many lines in one request." };

  const clean = lines
    .filter((line) => typeof line === "string" && line.length > 0)
    .map((line) => (line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line));
  if (clean.length === 0) return { ok: true, stored: 0 };

  const logs = db.collection("chatLogs");

  // Daily quota across every channel, so one runaway channel cannot consume the whole account.
  const dayTotal = await logs
    .aggregate([
      { $match: { accountId, day } },
      { $group: { _id: null, total: { $sum: "$lineCount" } } }
    ])
    .toArray();
  const used = dayTotal[0]?.total ?? 0;
  if (used >= MAX_LINES_PER_ACCOUNT_DAY) {
    return { ok: false, stored: 0, reason: "Daily cloud log limit reached for this account." };
  }
  const allowed = clean.slice(0, MAX_LINES_PER_ACCOUNT_DAY - used);

  const latest = await logs.findOne({ accountId, channel: normalized, day }, { sort: { part: -1 } });
  let part = latest?.part ?? 0;
  let room = latest ? MAX_LINES_PER_DOC - (latest.lineCount ?? 0) : MAX_LINES_PER_DOC;

  let stored = 0;
  let remaining = allowed;
  while (remaining.length > 0) {
    if (room <= 0) {
      part += 1;
      room = MAX_LINES_PER_DOC;
    }
    const chunk = remaining.slice(0, room);
    remaining = remaining.slice(chunk.length);
    await logs.updateOne(
      { accountId, channel: normalized, day, part },
      {
        $push: { lines: { $each: chunk } },
        $inc: { lineCount: chunk.length },
        $set: { updatedAt: Date.now(), expiresAt: expiryFor(day) },
        $setOnInsert: { accountId, channel: normalized, day, part }
      },
      { upsert: true }
    );
    stored += chunk.length;
    room -= chunk.length;
  }

  return { ok: true, stored, dropped: clean.length - stored };
}

/** All parts of one channel-day, in order, flattened back into a single line list. */
async function readDay(db, accountId, channel, day) {
  const normalized = normalizeChannel(channel);
  if (!normalized || !DAY_PATTERN.test(String(day || ""))) return { lines: [] };
  const docs = await db
    .collection("chatLogs")
    .find({ accountId, channel: normalized, day }, { projection: { _id: 0, lines: 1, part: 1 } })
    .sort({ part: 1 })
    .toArray();
  return { lines: docs.flatMap((doc) => doc.lines || []) };
}

/** What this account has stored, so a client can show a browsable index without downloading it. */
async function listAvailable(db, accountId, { channel, limit = 90 } = {}) {
  const match = { accountId };
  const normalized = channel ? normalizeChannel(channel) : "";
  if (normalized) match.channel = normalized;
  return db
    .collection("chatLogs")
    .aggregate([
      { $match: match },
      { $group: { _id: { channel: "$channel", day: "$day" }, lineCount: { $sum: "$lineCount" }, updatedAt: { $max: "$updatedAt" } } },
      { $sort: { "_id.day": -1, "_id.channel": 1 } },
      { $limit: Math.min(Number(limit) || 90, 500) },
      { $project: { _id: 0, channel: "$_id.channel", day: "$_id.day", lineCount: 1, updatedAt: 1 } }
    ])
    .toArray();
}

async function purgeAccount(db, accountId, channel) {
  const filter = { accountId };
  const normalized = channel ? normalizeChannel(channel) : "";
  if (normalized) filter.channel = normalized;
  const result = await db.collection("chatLogs").deleteMany(filter);
  return { deleted: result.deletedCount || 0 };
}

module.exports = {
  ensureIndexes,
  appendLines,
  readDay,
  listAvailable,
  purgeAccount,
  RETENTION_DAYS,
  MAX_LINES_PER_REQUEST,
  MAX_LINES_PER_ACCOUNT_DAY,
  normalizeChannel
};
