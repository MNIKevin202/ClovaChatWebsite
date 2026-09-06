import { describe, expect, it, vi } from "vitest";
import presenceModule from "../realtime/presence.js";

const { createPresence } = presenceModule;

const socket = (name) => ({ name });

describe("presence", () => {
  it("tracks connected devices and their joined channels", () => {
    const presence = createPresence();
    presence.connect("acct", { deviceId: "laptop", socket: socket("a"), joined: ["twitch:foo"] });
    presence.connect("acct", { deviceId: "desktop", socket: socket("b"), joined: [] });

    expect(presence.roster("acct").map((d) => d.deviceId)).toEqual(["desktop", "laptop"]);
    expect(presence.joinedTo("acct", "twitch:foo").map((s) => s.deviceId)).toEqual(["laptop"]);
  });

  it("keeps accounts isolated from one another", () => {
    const presence = createPresence();
    presence.connect("mine", { deviceId: "d1", socket: socket("a"), joined: ["twitch:foo"] });
    presence.connect("theirs", { deviceId: "d2", socket: socket("b"), joined: ["twitch:foo"] });
    expect(presence.roster("mine")).toHaveLength(1);
    expect(presence.joinedTo("mine", "twitch:foo").map((s) => s.deviceId)).toEqual(["d1"]);
  });

  it("replaces a session when the same device reconnects, and returns the old one to close", () => {
    const presence = createPresence();
    const first = socket("first");
    presence.connect("acct", { deviceId: "laptop", socket: first, joined: [] });
    const superseded = presence.connect("acct", { deviceId: "laptop", socket: socket("second"), joined: [] });
    expect(superseded.socket).toBe(first);
    expect(presence.roster("acct")).toHaveLength(1);
  });

  it("ignores a close from a socket that has already been superseded", () => {
    // Otherwise a late close event from the old socket evicts the live reconnection.
    const presence = createPresence();
    const first = socket("first");
    const second = socket("second");
    presence.connect("acct", { deviceId: "laptop", socket: first, joined: [] });
    presence.connect("acct", { deviceId: "laptop", socket: second, joined: [] });

    expect(presence.disconnect("acct", "laptop", first)).toBe(false);
    expect(presence.roster("acct")).toHaveLength(1);
    expect(presence.disconnect("acct", "laptop", second)).toBe(true);
    expect(presence.roster("acct")).toHaveLength(0);
  });

  it("expires a device that stops heartbeating", () => {
    let clock = 1000;
    const presence = createPresence({ staleAfterMs: 500, now: () => clock });
    presence.connect("acct", { deviceId: "crashed", socket: socket("a"), joined: [] });

    clock += 400;
    expect(presence.sweep()).toEqual([]);
    expect(presence.roster("acct")).toHaveLength(1);

    clock += 200;
    const expired = presence.sweep();
    expect(expired.map((e) => e.deviceId)).toEqual(["crashed"]);
    expect(presence.roster("acct")).toHaveLength(0);
  });

  it("keeps a device alive while it heartbeats", () => {
    let clock = 1000;
    const presence = createPresence({ staleAfterMs: 500, now: () => clock });
    presence.connect("acct", { deviceId: "alive", socket: socket("a"), joined: [] });
    clock += 400;
    presence.heartbeat("acct", "alive");
    clock += 400;
    expect(presence.sweep()).toEqual([]);
    expect(presence.roster("acct")).toHaveLength(1);
  });

  it("notifies listeners only when the joined set actually changes", () => {
    const presence = createPresence();
    presence.connect("acct", { deviceId: "d", socket: socket("a"), joined: ["twitch:foo"] });
    const listener = vi.fn();
    presence.onChange(listener);

    expect(presence.setJoined("acct", "d", ["twitch:foo"])).toBe(false);
    expect(listener).not.toHaveBeenCalled();

    expect(presence.setJoined("acct", "d", ["twitch:foo", "twitch:bar"])).toBe(true);
    expect(listener).toHaveBeenCalledWith("acct");
  });

  it("does not resurrect a device that is no longer connected", () => {
    const presence = createPresence();
    expect(presence.heartbeat("acct", "ghost")).toBe(false);
    expect(presence.setJoined("acct", "ghost", ["twitch:foo"])).toBe(false);
    expect(presence.roster("acct")).toEqual([]);
  });
});
