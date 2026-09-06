"use strict";

/**
 * Multi-client test harness.
 *
 * Runs the *real* WebSocket server over a real HTTP server and connects real `ws` clients, so the
 * protocol, the framing, the auth handshake, the sequence assignment and the presence machinery are
 * all genuinely exercised. Nothing here mocks the transport — a test that passes against a mocked
 * socket proves very little about a system whose whole job is surviving a dropped connection.
 *
 * The store is swappable: the suite runs against the in-memory implementation by default and can be
 * pointed at MongoDB to prove the atomicity assumptions hold there too.
 */

const http = require("node:http");
const WebSocket = require("ws");
const { attachRealtime } = require("../realtime/server");
const { createPresence } = require("../realtime/presence");
const { createMemoryStore } = require("../realtime/store");

const VALID_TOKEN = "test-token-account-1";
const OTHER_TOKEN = "test-token-account-2";

/** Stands in for validateTwitchToken — same contract, no network. */
function testValidateToken(token) {
  if (token === VALID_TOKEN) return { userId: "account-1", login: "kevin" };
  if (token === OTHER_TOKEN) return { userId: "account-2", login: "someoneelse" };
  return null;
}

async function startServer(options = {}) {
  const store = options.store || createMemoryStore();
  const presence = createPresence({ staleAfterMs: options.staleAfterMs });
  const httpServer = http.createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  const realtime = attachRealtime(httpServer, {
    store,
    presence,
    validateToken: options.validateToken || testValidateToken,
    logger: options.logger,
    sweepIntervalMs: options.sweepIntervalMs || 50
  });
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const port = httpServer.address().port;

  return {
    store,
    presence,
    realtime,
    port,
    url: `ws://127.0.0.1:${port}/ws`,
    async close() {
      await realtime.close();
      await new Promise((resolve) => httpServer.close(resolve));
    }
  };
}

/**
 * A logical Quipora client.
 *
 * Mirrors the parts of the desktop client's behaviour the protocol depends on: it tracks its own
 * last applied sequence, ignores anything at or below it (which is what makes redelivery safe), and
 * records everything it receives so tests can assert on ordering rather than on timing.
 */
class TestClient {
  constructor(url, options = {}) {
    this.url = url;
    this.token = options.token || VALID_TOKEN;
    this.deviceId = options.deviceId || `device-${Math.random().toString(36).slice(2, 10)}`;
    this.lastSeq = options.lastSeq || 0;
    this.applied = new Map();
    this.received = [];
    this.deltas = [];
    this.commands = [];
    this.rosters = [];
    this.ready = null;
    this.duplicateApplies = 0;
    this.autoAckCommands = options.autoAckCommands !== false;
    this.seenCommandIds = new Set();
    this.commandExecutions = [];
    this._waiters = new Set();
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.socket = new WebSocket(this.url, { headers: { "x-twitch-token": this.token } });
      this.socket.on("message", (raw) => this._onMessage(JSON.parse(String(raw))));
      this.socket.on("open", () => resolve());
      this.socket.on("error", (error) => reject(error));
    });
  }

  _onMessage(message) {
    this.received.push(message);
    switch (message.type) {
      case "ready":
        this.ready = message;
        if (message.mode === "snapshot") {
          this.applied = new Map(Object.entries(message.values || {}));
        } else {
          for (const change of message.changes || []) this._apply(change);
        }
        this.lastSeq = message.seq;
        break;
      case "delta":
        this.deltas.push(message);
        this._apply(message);
        break;
      case "command":
        this.commands.push(message);
        this._executeCommand(message);
        break;
      case "roster":
        this.rosters.push(message.devices);
        break;
      default:
        break;
    }
    for (const waiter of Array.from(this._waiters)) {
      if (waiter.predicate(message)) {
        this._waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  }

  /**
   * Applies an authoritative change.
   *
   * Mirrors src/main/realtimeClient.ts exactly: the sequence is a high-water mark and anything at
   * or below it is dropped, whatever key it carries. Being stricter here than the real client would
   * make the harness quietly forgiving of an ordering bug the shipped client would not survive.
   */
  _apply(change) {
    if (change.seq <= this.lastSeq) {
      this.duplicateApplies += 1;
      return;
    }
    if (change.deleted) this.applied.delete(change.key);
    else this.applied.set(change.key, change.value);
    if (change.seq > this.lastSeq) this.lastSeq = change.seq;
  }

  /** Commands are executed at most once per commandId, however often they are delivered. */
  _executeCommand(message) {
    if (this.seenCommandIds.has(message.commandId)) {
      if (this.autoAckCommands) this.send({ type: "commandAck", commandId: message.commandId, ok: true });
      return;
    }
    this.seenCommandIds.add(message.commandId);
    this.commandExecutions.push({ command: message.command, channelKey: message.channelKey });
    if (message.command === "leave-channel-everywhere") {
      this.joined = (this.joined || []).filter((key) => key !== message.channelKey);
      this.send({ type: "presence", joined: this.joined });
    }
    if (this.autoAckCommands) this.send({ type: "commandAck", commandId: message.commandId, ok: true });
  }

  send(message) {
    this.socket.send(JSON.stringify(message));
  }

  /**
   * Resolves with the first message matching `predicate`.
   *
   * `since` matters: several tests send the same logical request twice on purpose (a redelivered
   * command, a replayed mutation) and must observe the *second* reply, not rediscover the first one
   * still sitting in the received log.
   */
  waitFor(predicate, timeoutMs = 2000, since = 0) {
    const already = this.received.slice(since).find(predicate);
    if (already) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject };
      waiter.timer = setTimeout(() => {
        this._waiters.delete(waiter);
        reject(new Error("timed out waiting for message"));
      }, timeoutMs);
      this._waiters.add(waiter);
    });
  }

  async hello(options = {}) {
    this.joined = options.joined || [];
    const ready = this.waitFor((m) => m.type === "ready");
    this.send({
      type: "hello",
      deviceId: this.deviceId,
      lastSeq: this.lastSeq,
      joined: this.joined,
      appVersion: options.appVersion || "0.2.73",
      platform: options.platform || "darwin",
      label: options.label
    });
    return ready;
  }

  async mutate(key, value, options = {}) {
    const mutationId = options.mutationId || `m-${Math.random().toString(36).slice(2, 12)}`;
    const since = this.received.length;
    const settled = this.waitFor(
      (m) => (m.type === "ack" || m.type === "nack") && m.mutationId === mutationId,
      options.timeoutMs || 2000,
      since
    );
    this._applyLocal(key, value, options.deleted);
    this.send({ type: "mutate", mutationId, key, value, deleted: Boolean(options.deleted) });
    const reply = await settled;
    if (reply.type === "ack" && reply.seq > this.lastSeq) this.lastSeq = reply.seq;
    if (reply.type === "nack") throw new Error(reply.reason);
    return reply;
  }

  /** Sends a mutation without waiting, for near-simultaneous-write tests. */
  mutateNoWait(key, value, mutationId) {
    this._applyLocal(key, value, false);
    this.send({ type: "mutate", mutationId: mutationId || `m-${Math.random().toString(36).slice(2, 12)}`, key, value });
  }

  /**
   * A local user-originated change takes effect immediately, exactly as it does in the real client:
   * the user sees the toggle move before the server has sequenced anything.
   *
   * It deliberately does NOT advance lastSeq — no authoritative order has been assigned yet — which
   * is what lets a concurrent change from another device with a higher sequence still win.
   */
  _applyLocal(key, value, deleted) {
    if (deleted) this.applied.delete(key);
    else this.applied.set(key, value);
  }

  setJoined(joined) {
    this.joined = joined;
    this.send({ type: "presence", joined });
  }

  command(command, channelKey, commandId) {
    const id = commandId || `c-${Math.random().toString(36).slice(2, 12)}`;
    const since = this.received.length;
    // Only the direct reply, not the progress updates that arrive as targets acknowledge.
    const result = this.waitFor(
      (m) => m.type === "commandResult" && m.commandId === id && (m.phase === "issued" || m.phase === "duplicate"),
      2000,
      since
    );
    this.send({ type: "command", commandId: id, command, channelKey });
    return result.then((message) => ({ ...message, commandId: id }));
  }

  close() {
    return new Promise((resolve) => {
      if (!this.socket || this.socket.readyState === WebSocket.CLOSED) return resolve();
      this.socket.on("close", () => resolve());
      this.socket.close();
    });
  }
}

/** Waits until `predicate()` is true, polling — for assertions about absence of an event. */
async function until(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not met in time");
}

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = { startServer, TestClient, until, settle, VALID_TOKEN, OTHER_TOKEN, testValidateToken };
