"use strict";

/**
 * The key namespace shared by the desktop client and this server.
 *
 * A key names one synchronised value. Nothing else in the protocol carries meaning about *what* is
 * being changed, so the rules here are the whole contract:
 *
 *   settings.<dotted path>              e.g. settings.chat.showTimestamps
 *   channel.<channelKey>.<field>        e.g. channel.twitch:tomcornishh.autoJoin
 *
 * `channelKey` is the stable channel identity established in Phase 3 — `twitch:<login>` or
 * `irc:<network>/<channel>`. It deliberately contains a colon and may contain a slash, so a channel
 * key is parsed by position rather than by splitting on every separator.
 *
 * Keys are validated rather than trusted. An authenticated socket is still a client we do not
 * control, and an unbounded key namespace is an unbounded write primitive against the account's
 * document.
 */

/** Field names permitted under `channel.<key>.` — mirrors CHANNEL_FIELDS in the desktop app. */
const CHANNEL_FIELDS = new Set([
  "favorite",
  "muted",
  "pinned",
  "autoJoin",
  "keepJoinedWhenOffline",
  "notificationMode",
  "loggingEnabled",
  "saveHistory",
  "monitors"
]);

const MAX_KEY_LENGTH = 200;
// Generous enough for a theme or a monitor list, small enough that one client cannot use the
// account document as free storage.
const MAX_VALUE_BYTES = 256 * 1024;

const SETTINGS_PATH = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/;
const CHANNEL_KEY = /^(twitch:[a-z0-9_]{1,64}|irc:[a-z0-9_.\-]{1,64}\/[a-z0-9_.\-#]{1,64})$/;

/**
 * Parses and validates a key.
 * Returns `{ ok: true, kind, ... }` or `{ ok: false, reason }`.
 */
function parseKey(key) {
  if (typeof key !== "string" || key.length === 0) return { ok: false, reason: "key-missing" };
  if (key.length > MAX_KEY_LENGTH) return { ok: false, reason: "key-too-long" };

  if (key.startsWith("settings.")) {
    const path = key.slice("settings.".length);
    if (!SETTINGS_PATH.test(path)) return { ok: false, reason: "key-invalid" };
    return { ok: true, kind: "settings", path };
  }

  if (key.startsWith("channel.")) {
    const rest = key.slice("channel.".length);
    // The field is the segment after the final dot; everything before it is the channel key, which
    // may itself contain dots (an IRC network can be `irc.example.net`).
    const lastDot = rest.lastIndexOf(".");
    if (lastDot <= 0) return { ok: false, reason: "key-invalid" };
    const channelKey = rest.slice(0, lastDot);
    const field = rest.slice(lastDot + 1);
    if (!CHANNEL_KEY.test(channelKey)) return { ok: false, reason: "channel-key-invalid" };
    if (!CHANNEL_FIELDS.has(field)) return { ok: false, reason: "channel-field-unknown" };
    return { ok: true, kind: "channel", channelKey, field };
  }

  return { ok: false, reason: "key-namespace-unknown" };
}

function isValidKey(key) {
  return parseKey(key).ok;
}

/** Rejects values that are not JSON-serialisable or are too large to be a preference. */
function validateValue(value) {
  if (value === undefined) return { ok: false, reason: "value-undefined" };
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return { ok: false, reason: "value-unserialisable" };
  }
  if (encoded === undefined) return { ok: false, reason: "value-unserialisable" };
  if (Buffer.byteLength(encoded, "utf8") > MAX_VALUE_BYTES) return { ok: false, reason: "value-too-large" };
  return { ok: true };
}

/** Channel key a channel-scoped key refers to, or null. Used to target runtime commands. */
function channelKeyOf(key) {
  const parsed = parseKey(key);
  return parsed.ok && parsed.kind === "channel" ? parsed.channelKey : null;
}

module.exports = {
  CHANNEL_FIELDS,
  MAX_KEY_LENGTH,
  MAX_VALUE_BYTES,
  parseKey,
  isValidKey,
  validateValue,
  channelKeyOf
};
