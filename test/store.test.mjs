import { describe, expect, it } from "vitest";
import storeModule from "../realtime/store.js";

const { createMemoryStore, createMongoStore, LOG_MAX_ENTRIES_PER_ACCOUNT } = storeModule;

/**
 * The same suite runs against every store implementation.
 *
 * The Mongo pass is what proves the two properties the in-memory version can only assume: that
 * sequence allocation is atomic, and that the unique index really does stop one mutation being
 * recorded twice. It is skipped unless a database is provided, so the suite stays runnable offline.
 */
const MONGO_URI = process.env.REALTIME_TEST_MONGODB_URI;

function suite(name, makeStore, teardown = async () => {}) {
  describe(name, () => {
    const account = () => `acct-${Math.random().toString(36).slice(2, 10)}`;

    it("assigns sequence numbers starting at 1 and increasing by one", async () => {
      const store = await makeStore();
      const id = account();
      const first = await store.applyMutation(id, { mutationId: "m1", key: "settings.a", value: 1 });
      const second = await store.applyMutation(id, { mutationId: "m2", key: "settings.b", value: 2 });
      expect(first.seq).toBe(1);
      expect(second.seq).toBe(2);
      expect(await store.currentSeq(id)).toBe(2);
      await teardown(store, id);
    });

    it("keeps sequences separate per account", async () => {
      const store = await makeStore();
      const one = account();
      const two = account();
      await store.applyMutation(one, { mutationId: "m1", key: "settings.a", value: 1 });
      await store.applyMutation(one, { mutationId: "m2", key: "settings.a", value: 2 });
      const other = await store.applyMutation(two, { mutationId: "m3", key: "settings.a", value: 3 });
      expect(other.seq).toBe(1);
      expect(await store.currentSeq(one)).toBe(2);
      await teardown(store, one);
      await teardown(store, two);
    });

    it("records a repeated mutationId once and reports the original sequence", async () => {
      const store = await makeStore();
      const id = account();
      const first = await store.applyMutation(id, { mutationId: "same", key: "settings.a", value: 1 });
      const again = await store.applyMutation(id, { mutationId: "same", key: "settings.a", value: 999 });
      expect(again.duplicate).toBe(true);
      expect(again.seq).toBe(first.seq);
      expect(await store.currentSeq(id)).toBe(1);
      // The replayed value was ignored, not applied.
      expect((await store.getSnapshot(id)).values["settings.a"]).toBe(1);
      await teardown(store, id);
    });

    it("de-duplicates concurrent deliveries of one mutation", async () => {
      const store = await makeStore();
      const id = account();
      const results = await Promise.all(
        Array.from({ length: 5 }, () => store.applyMutation(id, { mutationId: "racy", key: "settings.a", value: 1 }))
      );
      const sequences = new Set(results.map((r) => r.seq));
      expect(sequences.size).toBe(1);
      expect(await store.currentSeq(id)).toBe(1);
      await teardown(store, id);
    });

    it("builds a snapshot of current values", async () => {
      const store = await makeStore();
      const id = account();
      await store.applyMutation(id, { mutationId: "m1", key: "settings.a", value: 1 });
      await store.applyMutation(id, { mutationId: "m2", key: "settings.a", value: 2 });
      await store.applyMutation(id, { mutationId: "m3", key: "settings.b", value: "x" });
      const snapshot = await store.getSnapshot(id);
      expect(snapshot.seq).toBe(3);
      expect(snapshot.values).toEqual({ "settings.a": 2, "settings.b": "x" });
      await teardown(store, id);
    });

    it("omits deleted keys from a snapshot but reports the deletion in history", async () => {
      const store = await makeStore();
      const id = account();
      await store.applyMutation(id, { mutationId: "m1", key: "settings.a", value: 1 });
      await store.applyMutation(id, { mutationId: "m2", key: "settings.a", deleted: true });
      const snapshot = await store.getSnapshot(id);
      expect(snapshot.values).toEqual({});
      const history = await store.changesSince(id, 0);
      expect(history.ok).toBe(true);
      expect(history.changes[1].deleted).toBe(true);
      await teardown(store, id);
    });

    it("returns nothing to do when the client is already current", async () => {
      const store = await makeStore();
      const id = account();
      await store.applyMutation(id, { mutationId: "m1", key: "settings.a", value: 1 });
      const history = await store.changesSince(id, 1);
      expect(history.ok).toBe(true);
      expect(history.changes).toEqual([]);
      await teardown(store, id);
    });

    it("returns only the changes after the client's sequence, in order", async () => {
      const store = await makeStore();
      const id = account();
      for (let i = 1; i <= 5; i += 1) {
        await store.applyMutation(id, { mutationId: `m${i}`, key: `settings.k${i}`, value: i });
      }
      const history = await store.changesSince(id, 2);
      expect(history.ok).toBe(true);
      expect(history.changes.map((c) => c.seq)).toEqual([3, 4, 5]);
      await teardown(store, id);
    });

    it("reports history unavailable when the log no longer reaches back far enough", async () => {
      const store = await makeStore();
      const id = account();
      await store.applyMutation(id, { mutationId: "m1", key: "settings.a", value: 1 });
      await store.applyMutation(id, { mutationId: "m2", key: "settings.b", value: 2 });
      await store._truncateLog(id);
      const history = await store.changesSince(id, 0);
      expect(history.ok).toBe(false);
      expect(history.reason).toBe("history-unavailable");
      // The sequence is still reported so the client knows where the snapshot it takes will land.
      expect(history.seq).toBe(2);
      await teardown(store, id);
    });

    it("still resumes a client that is already current even with no history", async () => {
      // Nothing to replay means nothing to miss, so an empty log is not a failure here.
      const store = await makeStore();
      const id = account();
      await store.applyMutation(id, { mutationId: "m1", key: "settings.a", value: 1 });
      await store._truncateLog(id);
      const history = await store.changesSince(id, 1);
      expect(history.ok).toBe(true);
      expect(history.changes).toEqual([]);
      await teardown(store, id);
    });

    it("bounds the log, and says so rather than silently serving a gap", async () => {
      const store = await makeStore();
      const id = account();
      const total = LOG_MAX_ENTRIES_PER_ACCOUNT + 25;
      for (let i = 1; i <= total; i += 1) {
        await store.applyMutation(id, { mutationId: `m${i}`, key: "settings.a", value: i });
      }
      // A client from before the retention window cannot be resumed...
      const stale = await store.changesSince(id, 1);
      expect(stale.ok).toBe(false);
      // ...but a recent one still can, and the snapshot is always correct.
      const recent = await store.changesSince(id, total - 5);
      expect(recent.ok).toBe(true);
      expect(recent.changes).toHaveLength(5);
      expect((await store.getSnapshot(id)).values["settings.a"]).toBe(total);
      await teardown(store, id);
    }, 30_000);

    it("wipes an account completely", async () => {
      const store = await makeStore();
      const id = account();
      await store.applyMutation(id, { mutationId: "m1", key: "settings.a", value: 1 });
      await store.wipe(id);
      expect(await store.currentSeq(id)).toBe(0);
      expect((await store.getSnapshot(id)).values).toEqual({});
      await teardown(store, id);
    });
  });
}

suite("memory store", async () => createMemoryStore());

if (MONGO_URI) {
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(process.env.REALTIME_TEST_MONGODB_DB || "quipora_realtime_test");
  const store = createMongoStore(db);
  await store.ensureIndexes();
  suite("mongo store", async () => store, async (s, id) => s.wipe(id));
} else {
  describe.skip("mongo store (set REALTIME_TEST_MONGODB_URI to run)", () => {
    it("skipped", () => {});
  });
}
