import { afterEach, beforeEach, describe, expect, it } from "vitest";
import harness from "./harness.js";

const { startServer, TestClient, until, settle, OTHER_TOKEN } = harness;

let server;
const clients = [];

async function client(options) {
  const c = new TestClient(server.url, options);
  clients.push(c);
  await c.connect();
  return c;
}

beforeEach(async () => {
  server = await startServer();
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await server.close();
});

describe("delta propagation", () => {
  it("delivers a key change from A to B", async () => {
    const a = await client({ deviceId: "A" });
    const b = await client({ deviceId: "B" });
    await a.hello();
    await b.hello();

    await a.mutate("settings.chat.showTimestamps", true);
    await b.waitFor((m) => m.type === "delta" && m.key === "settings.chat.showTimestamps");

    expect(b.applied.get("settings.chat.showTimestamps")).toBe(true);
  });

  it("echoes a change back to its originator as authoritative confirmation", async () => {
    // The originator applied it optimistically with no sequence yet; the echo is what gives that
    // value its place in the order. Applying it cannot loop — applying a delta never emits.
    const a = await client({ deviceId: "A" });
    await a.hello();
    await a.mutate("settings.chat.showTimestamps", true);
    await a.waitFor((m) => m.type === "delta" && m.key === "settings.chat.showTimestamps");
    await settle();

    expect(a.deltas).toHaveLength(1);
    expect(a.deltas[0].deviceId).toBe("A");
    expect(a.applied.get("settings.chat.showTimestamps")).toBe(true);
    expect(a.lastSeq).toBe(1);
    // Exactly one mutation reached the server; the echo produced no second one.
    expect(await server.store.currentSeq("account-1")).toBe(1);
  });

  it("keeps unrelated concurrent changes from clobbering each other", async () => {
    const a = await client({ deviceId: "A" });
    const b = await client({ deviceId: "B" });
    await a.hello();
    await b.hello();

    await Promise.all([
      a.mutate("settings.chat.showTimestamps", true),
      b.mutate("settings.appearance.chatFontSize", 18)
    ]);
    await until(async () => a.applied.size === 2 && b.applied.size === 2);

    for (const c of [a, b]) {
      expect(c.applied.get("settings.chat.showTimestamps")).toBe(true);
      expect(c.applied.get("settings.appearance.chatFontSize")).toBe(18);
    }
    const snapshot = await server.store.getSnapshot("account-1");
    expect(snapshot.values["settings.chat.showTimestamps"]).toBe(true);
    expect(snapshot.values["settings.appearance.chatFontSize"]).toBe(18);
  });

  it("gives simultaneous writes to one key a single deterministic order", async () => {
    const a = await client({ deviceId: "A" });
    const b = await client({ deviceId: "B" });
    await a.hello();
    await b.hello();

    a.mutateNoWait("settings.chat.usernameFormat", "from-A");
    b.mutateNoWait("settings.chat.usernameFormat", "from-B");
    await until(async () => (await server.store.currentSeq("account-1")) === 2);
    await settle();

    // Whichever the server sequenced last is the value; both clients agree, and it matches storage.
    const snapshot = await server.store.getSnapshot("account-1");
    const winner = snapshot.values["settings.chat.usernameFormat"];
    expect(["from-A", "from-B"]).toContain(winner);
    await until(async () =>
      a.applied.get("settings.chat.usernameFormat") === winner &&
      b.applied.get("settings.chat.usernameFormat") === winner
    );
    expect(a.lastSeq).toBe(2);
    expect(b.lastSeq).toBe(2);
  });
});

describe("ordering and idempotency", () => {
  it("assigns monotonically increasing sequence numbers", async () => {
    const a = await client({ deviceId: "A" });
    await a.hello();
    const first = await a.mutate("settings.chat.showTimestamps", true);
    const second = await a.mutate("settings.chat.showTimestamps", false);
    expect(second.seq).toBe(first.seq + 1);
  });

  it("treats a redelivered mutation as a duplicate and emits no second delta", async () => {
    const a = await client({ deviceId: "A" });
    const b = await client({ deviceId: "B" });
    await a.hello();
    await b.hello();

    const first = await a.mutate("settings.chat.showTimestamps", true, { mutationId: "fixed-id" });
    await b.waitFor((m) => m.type === "delta");
    const replay = await a.mutate("settings.chat.showTimestamps", true, { mutationId: "fixed-id" });
    await settle();

    expect(replay.duplicate).toBe(true);
    expect(replay.seq).toBe(first.seq);
    expect(b.deltas).toHaveLength(1);
    expect(await server.store.currentSeq("account-1")).toBe(1);
  });

  it("ignores an authoritative change it has already applied", async () => {
    const a = await client({ deviceId: "A" });
    await a.hello();
    await a.mutate("settings.chat.showTimestamps", true);

    // Reconnect asking for everything from the beginning: the server replays, the client must not
    // double-apply.
    await a.close();
    const again = await client({ deviceId: "A", lastSeq: 0 });
    const ready = await again.hello();
    expect(ready.mode).toBe("resume");
    expect(again.applied.get("settings.chat.showTimestamps")).toBe(true);
    expect(again.lastSeq).toBe(1);
  });

  it("rejects an unknown key namespace instead of storing it", async () => {
    const a = await client({ deviceId: "A" });
    await a.hello();
    await expect(a.mutate("evil.arbitrary.path", 1)).rejects.toThrow(/key-namespace-unknown/);
    expect(await server.store.currentSeq("account-1")).toBe(0);
  });

  it("rejects an unknown per-channel field", async () => {
    const a = await client({ deviceId: "A" });
    await a.hello();
    await expect(a.mutate("channel.twitch:foo.notAField", true)).rejects.toThrow(/channel-field-unknown/);
  });

  it("refuses mutations sent before the client has converged", async () => {
    const a = await client({ deviceId: "A" });
    await expect(a.mutate("settings.chat.showTimestamps", true)).rejects.toThrow(/not-ready/);
  });
});

describe("reconnect and resume", () => {
  it("resumes from the last applied sequence", async () => {
    const a = await client({ deviceId: "A" });
    const b = await client({ deviceId: "B" });
    await a.hello();
    await b.hello();
    await a.mutate("settings.chat.showTimestamps", true);
    await b.waitFor((m) => m.type === "delta");

    await b.close();
    await a.mutate("settings.appearance.chatFontSize", 20);
    await a.mutate("settings.chat.usernameFormat", "display");

    const backAgain = await client({ deviceId: "B", lastSeq: b.lastSeq });
    const ready = await backAgain.hello();

    expect(ready.mode).toBe("resume");
    expect(ready.changes).toHaveLength(2);
    expect(backAgain.applied.get("settings.appearance.chatFontSize")).toBe(20);
    expect(backAgain.lastSeq).toBe(3);
  });

  it("falls back to a snapshot when the history no longer reaches back far enough", async () => {
    const a = await client({ deviceId: "A" });
    await a.hello();
    await a.mutate("settings.chat.showTimestamps", true);
    await a.mutate("settings.appearance.chatFontSize", 20);

    // Retention has discarded the entries this client would need.
    await server.store._truncateLog("account-1");

    const b = await client({ deviceId: "B", lastSeq: 0 });
    const ready = await b.hello();

    expect(ready.mode).toBe("snapshot");
    expect(ready.reason).toBe("history-unavailable");
    expect(b.applied.get("settings.chat.showTimestamps")).toBe(true);
    expect(b.applied.get("settings.appearance.chatFontSize")).toBe(20);
    expect(b.lastSeq).toBe(2);
  });

  it("survives a backend restart without the client needing to be restarted", async () => {
    const a = await client({ deviceId: "A" });
    await a.hello();
    await a.mutate("settings.chat.showTimestamps", true);

    // The store outlives the process, exactly as MongoDB does across a redeploy.
    const survivingStore = server.store;
    await server.close();
    server = await startServer({ store: survivingStore });

    const reconnected = await client({ deviceId: "A", lastSeq: a.lastSeq });
    const ready = await reconnected.hello();
    expect(ready.mode).toBe("resume");
    expect(ready.seq).toBe(1);
    await reconnected.mutate("settings.appearance.chatFontSize", 16);
    expect((await survivingStore.getSnapshot("account-1")).values["settings.appearance.chatFontSize"]).toBe(16);
  });
});

describe("a client that has been offline for a long time", () => {
  it("converges to server state instead of overwriting it", async () => {
    // A: makes a change while B is away. B: has an old local document and nothing to say about it.
    const a = await client({ deviceId: "A" });
    await a.hello();
    await a.mutate("settings.chat.showTimestamps", true);
    await a.mutate("settings.appearance.chatFontSize", 22);
    await server.store._truncateLog("account-1");

    const stale = await client({ deviceId: "B", lastSeq: 0 });
    const ready = await stale.hello();
    await settle();

    expect(ready.mode).toBe("snapshot");
    // Being stale generated no mutations at all: the sequence is untouched.
    expect(await server.store.currentSeq("account-1")).toBe(2);
    expect(stale.applied.get("settings.appearance.chatFontSize")).toBe(22);
    // ...and A's value was never clobbered.
    expect((await server.store.getSnapshot("account-1")).values["settings.chat.showTimestamps"]).toBe(true);
  });
});

describe("presence", () => {
  it("reports connected devices and their joined channels", async () => {
    const a = await client({ deviceId: "laptop" });
    const b = await client({ deviceId: "desktop" });
    await a.hello({ joined: ["twitch:tomcornishh"] });
    await b.hello({ joined: ["twitch:tomcornishh", "twitch:silky"] });
    await settle();

    const roster = server.presence.roster("account-1");
    expect(roster.map((d) => d.deviceId).sort()).toEqual(["desktop", "laptop"]);
    expect(roster.find((d) => d.deviceId === "desktop").joined).toEqual(["twitch:silky", "twitch:tomcornishh"]);
  });

  it("distinguishes 'joined right now' from the autoJoin preference", async () => {
    const a = await client({ deviceId: "laptop" });
    await a.hello({ joined: [] });
    await a.mutate("channel.twitch:tomcornishh.autoJoin", true);
    await settle();

    // The preference is set; the device is still not in the channel.
    expect((await server.store.getSnapshot("account-1")).values["channel.twitch:tomcornishh.autoJoin"]).toBe(true);
    expect(server.presence.joinedTo("account-1", "twitch:tomcornishh")).toHaveLength(0);
  });

  it("removes a device from the roster when it disconnects", async () => {
    const a = await client({ deviceId: "laptop" });
    const b = await client({ deviceId: "desktop" });
    await a.hello();
    await b.hello();
    await settle();
    expect(server.presence.roster("account-1")).toHaveLength(2);

    await b.close();
    await until(async () => server.presence.roster("account-1").length === 1);
    expect(server.presence.roster("account-1")[0].deviceId).toBe("laptop");
  });

  it("expires a client that stops heartbeating, as a crashed machine would", async () => {
    await server.close();
    server = await startServer({ staleAfterMs: 120, sweepIntervalMs: 20 });
    const a = await client({ deviceId: "crashed" });
    await a.hello();
    await settle();
    expect(server.presence.roster("account-1")).toHaveLength(1);

    // Stop answering. The socket stays open, so only expiry can remove it.
    await until(async () => server.presence.roster("account-1").length === 0, 2000);
  });

  it("broadcasts an updated roster when a client changes its joined channels", async () => {
    const a = await client({ deviceId: "laptop" });
    const b = await client({ deviceId: "desktop" });
    await a.hello({ joined: [] });
    await b.hello({ joined: [] });
    await settle();
    const before = b.rosters.length;

    a.setJoined(["twitch:tomcornishh"]);
    await until(async () => b.rosters.length > before);
    const latest = b.rosters[b.rosters.length - 1];
    expect(latest.find((d) => d.deviceId === "laptop").joined).toEqual(["twitch:tomcornishh"]);
  });

  it("replaces a stale session when the same device reconnects", async () => {
    const first = await client({ deviceId: "laptop" });
    await first.hello();
    const second = await client({ deviceId: "laptop" });
    await second.hello();
    await settle();
    expect(server.presence.roster("account-1")).toHaveLength(1);
  });
});

describe("runtime commands", () => {
  it("targets only the clients actually joined to the channel", async () => {
    const inChannel = await client({ deviceId: "in-channel" });
    const alsoIn = await client({ deviceId: "also-in" });
    const notIn = await client({ deviceId: "not-in" });
    await inChannel.hello({ joined: ["twitch:tomcornishh"] });
    await alsoIn.hello({ joined: ["twitch:tomcornishh"] });
    await notIn.hello({ joined: ["twitch:silky"] });
    await settle();

    const result = await notIn.command("leave-channel-everywhere", "twitch:tomcornishh");
    await until(async () => inChannel.commands.length === 1 && alsoIn.commands.length === 1);
    await settle();

    expect(result.targets.sort()).toEqual(["also-in", "in-channel"]);
    expect(notIn.commands).toHaveLength(0);
    expect(inChannel.commandExecutions).toEqual([{ command: "leave-channel-everywhere", channelKey: "twitch:tomcornishh" }]);
    // Presence caught up: nobody is in the channel any more.
    await until(async () => server.presence.joinedTo("account-1", "twitch:tomcornishh").length === 0);
  });

  it("reports no targets when nothing is joined, so no prompt is needed", async () => {
    const a = await client({ deviceId: "A" });
    await a.hello({ joined: [] });
    const result = await a.command("leave-channel-everywhere", "twitch:nobodyhere");
    expect(result.targets).toEqual([]);
  });

  it("executes a redelivered command only once", async () => {
    const target = await client({ deviceId: "target" });
    const issuer = await client({ deviceId: "issuer" });
    await target.hello({ joined: ["twitch:tomcornishh"] });
    await issuer.hello({ joined: [] });
    await settle();

    const first = await issuer.command("leave-channel-everywhere", "twitch:tomcornishh", "cmd-1");
    await until(async () => target.commands.length === 1);
    const second = await issuer.command("leave-channel-everywhere", "twitch:tomcornishh", "cmd-1");
    await settle();

    expect(second.duplicate).toBe(true);
    expect(first.commandId).toBe(second.commandId);
    // Delivered once, and even if it had been delivered twice the client would act once.
    expect(target.commandExecutions).toHaveLength(1);
  });

  it("tells the issuer which devices acknowledged", async () => {
    const target = await client({ deviceId: "target" });
    const issuer = await client({ deviceId: "issuer" });
    await target.hello({ joined: ["twitch:tomcornishh"] });
    await issuer.hello({ joined: [] });
    await settle();

    await issuer.command("leave-channel-everywhere", "twitch:tomcornishh", "cmd-ack");
    const acked = await issuer.waitFor(
      (m) => m.type === "commandResult" && m.commandId === "cmd-ack" && (m.acked || []).includes("target")
    );
    expect(acked.acked).toEqual(["target"]);
  });
});

describe("account isolation", () => {
  it("never leaks another account's state, deltas or presence", async () => {
    const mine = await client({ deviceId: "mine" });
    const theirs = await client({ deviceId: "theirs", token: OTHER_TOKEN });
    await mine.hello({ joined: ["twitch:tomcornishh"] });
    await theirs.hello({ joined: ["twitch:tomcornishh"] });

    await mine.mutate("settings.chat.showTimestamps", true);
    await settle();

    expect(theirs.deltas).toHaveLength(0);
    expect(theirs.applied.size).toBe(0);
    expect(server.presence.roster("account-2").map((d) => d.deviceId)).toEqual(["theirs"]);
    // A command from one account cannot reach the other's clients, even in the same channel.
    const result = await theirs.command("leave-channel-everywhere", "twitch:tomcornishh");
    expect(result.targets).toEqual(["theirs"]);
    expect(mine.commands).toHaveLength(0);
  });

  it("refuses an unauthenticated socket", async () => {
    const bad = new TestClient(server.url, { token: "nope" });
    await expect(bad.connect()).rejects.toThrow();
  });
});

describe("channel preferences use the canonical channel key", () => {
  it("round-trips a stable Twitch channel key", async () => {
    const a = await client({ deviceId: "A" });
    const b = await client({ deviceId: "B" });
    await a.hello();
    await b.hello();
    await a.mutate("channel.twitch:tomcornishh.loggingEnabled", true);
    await b.waitFor((m) => m.type === "delta");
    expect(b.applied.get("channel.twitch:tomcornishh.loggingEnabled")).toBe(true);
  });

  it("accepts an IRC channel key with a network segment", async () => {
    const a = await client({ deviceId: "A" });
    await a.hello();
    const ack = await a.mutate("channel.irc:libera/quipora.favorite", true);
    expect(ack.seq).toBe(1);
  });

  it("rejects a per-install local channel id", async () => {
    // `twitch-111:#foo` is this machine's runtime id, not a portable identity; it must never reach
    // the shared state.
    const a = await client({ deviceId: "A" });
    await a.hello();
    await expect(a.mutate("channel.twitch-111:#tomcornishh.favorite", true)).rejects.toThrow(/channel-key-invalid/);
  });
});

describe("the flood guard, and what a seed must do about it", () => {
  it("accepts a chunk at the limit", async () => {
    const a = await client({ deviceId: "seeder" });
    await a.hello();
    const results = await Promise.allSettled(
      Array.from({ length: 150 }, (_, i) => a.mutate(`settings.seed${i}`, i))
    );
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(0);
    expect(await server.store.currentSeq("account-1")).toBe(150);
  }, 30_000);

  it("rejects the excess beyond the limit within one window", async () => {
    // This is what an unpaced seed ran into: the tail comes back rate-limited, and from the user's
    // side nothing appears to have gone wrong.
    const a = await client({ deviceId: "flooder" });
    await a.hello();
    const results = await Promise.allSettled(
      Array.from({ length: 260 }, (_, i) => a.mutate(`settings.flood${i}`, i))
    );
    const refused = results.filter((r) => r.status === "rejected");
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.every((r) => String(r.reason).includes("rate-limited"))).toBe(true);
  }, 30_000);

  it("counts from a fixed window, which is why a seed must pause longer than it", async () => {
    // The window starts at the connection's first mutation and does not slide, so pausing for less
    // than the window is not pacing at all — the second chunk lands in the same window.
    const a = await client({ deviceId: "windowed" });
    await a.hello();
    const first = await Promise.allSettled(Array.from({ length: 150 }, (_, i) => a.mutate(`settings.w1_${i}`, i)));
    expect(first.filter((r) => r.status === "rejected")).toHaveLength(0);
    await settle(200); // far less than the 10s window
    const second = await Promise.allSettled(Array.from({ length: 100 }, (_, i) => a.mutate(`settings.w2_${i}`, i)));
    expect(second.filter((r) => r.status === "rejected").length).toBeGreaterThan(0);
  }, 30_000);
});
