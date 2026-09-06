"use strict";

/**
 * Which Quipora clients are connected right now, and what each is currently joined to.
 *
 * Presence is runtime truth, not preference state, and the two are deliberately never mixed:
 *
 *   channel.twitch:foo.autoJoin = true   — a preference. Persisted. Syncs. Means "I want to join".
 *   presence.joined contains twitch:foo  — an observation. Ephemeral. Means "this machine is in it".
 *
 * Conflating them is what makes "leave this channel everywhere" impossible to implement correctly:
 * you cannot ask "is anyone actually in this channel" of a preference.
 *
 * DEPLOYMENT LIMITATION — presence is in-memory and therefore scoped to one backend process. That
 * is correct for the current single-container deployment on ClovaForge, and it is the reason no
 * Redis or pub/sub layer exists here. If this backend is ever horizontally scaled, two clients
 * could land on different instances and each would see an incomplete roster; presence and command
 * fan-out would then need a shared bus. Persisted state (realtime/store.js) is unaffected either
 * way — it is already in MongoDB.
 */

/** A client that has not been heard from in this long is treated as gone. */
const STALE_AFTER_MS = 90 * 1000;
/** How often expired sessions are swept. */
const SWEEP_INTERVAL_MS = 15 * 1000;

function createPresence(options = {}) {
  const staleAfterMs = options.staleAfterMs || STALE_AFTER_MS;
  const now = options.now || (() => Date.now());
  /** accountId -> Map<deviceId, session> */
  const accounts = new Map();
  const listeners = new Set();

  function bucket(accountId) {
    let existing = accounts.get(accountId);
    if (!existing) {
      existing = new Map();
      accounts.set(accountId, existing);
    }
    return existing;
  }

  function emitChange(accountId) {
    for (const listener of listeners) {
      try {
        listener(accountId);
      } catch {
        // A misbehaving listener must not take presence down with it.
      }
    }
  }

  function publicSession(session) {
    return {
      deviceId: session.deviceId,
      label: session.label || null,
      appVersion: session.appVersion || null,
      platform: session.platform || null,
      joined: Array.from(session.joined).sort(),
      connectedAt: session.connectedAt,
      lastSeen: session.lastSeen
    };
  }

  return {
    /**
     * Registers a connection. A second connection from the same deviceId replaces the first — a
     * client that reconnected before its old socket timed out must not appear twice in the roster.
     * The replaced session is returned so the caller can close it.
     */
    connect(accountId, session) {
      const devices = bucket(accountId);
      const previous = devices.get(session.deviceId);
      devices.set(session.deviceId, {
        deviceId: session.deviceId,
        socket: session.socket,
        label: session.label || null,
        appVersion: session.appVersion || null,
        platform: session.platform || null,
        joined: new Set(session.joined || []),
        connectedAt: now(),
        lastSeen: now()
      });
      emitChange(accountId);
      return previous && previous.socket !== session.socket ? previous : null;
    },

    disconnect(accountId, deviceId, socket) {
      const devices = accounts.get(accountId);
      if (!devices) return false;
      const session = devices.get(deviceId);
      // Only drop the session if it still belongs to this socket. Otherwise a late close event from
      // a superseded socket would evict the live reconnection that replaced it.
      if (!session || (socket && session.socket !== socket)) return false;
      devices.delete(deviceId);
      if (devices.size === 0) accounts.delete(accountId);
      emitChange(accountId);
      return true;
    },

    heartbeat(accountId, deviceId) {
      const session = accounts.get(accountId) && accounts.get(accountId).get(deviceId);
      if (!session) return false;
      session.lastSeen = now();
      return true;
    },

    /** Replaces a client's joined-channel set. Returns true when it actually changed. */
    setJoined(accountId, deviceId, joined) {
      const session = accounts.get(accountId) && accounts.get(accountId).get(deviceId);
      if (!session) return false;
      const next = new Set(joined || []);
      const changed = next.size !== session.joined.size || [...next].some((key) => !session.joined.has(key));
      session.joined = next;
      session.lastSeen = now();
      if (changed) emitChange(accountId);
      return changed;
    },

    /** Live sessions for an account, newest state, safe to send to that account's own clients. */
    roster(accountId) {
      const devices = accounts.get(accountId);
      if (!devices) return [];
      return Array.from(devices.values()).map(publicSession).sort((a, b) => a.deviceId.localeCompare(b.deviceId));
    },

    /** Sessions currently joined to a channel — the targets for a leave-everywhere command. */
    joinedTo(accountId, channelKey) {
      const devices = accounts.get(accountId);
      if (!devices) return [];
      return Array.from(devices.values()).filter((session) => session.joined.has(channelKey));
    },

    session(accountId, deviceId) {
      const devices = accounts.get(accountId);
      return devices ? devices.get(deviceId) || null : null;
    },

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /**
     * Drops sessions that have stopped heartbeating. A machine that crashed or lost power never
     * sends a close frame, so without this it would linger in the roster forever and keep being
     * targeted by commands it will never execute.
     */
    sweep() {
      const cutoff = now() - staleAfterMs;
      const expired = [];
      for (const [accountId, devices] of accounts) {
        for (const [deviceId, session] of devices) {
          if (session.lastSeen < cutoff) {
            devices.delete(deviceId);
            expired.push({ accountId, deviceId, socket: session.socket });
          }
        }
        if (devices.size === 0) accounts.delete(accountId);
      }
      for (const account of new Set(expired.map((entry) => entry.accountId))) emitChange(account);
      return expired;
    },

    stats() {
      let sessions = 0;
      for (const devices of accounts.values()) sessions += devices.size;
      return { accounts: accounts.size, sessions };
    }
  };
}

module.exports = { createPresence, STALE_AFTER_MS, SWEEP_INTERVAL_MS };
