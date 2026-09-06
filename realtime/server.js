"use strict";

/**
 * The realtime coordinator: one WebSocket endpoint that carries per-key deltas, presence and
 * runtime commands for a single authenticated Quipora account.
 *
 * Protocol summary (JSON text frames, one message per frame):
 *
 *   client -> server
 *     hello        { deviceId, lastSeq, joined[], appVersion, platform, label }
 *     mutate       { mutationId, key, value, deleted? }
 *     presence     { joined[] }
 *     command      { commandId, type, channelKey }
 *     commandAck   { commandId, ok, error? }
 *     ping         {}
 *
 *   server -> client
 *     ready         { accountId, deviceId, mode: "resume"|"snapshot", seq, values?, changes? }
 *     delta         { seq, key, value, deleted, deviceId }
 *     ack           { mutationId, seq, duplicate }
 *     nack          { mutationId, reason }
 *     roster        { devices[] }
 *     command       { commandId, type, channelKey, issuedBy }
 *     commandResult { commandId, targets[], acked[] }
 *     pong          {}
 *     error         { reason }
 *
 * Ordering is entirely the server's: a client proposes a mutation, the server assigns the next
 * sequence for the account, and every client applies in sequence order. A client that receives a
 * delta at or below its own last applied sequence ignores it, which is what makes redelivery
 * during a resume harmless.
 */

const { WebSocketServer } = require("ws");
const { parseKey, validateValue } = require("./keys");
const { SWEEP_INTERVAL_MS } = require("./presence");

const PROTOCOL_VERSION = 1;
/** Frames larger than this are refused outright rather than parsed. */
const MAX_FRAME_BYTES = 512 * 1024;
/** Crude flood guard; a well-behaved client is nowhere near this. */
const MAX_MUTATIONS_PER_10S = 200;
const COMMAND_TYPES = new Set(["leave-channel-everywhere"]);

function send(socket, type, payload) {
  if (socket.readyState !== socket.OPEN) return false;
  try {
    socket.send(JSON.stringify({ type, ...payload }));
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {import("http").Server} httpServer
 * @param {{ store, presence, validateToken, path?, logger?, now? }} options
 */
function attachRealtime(httpServer, options) {
  const { store, presence, validateToken } = options;
  const path = options.path || "/ws";
  const now = options.now || (() => Date.now());
  const log = options.logger || (() => {});

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  /**
   * Serialises mutation handling per account.
   *
   * Applying a mutation awaits the database, so without this two mutations for one account can
   * complete in either order and their deltas go out in either order. Clients treat the sequence as
   * a high-water mark and ignore anything at or below it, so an out-of-order delta would not merely
   * arrive late — it would be discarded, and if it carried a *different* key that key's change
   * would be lost on that client while remaining correct in the database. Divergence that only
   * shows up under concurrency is exactly the kind that survives to production, so the fan-out is
   * kept strictly in sequence order at the source.
   *
   * One chain per account, so unrelated accounts never wait on each other.
   */
  const accountQueues = new Map();

  function enqueue(accountId, task) {
    const previous = accountQueues.get(accountId) || Promise.resolve();
    // `.catch` on the stored chain so one failed mutation cannot wedge the account's queue.
    const next = previous.then(task, task);
    const tracked = next.catch(() => {});
    accountQueues.set(accountId, tracked);
    // Release the entry once this is the tail and it has settled, so idle accounts hold nothing.
    void tracked.then(() => {
      if (accountQueues.get(accountId) === tracked) accountQueues.delete(accountId);
    });
    return next;
  }
  /** Commands awaiting acknowledgement: commandId -> { accountId, targets:Set, acked:Set, issuedBy } */
  const pendingCommands = new Map();

  /**
   * Sends to every live client of an account, including the one that caused the change.
   *
   * Echoing to the originator is deliberate. A client may apply a local change optimistically so the
   * UI responds instantly, but that value has no authoritative order yet. If the originator were
   * excluded, two devices writing the same key at once could converge differently: each would keep
   * its own optimistic value and then see only the *other* one's delta, with no way to tell which
   * the server had actually sequenced last. With the echo, every client applies the same keys in
   * the same server-assigned order and provably ends in the same state.
   *
   * This does not create a loop: applying a delta never produces a mutation. Those are separate
   * code paths, and only an explicit local user action reaches the mutation path at all.
   */
  function broadcast(accountId, type, payload) {
    for (const session of presence.roster(accountId)) {
      const live = presence.session(accountId, session.deviceId);
      if (!live) continue;
      send(live.socket, type, payload);
    }
  }

  function sendRoster(accountId) {
    const devices = presence.roster(accountId);
    for (const entry of devices) {
      const live = presence.session(accountId, entry.deviceId);
      if (live) send(live.socket, "roster", { devices });
    }
  }

  presence.onChange((accountId) => sendRoster(accountId));

  /* --------------------------------------------------------------------------------------- */
  /* Upgrade + authentication                                                                  */
  /* --------------------------------------------------------------------------------------- */

  async function handleUpgrade(request, socket, head) {
    // The account is established here, from a credential, and then never taken from the client
    // again. Nothing the socket sends later can change which account it is bound to — a deviceId in
    // a `hello` frame names a device, never an identity.
    const token = String(request.headers["x-twitch-token"] || "");
    let identity = null;
    try {
      identity = await validateToken(token);
    } catch {
      identity = null;
    }
    if (!identity) {
      log("debug", "realtime: rejected unauthenticated upgrade");
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request, identity);
    });
  }

  httpServer.on("upgrade", (request, socket, head) => {
    let pathname;
    try {
      pathname = new URL(request.url, "http://localhost").pathname;
    } catch {
      pathname = request.url;
    }
    if (pathname !== path) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    void handleUpgrade(request, socket, head);
  });

  /* --------------------------------------------------------------------------------------- */
  /* Connection lifecycle                                                                      */
  /* --------------------------------------------------------------------------------------- */

  wss.on("connection", (ws, request, identity) => {
    const accountId = identity.userId;
    const connection = {
      accountId,
      login: identity.login,
      deviceId: null,
      ready: false,
      mutationWindowStart: now(),
      mutationsInWindow: 0
    };

    log("info", "realtime: socket open", { accountId, login: identity.login });

    ws.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch {
        send(ws, "error", { reason: "malformed-json" });
        return;
      }
      if (!message || typeof message.type !== "string") {
        send(ws, "error", { reason: "malformed-message" });
        return;
      }
      void handleMessage(ws, connection, message);
    });

    ws.on("close", () => {
      if (connection.deviceId) {
        const removed = presence.disconnect(accountId, connection.deviceId, ws);
        if (removed) {
          log("info", "realtime: socket closed", { accountId, deviceId: connection.deviceId });
        }
      }
    });

    ws.on("error", (error) => {
      log("debug", "realtime: socket error", { accountId, error: error && error.message });
    });
  });

  async function handleMessage(ws, connection, message) {
    switch (message.type) {
      case "hello":
        return handleHello(ws, connection, message);
      case "ping":
        if (connection.deviceId) presence.heartbeat(connection.accountId, connection.deviceId);
        send(ws, "pong", {});
        return;
      case "mutate":
        // Queued per account so deltas are emitted in the same order the sequences were assigned.
        return enqueue(connection.accountId, () => handleMutate(ws, connection, message));
      case "presence":
        return handlePresence(ws, connection, message);
      case "command":
        return handleCommand(ws, connection, message);
      case "commandAck":
        return handleCommandAck(ws, connection, message);
      default:
        send(ws, "error", { reason: "unknown-message-type" });
    }
  }

  /**
   * Establishes the session and brings the client to the authoritative state.
   *
   * `lastSeq` is what the client last applied. If the log still reaches back that far it is resumed
   * from there; otherwise it is handed a snapshot. Either way the client is fully converged before
   * it is allowed to send anything, which is how a laptop that has been offline for a week is
   * prevented from pushing its stale document over newer shared state: it has nothing to push,
   * because being stale is not a change.
   */
  async function handleHello(ws, connection, message) {
    const deviceId = typeof message.deviceId === "string" ? message.deviceId.trim() : "";
    if (!deviceId || deviceId.length > 128) {
      send(ws, "error", { reason: "device-id-invalid" });
      ws.close(4000, "device-id-invalid");
      return;
    }
    connection.deviceId = deviceId;

    const superseded = presence.connect(connection.accountId, {
      deviceId,
      socket: ws,
      label: typeof message.label === "string" ? message.label.slice(0, 64) : null,
      appVersion: typeof message.appVersion === "string" ? message.appVersion.slice(0, 32) : null,
      platform: typeof message.platform === "string" ? message.platform.slice(0, 32) : null,
      joined: Array.isArray(message.joined) ? message.joined.filter((k) => typeof k === "string").slice(0, 2000) : []
    });
    if (superseded && superseded.socket && superseded.socket !== ws) {
      // Same device reconnected before its previous socket timed out.
      try { superseded.socket.close(4001, "superseded"); } catch { /* already gone */ }
    }

    const lastSeq = Number.isFinite(message.lastSeq) && message.lastSeq >= 0 ? Math.floor(message.lastSeq) : 0;
    const resume = await store.changesSince(connection.accountId, lastSeq);

    if (resume.ok) {
      connection.ready = true;
      send(ws, "ready", {
        protocol: PROTOCOL_VERSION,
        accountId: connection.accountId,
        deviceId,
        mode: "resume",
        seq: resume.seq,
        changes: resume.changes.map((entry) => ({
          seq: entry.seq,
          key: entry.key,
          value: entry.value,
          deleted: Boolean(entry.deleted),
          deviceId: entry.deviceId || null
        }))
      });
      log("info", "realtime: client resumed", {
        accountId: connection.accountId, deviceId, fromSeq: lastSeq, toSeq: resume.seq, changes: resume.changes.length
      });
    } else {
      const snapshot = await store.getSnapshot(connection.accountId);
      connection.ready = true;
      send(ws, "ready", {
        protocol: PROTOCOL_VERSION,
        accountId: connection.accountId,
        deviceId,
        mode: "snapshot",
        seq: snapshot.seq,
        values: snapshot.values,
        reason: resume.reason
      });
      log("info", "realtime: client snapshotted", {
        accountId: connection.accountId, deviceId, fromSeq: lastSeq, toSeq: snapshot.seq, reason: resume.reason
      });
    }

    sendRoster(connection.accountId);
  }

  function rateLimited(connection) {
    const nowMs = now();
    if (nowMs - connection.mutationWindowStart > 10_000) {
      connection.mutationWindowStart = nowMs;
      connection.mutationsInWindow = 0;
    }
    connection.mutationsInWindow += 1;
    return connection.mutationsInWindow > MAX_MUTATIONS_PER_10S;
  }

  async function handleMutate(ws, connection, message) {
    if (!connection.ready) {
      send(ws, "nack", { mutationId: message.mutationId || null, reason: "not-ready" });
      return;
    }
    const mutationId = typeof message.mutationId === "string" ? message.mutationId : "";
    if (!mutationId || mutationId.length > 64) {
      send(ws, "nack", { mutationId: mutationId || null, reason: "mutation-id-invalid" });
      return;
    }
    const parsed = parseKey(message.key);
    if (!parsed.ok) {
      log("debug", "realtime: rejected mutation", { accountId: connection.accountId, reason: parsed.reason, key: message.key });
      send(ws, "nack", { mutationId, reason: parsed.reason });
      return;
    }
    if (!message.deleted) {
      const valueCheck = validateValue(message.value);
      if (!valueCheck.ok) {
        send(ws, "nack", { mutationId, reason: valueCheck.reason });
        return;
      }
    }
    if (rateLimited(connection)) {
      send(ws, "nack", { mutationId, reason: "rate-limited" });
      return;
    }

    let result;
    try {
      result = await store.applyMutation(connection.accountId, {
        mutationId,
        key: message.key,
        value: message.value,
        deleted: Boolean(message.deleted),
        deviceId: connection.deviceId
      });
    } catch (error) {
      log("error", "realtime: mutation failed", { accountId: connection.accountId, error: error && error.message });
      send(ws, "nack", { mutationId, reason: "server-error" });
      return;
    }

    send(ws, "ack", { mutationId, seq: result.seq, duplicate: result.duplicate });

    // A duplicate delivery must not produce a second delta; the state never changed the second time.
    if (result.duplicate) {
      log("debug", "realtime: duplicate mutation ignored", { accountId: connection.accountId, mutationId, seq: result.seq });
      return;
    }

    broadcast(connection.accountId, "delta", {
      seq: result.seq,
      key: message.key,
      value: message.deleted ? null : message.value,
      deleted: Boolean(message.deleted),
      deviceId: connection.deviceId
    });
  }

  function handlePresence(ws, connection, message) {
    if (!connection.ready || !connection.deviceId) {
      send(ws, "error", { reason: "not-ready" });
      return;
    }
    const joined = Array.isArray(message.joined)
      ? message.joined.filter((key) => typeof key === "string").slice(0, 2000)
      : [];
    presence.setJoined(connection.accountId, connection.deviceId, joined);
  }

  /**
   * Fans a runtime command out to the clients it actually applies to.
   *
   * "Leave this channel everywhere" targets the clients presence says are *currently joined*, which
   * is why presence tracks joined channels separately from the autoJoin preference. A client that
   * merely has autoJoin set but is not connected is not a target; there is nothing for it to leave.
   */
  function handleCommand(ws, connection, message) {
    if (!connection.ready) {
      send(ws, "error", { reason: "not-ready" });
      return;
    }
    const commandId = typeof message.commandId === "string" ? message.commandId : "";
    if (!commandId || commandId.length > 64) {
      send(ws, "error", { reason: "command-id-invalid" });
      return;
    }
    if (!COMMAND_TYPES.has(message.type_ || message.command)) {
      send(ws, "error", { reason: "command-unknown" });
      return;
    }
    const commandType = message.type_ || message.command;
    const channelKey = typeof message.channelKey === "string" ? message.channelKey : "";
    if (!channelKey) {
      send(ws, "error", { reason: "channel-key-required" });
      return;
    }

    // Re-issuing a command id is a no-op rather than a second fan-out, so a client that retries
    // after a reconnect cannot make every machine part twice.
    const existing = pendingCommands.get(commandId);
    if (existing) {
      send(ws, "commandResult", {
        commandId,
        phase: "duplicate",
        targets: Array.from(existing.targets),
        acked: Array.from(existing.acked),
        duplicate: true
      });
      return;
    }

    const targets = presence.joinedTo(connection.accountId, channelKey);
    const record = {
      accountId: connection.accountId,
      channelKey,
      commandType,
      issuedBy: connection.deviceId,
      targets: new Set(targets.map((session) => session.deviceId)),
      acked: new Set(),
      at: now()
    };
    pendingCommands.set(commandId, record);

    for (const session of targets) {
      send(session.socket, "command", {
        commandId,
        command: commandType,
        channelKey,
        issuedBy: connection.deviceId
      });
    }

    log("info", "realtime: command issued", {
      accountId: connection.accountId, commandId, command: commandType, channelKey, targets: record.targets.size
    });

    send(ws, "commandResult", { commandId, phase: "issued", targets: Array.from(record.targets), acked: [], duplicate: false });
  }

  function handleCommandAck(ws, connection, message) {
    const commandId = typeof message.commandId === "string" ? message.commandId : "";
    const record = pendingCommands.get(commandId);
    if (!record || record.accountId !== connection.accountId) return;
    record.acked.add(connection.deviceId);
    log("debug", "realtime: command acknowledged", {
      accountId: connection.accountId, commandId, deviceId: connection.deviceId,
      acked: record.acked.size, targets: record.targets.size
    });
    const issuer = presence.session(connection.accountId, record.issuedBy);
    if (issuer) {
      send(issuer.socket, "commandResult", {
        commandId,
        phase: "progress",
        targets: Array.from(record.targets),
        acked: Array.from(record.acked)
      });
    }
  }

  /* --------------------------------------------------------------------------------------- */
  /* Housekeeping                                                                              */
  /* --------------------------------------------------------------------------------------- */

  const sweepTimer = setInterval(() => {
    for (const expired of presence.sweep()) {
      log("info", "realtime: presence expired", { accountId: expired.accountId, deviceId: expired.deviceId });
      try { expired.socket && expired.socket.terminate(); } catch { /* already gone */ }
    }
    // Commands are short-lived; anything older than five minutes is not going to be acknowledged.
    const cutoff = now() - 5 * 60 * 1000;
    for (const [commandId, record] of pendingCommands) {
      if (record.at < cutoff) pendingCommands.delete(commandId);
    }
  }, options.sweepIntervalMs || SWEEP_INTERVAL_MS);
  if (sweepTimer.unref) sweepTimer.unref();

  return {
    wss,
    stats: () => ({ ...presence.stats(), pendingCommands: pendingCommands.size }),
    async close() {
      clearInterval(sweepTimer);
      for (const client of wss.clients) {
        try { client.terminate(); } catch { /* ignore */ }
      }
      await new Promise((resolve) => wss.close(resolve));
    }
  };
}

module.exports = { attachRealtime, PROTOCOL_VERSION, COMMAND_TYPES, MAX_FRAME_BYTES };
