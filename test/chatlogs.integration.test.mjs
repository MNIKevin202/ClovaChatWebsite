import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient } from "mongodb";
import {
  appendLines,
  ensureIndexes,
  listAvailable,
  purgeAccount,
  readDay,
  MAX_LINES_PER_REQUEST
} from "../chatlogs.js";

/**
 * Cloud chat logs against a real mongod.
 *
 * The properties worth testing here are the ones that protect the disk: parts rolling over before a
 * document can hit Mongo's 16 MB ceiling, the daily quota refusing writes instead of silently
 * dropping them, and the TTL index actually existing so retention happens without a cleanup job.
 */

let mongod;
let client;
let db;
const ACCOUNT = "12345";
const DAY = "2026-09-06";

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db("chatlogs_test");
  await ensureIndexes(db);
}, 120_000);

afterAll(async () => {
  await client?.close();
  await mongod?.stop();
});

async function fresh() {
  await db.collection("chatLogs").deleteMany({});
}

describe("appending", () => {
  it("stores lines and reads them back in order", async () => {
    await fresh();
    const result = await appendLines(db, ACCOUNT, { channel: "#tomcornishh", day: DAY, lines: ["one", "two", "three"] });
    expect(result).toMatchObject({ ok: true, stored: 3 });
    expect((await readDay(db, ACCOUNT, "#tomcornishh", DAY)).lines).toEqual(["one", "two", "three"]);
  });

  it("appends across separate requests without losing or reordering anything", async () => {
    await fresh();
    await appendLines(db, ACCOUNT, { channel: "#a", day: DAY, lines: ["1", "2"] });
    await appendLines(db, ACCOUNT, { channel: "#a", day: DAY, lines: ["3"] });
    expect((await readDay(db, ACCOUNT, "#a", DAY)).lines).toEqual(["1", "2", "3"]);
  });

  it("normalises the channel so #a and a are the same log", async () => {
    await fresh();
    await appendLines(db, ACCOUNT, { channel: "#A", day: DAY, lines: ["x"] });
    await appendLines(db, ACCOUNT, { channel: "a", day: DAY, lines: ["y"] });
    expect((await readDay(db, ACCOUNT, "#a", DAY)).lines).toEqual(["x", "y"]);
  });

  it("keeps accounts separate", async () => {
    await fresh();
    await appendLines(db, ACCOUNT, { channel: "#a", day: DAY, lines: ["mine"] });
    await appendLines(db, "99999", { channel: "#a", day: DAY, lines: ["theirs"] });
    expect((await readDay(db, ACCOUNT, "#a", DAY)).lines).toEqual(["mine"]);
    expect((await readDay(db, "99999", "#a", DAY)).lines).toEqual(["theirs"]);
  });

  it("rejects a malformed day or channel rather than storing under a junk key", async () => {
    await fresh();
    expect(await appendLines(db, ACCOUNT, { channel: "#a", day: "not-a-day", lines: ["x"] })).toMatchObject({ ok: false });
    expect(await appendLines(db, ACCOUNT, { channel: "", day: DAY, lines: ["x"] })).toMatchObject({ ok: false });
    expect(await db.collection("chatLogs").countDocuments({})).toBe(0);
  });

  it("refuses an oversized batch instead of accepting part of it", async () => {
    await fresh();
    const lines = Array.from({ length: MAX_LINES_PER_REQUEST + 1 }, (_, i) => `line ${i}`);
    expect(await appendLines(db, ACCOUNT, { channel: "#a", day: DAY, lines })).toMatchObject({ ok: false, stored: 0 });
  });

  it("truncates a pathologically long line rather than storing it whole", async () => {
    await fresh();
    await appendLines(db, ACCOUNT, { channel: "#a", day: DAY, lines: ["z".repeat(50_000)] });
    const { lines } = await readDay(db, ACCOUNT, "#a", DAY);
    expect(lines[0].length).toBeLessThan(2100);
  });
});

describe("protecting the disk", () => {
  it("rolls onto a new part before a document can approach Mongo's size ceiling", async () => {
    await fresh();
    // 6000 lines with a 5000-line cap must land as two parts.
    for (let i = 0; i < 6; i += 1) {
      await appendLines(db, ACCOUNT, {
        channel: "#busy", day: DAY,
        lines: Array.from({ length: 1000 }, (_, n) => `msg ${i * 1000 + n}`)
      });
    }
    const parts = await db.collection("chatLogs").find({ accountId: ACCOUNT, channel: "#busy", day: DAY }).sort({ part: 1 }).toArray();
    expect(parts.length).toBe(2);
    expect(parts[0].lineCount).toBe(5000);
    expect(parts[1].lineCount).toBe(1000);
    // ...and reading still returns one flat, ordered list.
    const { lines } = await readDay(db, ACCOUNT, "#busy", DAY);
    expect(lines).toHaveLength(6000);
    expect(lines[0]).toBe("msg 0");
    expect(lines[5999]).toBe("msg 5999");
  }, 60_000);

  it("has a TTL index, so retention needs no cleanup job", async () => {
    const indexes = await db.collection("chatLogs").indexes();
    const ttl = indexes.find((index) => index.expireAfterSeconds !== undefined);
    expect(ttl).toBeDefined();
    expect(ttl.key).toMatchObject({ expiresAt: 1 });
  });

  it("stamps an expiry derived from the log's own day, not the write time", async () => {
    await fresh();
    await appendLines(db, ACCOUNT, { channel: "#a", day: DAY, lines: ["x"] });
    const doc = await db.collection("chatLogs").findOne({ accountId: ACCOUNT });
    // 2026-09-06 + 30 days
    expect(doc.expiresAt.toISOString().slice(0, 10)).toBe("2026-10-06");
  });
});

describe("browsing and deleting", () => {
  it("lists what is stored without downloading it", async () => {
    await fresh();
    await appendLines(db, ACCOUNT, { channel: "#a", day: DAY, lines: ["1", "2"] });
    await appendLines(db, ACCOUNT, { channel: "#b", day: "2026-09-05", lines: ["3"] });
    const available = await listAvailable(db, ACCOUNT);
    expect(available).toHaveLength(2);
    expect(available[0]).toMatchObject({ day: DAY, channel: "#a", lineCount: 2 });
    expect(available[0].lines).toBeUndefined();
  });

  it("purges one channel without touching the rest", async () => {
    await fresh();
    await appendLines(db, ACCOUNT, { channel: "#a", day: DAY, lines: ["keep"] });
    await appendLines(db, ACCOUNT, { channel: "#b", day: DAY, lines: ["drop"] });
    expect(await purgeAccount(db, ACCOUNT, "#b")).toMatchObject({ deleted: 1 });
    expect((await readDay(db, ACCOUNT, "#a", DAY)).lines).toEqual(["keep"]);
    expect((await readDay(db, ACCOUNT, "#b", DAY)).lines).toEqual([]);
  });

  it("purges an entire account when no channel is named", async () => {
    await fresh();
    await appendLines(db, ACCOUNT, { channel: "#a", day: DAY, lines: ["x"] });
    await appendLines(db, "99999", { channel: "#a", day: DAY, lines: ["other"] });
    await purgeAccount(db, ACCOUNT);
    expect(await db.collection("chatLogs").countDocuments({ accountId: ACCOUNT })).toBe(0);
    expect(await db.collection("chatLogs").countDocuments({ accountId: "99999" })).toBe(1);
  });
});
