const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { MongoClient } = require("mongodb");
const QRCode = require("qrcode");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 4173);
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const LICENSES_FILE = path.join(DATA_DIR, "licenses.json");
const MONGODB_URI = process.env.mongoDB_URI || process.env.MONGODB_URI || process.env.MONGO_URI || "";
const MONGODB_DB = process.env.MONGODB_DB || "clovachat";
const SESSION_COOKIE = "clovachat_session";
const SESSION_DAYS = 7;
const APP_TOKEN_DAYS = 30;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const LICENSE_CODE_LENGTH = 62;
const LICENSE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const TOTP_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const TOTP_ISSUER = "ClovaChat";

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp"
};

let mongoDb = null;

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, JSON.stringify({ users: [] }, null, 2));
  }
  if (!fs.existsSync(LICENSES_FILE)) {
    fs.writeFileSync(LICENSES_FILE, JSON.stringify({ licenses: [] }, null, 2));
  }
}

async function initStorage() {
  if (!MONGODB_URI) {
    ensureDataDir();
    console.log(`Using JSON data storage at ${DATA_DIR}`);
    return;
  }

  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  mongoDb = client.db(MONGODB_DB);
  await mongoDb.collection("users").createIndex({ username: 1 }, { unique: true });
  await mongoDb.collection("users").createIndex(
    { role: 1 },
    { unique: true, partialFilterExpression: { role: "admin" } }
  );
  await mongoDb.collection("licenses").createIndex({ code: 1 }, { unique: true });
  console.log(`Using MongoDB data storage: ${MONGODB_DB}`);
}

async function readUsers() {
  if (mongoDb) {
    return mongoDb.collection("users").find({}, { projection: { _id: 0 } }).toArray();
  }
  ensureDataDir();
  try {
    const data = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
    return Array.isArray(data.users) ? data.users : [];
  } catch {
    return [];
  }
}

async function writeUsers(users) {
  if (mongoDb) {
    const collection = mongoDb.collection("users");
    await collection.deleteMany({});
    if (users.length) await collection.insertMany(users, { ordered: true });
    return;
  }
  ensureDataDir();
  fs.writeFileSync(USERS_FILE, JSON.stringify({ users }, null, 2));
}

async function readLicenses() {
  if (mongoDb) {
    return mongoDb.collection("licenses").find({}, { projection: { _id: 0 } }).toArray();
  }
  ensureDataDir();
  try {
    const data = JSON.parse(fs.readFileSync(LICENSES_FILE, "utf8"));
    return Array.isArray(data.licenses) ? data.licenses : [];
  } catch {
    return [];
  }
}

async function writeLicenses(licenses) {
  if (mongoDb) {
    const collection = mongoDb.collection("licenses");
    await collection.deleteMany({});
    if (licenses.length) await collection.insertMany(licenses, { ordered: true });
    return;
  }
  ensureDataDir();
  fs.writeFileSync(LICENSES_FILE, JSON.stringify({ licenses }, null, 2));
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store"
  });
  res.end(payload);
}

function licenseCorsHeaders() {
  return {
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Origin": "*"
  };
}

function appCorsHeaders() {
  return {
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Origin": "*"
  };
}

function corsJson(res, status, body, headers) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...headers,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store"
  });
  res.end(payload);
}

function licenseJson(res, status, body) {
  return corsJson(res, status, body, licenseCorsHeaders());
}

function appJson(res, status, body) {
  return corsJson(res, status, body, appCorsHeaders());
}

function parseCookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || "")
      .split(";")
      .map((cookie) => cookie.trim())
      .filter(Boolean)
      .map((cookie) => {
        const index = cookie.indexOf("=");
        return index === -1
          ? [decodeURIComponent(cookie), ""]
          : [decodeURIComponent(cookie.slice(0, index)), decodeURIComponent(cookie.slice(index + 1))];
      })
  );
}

function sign(value) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("base64url");
}

function createSession(user) {
  const expiresAt = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  const payload = Buffer.from(JSON.stringify({
    exp: expiresAt,
    role: user.role,
    sub: user.id,
    username: user.username
  })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function createAppToken(user) {
  const expiresAt = Date.now() + APP_TOKEN_DAYS * 24 * 60 * 60 * 1000;
  const payload = Buffer.from(JSON.stringify({
    app: true,
    exp: expiresAt,
    role: user.role,
    sub: user.id,
    username: user.username
  })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function readSession(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token || !token.includes(".")) return null;
  const [payload, signature] = token.split(".");
  const expectedSignature = sign(payload);
  if (signature.length !== expectedSignature.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!session.exp || session.exp < Date.now()) return null;
    return session;
  } catch {
    return null;
  }
}

function readSignedToken(token) {
  if (!token || !token.includes(".")) return null;
  const [payload, signature] = token.split(".");
  const expectedSignature = sign(payload);
  if (signature.length !== expectedSignature.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!session.exp || session.exp < Date.now()) return null;
    return session;
  } catch {
    return null;
  }
}

function readAppSession(req) {
  const authorization = String(req.headers.authorization || "");
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  const session = readSignedToken(token);
  return session?.app ? session : null;
}

function setSessionCookie(res, token) {
  const secure = process.env.COOKIE_SECURE === "true" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 24 * 60 * 60}${secure}`
  );
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { hash, salt };
}

function verifyPassword(password, user) {
  const candidate = crypto.scryptSync(password, user.passwordSalt, 64);
  const stored = Buffer.from(user.passwordHash, "hex");
  return stored.length === candidate.length && crypto.timingSafeEqual(stored, candidate);
}

function normalizeUsername(username) {
  return String(username || "").trim().toLowerCase();
}

function generateTotpSecret() {
  const random = crypto.randomBytes(20);
  let output = "";
  let bits = 0;
  let value = 0;
  for (const byte of random) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += TOTP_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += TOTP_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function decodeBase32(secret) {
  const clean = String(secret || "").replace(/=+$/g, "").replace(/\s+/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of clean) {
    const index = TOTP_ALPHABET.indexOf(char);
    if (index < 0) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function hotp(secret, counter) {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  counterBuffer.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac("sha1", decodeBase32(secret)).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, "0");
}

function verifyTotp(secret, code, now = Date.now()) {
  const clean = String(code || "").trim();
  if (!/^\d{6}$/.test(clean) || !secret) return false;
  const counter = Math.floor(now / 1000 / 30);
  for (let offset = -1; offset <= 1; offset += 1) {
    if (hotp(secret, counter + offset) === clean) return true;
  }
  return false;
}

function totpUri(user, secret) {
  const label = encodeURIComponent(`${TOTP_ISSUER}:${user.username}`);
  const params = new URLSearchParams({
    secret,
    issuer: TOTP_ISSUER,
    algorithm: "SHA1",
    digits: "6",
    period: "30"
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

function validateCredentials(username, password) {
  if (!/^[a-z0-9_.-]{3,32}$/.test(username)) {
    return "Username must be 3-32 characters and use letters, numbers, dots, dashes, or underscores.";
  }
  if (String(password || "").length < 10) {
    return "Password must be at least 10 characters.";
  }
  return "";
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 100_000) {
        reject(new Error("Request body too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON."));
      }
    });
  });
}

async function adminExists() {
  return (await readUsers()).some((user) => user.role === "admin");
}

function publicUser(user) {
  return {
    id: user.id,
    role: user.role,
    totpEnabled: Boolean(user.totpSecret),
    username: user.username
  };
}

function publicAdminUser(user) {
  return {
    createdAt: user.createdAt,
    id: user.id,
    role: user.role,
    username: user.username
  };
}

async function bootstrapAdminFromEnv() {
  const username = normalizeUsername(process.env.ADMIN_USERNAME);
  const password = String(process.env.ADMIN_PASSWORD || "");
  if (!username || !password || await adminExists()) return;
  const validationError = validateCredentials(username, password);
  if (validationError) {
    console.warn(`Admin bootstrap skipped: ${validationError}`);
    return;
  }
  const passwordParts = hashPassword(password);
  const users = await readUsers();
  users.push({
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    passwordHash: passwordParts.hash,
    passwordSalt: passwordParts.salt,
    role: "admin",
    username
  });
  await writeUsers(users);
  console.log(`Bootstrapped admin account: ${username}`);
}

function requireAdmin(req, res) {
  const session = readSession(req);
  if (!session || session.role !== "admin") {
    json(res, 401, { error: "Login required." });
    return null;
  }
  return session;
}

function destinationForRole(role) {
  return role === "admin" ? "/admin" : "/account";
}

function generateLicenseCode() {
  let code = "";
  const random = crypto.randomBytes(LICENSE_CODE_LENGTH);
  for (const byte of random) code += LICENSE_ALPHABET[byte % LICENSE_ALPHABET.length];
  return code;
}

function uniqueLicenseCode(existingLicenses) {
  const existing = new Set(existingLicenses.map((license) => license.code));
  let code = generateLicenseCode();
  while (existing.has(code)) code = generateLicenseCode();
  return code;
}

function addDuration(startDate, amount, unit) {
  const expires = new Date(startDate.getTime());
  if (unit === "days") expires.setDate(expires.getDate() + amount);
  if (unit === "weeks") expires.setDate(expires.getDate() + amount * 7);
  if (unit === "months") expires.setMonth(expires.getMonth() + amount);
  if (unit === "years") expires.setFullYear(expires.getFullYear() + amount);
  return expires;
}

function licenseStatus(license, now = new Date()) {
  if (license.revokedAt) return "revoked";
  if (license.expiresAt && new Date(license.expiresAt).getTime() <= now.getTime()) return "expired";
  return "active";
}

function publicLicense(license) {
  return {
    activatedAt: license.activatedAt || null,
    assignedUserId: license.assignedUserId || "",
    assignedUsername: license.assignedUsername || "",
    code: license.code,
    createdAt: license.createdAt,
    deviceId: license.deviceId || "",
    durationAmount: license.durationAmount || null,
    durationUnit: license.durationUnit || "",
    expiresAt: license.expiresAt || null,
    id: license.id,
    label: license.label || "",
    notes: license.notes || "",
    revokedAt: license.revokedAt || null,
    status: licenseStatus(license),
    type: license.type
  };
}

function publicAppLicense(license, accountUsername = "") {
  return {
    activatedAt: license.activatedAt || null,
    accountUsername,
    deviceId: license.deviceId || "",
    expiresAt: license.expiresAt || null,
    source: "account",
    status: licenseStatus(license),
    tier: "premium",
    type: license.type
  };
}

function publicAdminAppLicense(user, deviceId) {
  return {
    activatedAt: new Date().toISOString(),
    accountUsername: user.username,
    deviceId,
    expiresAt: null,
    source: "account",
    status: "active",
    tier: "premium",
    type: "lifetime"
  };
}

function normalizeLicenseCode(code) {
  return String(code || "").trim();
}

function validateDeviceId(deviceId) {
  return /^[a-f0-9]{64}$/i.test(String(deviceId || ""));
}

function validateLicenseInput(body) {
  const type = String(body.type || "").trim();
  if (!["trial", "lifetime"].includes(type)) return "Choose trial or lifetime.";
  const label = String(body.label || "").trim();
  if (label.length > 80) return "Label must be 80 characters or fewer.";
  const notes = String(body.notes || "").trim();
  if (notes.length > 500) return "Notes must be 500 characters or fewer.";
  if (type === "trial") {
    const amount = Number(body.durationAmount);
    const unit = String(body.durationUnit || "").trim();
    if (!Number.isInteger(amount) || amount < 1 || amount > 1000) {
      return "Trial amount must be a whole number from 1 to 1000.";
    }
    if (!["days", "weeks", "months", "years"].includes(unit)) {
      return "Trial unit must be days, weeks, months, or years.";
    }
  }
  return "";
}

async function assignedPremiumForUser(user, deviceId, { bindDevice = false } = {}) {
  const licenses = await readLicenses();
  const candidates = licenses
    .filter((license) => licenseStatus(license) === "active")
    .filter((license) => license.assignedUserId === user.id || license.assignedUsername === user.username)
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === "lifetime" ? -1 : 1;
      return String(b.createdAt).localeCompare(String(a.createdAt));
    });

  const locked = candidates.find((license) => license.deviceId && license.deviceId !== deviceId);
  const license = candidates.find((candidate) => !candidate.deviceId || candidate.deviceId === deviceId);
  if (!license) {
    return {
      license: null,
      premiumError: locked ? "Premium is already active on another computer." : ""
    };
  }

  if (bindDevice && !license.deviceId) {
    license.deviceId = deviceId;
    license.activatedAt = new Date().toISOString();
    await writeLicenses(licenses);
  }

  return {
    license: publicAppLicense(license, user.username),
    premiumError: ""
  };
}

async function handleApi(req, res, pathname) {
  if (pathname === "/api/licenses/activate" && req.method === "OPTIONS") {
    res.writeHead(204, licenseCorsHeaders());
    res.end();
    return;
  }

  if (pathname.startsWith("/api/app/") && req.method === "OPTIONS") {
    res.writeHead(204, appCorsHeaders());
    res.end();
    return;
  }

  if (pathname === "/api/auth/status" && req.method === "GET") {
    const session = readSession(req);
    return json(res, 200, {
      authenticated: Boolean(session),
      redirectTo: session ? destinationForRole(session.role) : null,
      user: session ? publicUser(session) : null
    });
  }

  if (pathname === "/api/admin/setup-status" && req.method === "GET") {
    return json(res, 200, { available: !(await adminExists()) });
  }

  if (pathname === "/api/admin/setup" && req.method === "POST") {
    if (await adminExists()) {
      return json(res, 409, { error: "Admin setup is already complete." });
    }
    const body = await readBody(req);
    const username = normalizeUsername(body.username);
    const password = String(body.password || "");
    const validationError = validateCredentials(username, password);
    if (validationError) return json(res, 400, { error: validationError });
    const users = await readUsers();
    if (users.some((user) => user.username === username)) {
      return json(res, 409, { error: "That username is already taken." });
    }

    const passwordParts = hashPassword(password);
    const user = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      passwordHash: passwordParts.hash,
      passwordSalt: passwordParts.salt,
      role: "admin",
      username
    };
    users.push(user);
    await writeUsers(users);
    setSessionCookie(res, createSession(user));
    return json(res, 201, {
      redirectTo: destinationForRole(user.role),
      user: publicUser(user)
    });
  }

  if (pathname === "/api/auth/register" && req.method === "POST") {
    const body = await readBody(req);
    const username = normalizeUsername(body.username);
    const password = String(body.password || "");
    const validationError = validateCredentials(username, password);
    if (validationError) return json(res, 400, { error: validationError });
    const users = await readUsers();
    if (users.some((user) => user.username === username)) {
      return json(res, 409, { error: "That username is already taken." });
    }

    const passwordParts = hashPassword(password);
    const user = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      passwordHash: passwordParts.hash,
      passwordSalt: passwordParts.salt,
      role: "customer",
      username
    };
    users.push(user);
    await writeUsers(users);
    setSessionCookie(res, createSession(user));
    return json(res, 201, {
      redirectTo: destinationForRole(user.role),
      user: publicUser(user)
    });
  }

  if (pathname === "/api/auth/login" && req.method === "POST") {
    const body = await readBody(req);
    const username = normalizeUsername(body.username);
    const password = String(body.password || "");
    const verificationCode = String(body.verificationCode || "").trim();
    const user = (await readUsers()).find((candidate) => candidate.username === username);
    if (!user || !verifyPassword(password, user)) {
      return json(res, 401, { error: "Invalid username or password." });
    }
    if (user.role === "admin" && user.totpSecret && !verifyTotp(user.totpSecret, verificationCode)) {
      return json(res, 401, { error: "Enter your 6-digit authenticator code." });
    }
    setSessionCookie(res, createSession(user));
    return json(res, 200, {
      redirectTo: destinationForRole(user.role),
      user: publicUser(user)
    });
  }

  if (pathname === "/api/auth/logout" && req.method === "POST") {
    clearSessionCookie(res);
    return json(res, 200, { ok: true });
  }

  if (pathname === "/api/admin/me" && req.method === "GET") {
    const session = requireAdmin(req, res);
    if (!session) return;
    const user = (await readUsers()).find((candidate) => candidate.id === session.sub && candidate.username === session.username);
    return json(res, 200, { user: publicUser(user || session) });
  }

  if (pathname === "/api/admin/2fa/setup" && req.method === "POST") {
    const session = requireAdmin(req, res);
    if (!session) return;
    const users = await readUsers();
    const user = users.find((candidate) => candidate.id === session.sub && candidate.username === session.username);
    if (!user || user.role !== "admin") return json(res, 404, { error: "Admin account not found." });
    if (user.totpSecret) return json(res, 409, { error: "Authenticator is already enabled." });
    user.pendingTotpSecret = generateTotpSecret();
    await writeUsers(users);
    const uri = totpUri(user, user.pendingTotpSecret);
    const qrCode = await QRCode.toDataURL(uri, { margin: 1, width: 220 });
    return json(res, 200, {
      qrCode,
      secret: user.pendingTotpSecret,
      uri
    });
  }

  if (pathname === "/api/admin/2fa/verify" && req.method === "POST") {
    const session = requireAdmin(req, res);
    if (!session) return;
    const body = await readBody(req);
    const code = String(body.code || "").trim();
    const users = await readUsers();
    const user = users.find((candidate) => candidate.id === session.sub && candidate.username === session.username);
    if (!user || user.role !== "admin") return json(res, 404, { error: "Admin account not found." });
    if (user.totpSecret) return json(res, 409, { error: "Authenticator is already enabled." });
    if (!user.pendingTotpSecret) return json(res, 400, { error: "Start authenticator setup first." });
    if (!verifyTotp(user.pendingTotpSecret, code)) return json(res, 400, { error: "Invalid authenticator code." });
    user.totpSecret = user.pendingTotpSecret;
    user.totpEnabledAt = new Date().toISOString();
    delete user.pendingTotpSecret;
    await writeUsers(users);
    return json(res, 200, { user: publicUser(user) });
  }

  if (pathname === "/api/admin/licenses" && req.method === "GET") {
    if (!requireAdmin(req, res)) return;
    const licenses = (await readLicenses())
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map(publicLicense);
    return json(res, 200, { licenses });
  }

  if (pathname === "/api/admin/users" && req.method === "GET") {
    if (!requireAdmin(req, res)) return;
    const users = (await readUsers())
      .filter((user) => user.role === "customer")
      .sort((a, b) => a.username.localeCompare(b.username))
      .map(publicAdminUser);
    return json(res, 200, { users });
  }

  if (pathname === "/api/admin/licenses" && req.method === "POST") {
    const session = requireAdmin(req, res);
    if (!session) return;
    const body = await readBody(req);
    const validationError = validateLicenseInput(body);
    if (validationError) return json(res, 400, { error: validationError });

    const licenses = await readLicenses();
    const users = await readUsers();
    const assignedUsername = normalizeUsername(body.accountUsername);
    const assignedUser = assignedUsername
      ? users.find((user) => user.role === "customer" && user.username === assignedUsername)
      : null;
    if (assignedUsername && !assignedUser) {
      return json(res, 400, { error: "Assigned account was not found." });
    }
    const createdAt = new Date();
    const type = String(body.type).trim();
    const durationAmount = type === "trial" ? Number(body.durationAmount) : null;
    const durationUnit = type === "trial" ? String(body.durationUnit).trim() : "";
    const expiresAt = type === "trial"
      ? addDuration(createdAt, durationAmount, durationUnit).toISOString()
      : null;
    const license = {
      activatedAt: null,
      assignedUserId: assignedUser?.id || "",
      assignedUsername: assignedUser?.username || "",
      code: uniqueLicenseCode(licenses),
      createdAt: createdAt.toISOString(),
      createdBy: session.username,
      deviceId: "",
      durationAmount,
      durationUnit,
      expiresAt,
      id: crypto.randomUUID(),
      label: String(body.label || "").trim(),
      notes: String(body.notes || "").trim(),
      revokedAt: null,
      type
    };
    licenses.push(license);
    await writeLicenses(licenses);
    return json(res, 201, { license: publicLicense(license) });
  }

  const revokeMatch = pathname.match(/^\/api\/admin\/licenses\/([^/]+)\/revoke$/);
  if (revokeMatch && req.method === "POST") {
    const session = requireAdmin(req, res);
    if (!session) return;
    const licenses = await readLicenses();
    const license = licenses.find((candidate) => candidate.id === revokeMatch[1]);
    if (!license) return json(res, 404, { error: "License not found." });
    license.revokedAt ||= new Date().toISOString();
    license.revokedBy = session.username;
    await writeLicenses(licenses);
    return json(res, 200, { license: publicLicense(license) });
  }

  if (pathname === "/api/licenses/activate" && req.method === "POST") {
    const body = await readBody(req);
    const code = normalizeLicenseCode(body.code);
    const deviceId = String(body.deviceId || "").trim();
    if (code.length !== LICENSE_CODE_LENGTH) return licenseJson(res, 400, { error: "Invalid license code." });
    if (!validateDeviceId(deviceId)) return licenseJson(res, 400, { error: "Invalid device identifier." });

    const licenses = await readLicenses();
    const license = licenses.find((candidate) => candidate.code === code);
    if (!license) return licenseJson(res, 404, { error: "License not found." });
    const status = licenseStatus(license);
    if (status !== "active") return licenseJson(res, 403, { error: `License is ${status}.` });
    if (license.deviceId && license.deviceId !== deviceId) {
      return licenseJson(res, 403, { error: "License is already activated on another computer." });
    }
    if (!license.deviceId) {
      license.deviceId = deviceId;
      license.activatedAt = new Date().toISOString();
      await writeLicenses(licenses);
    }
    return licenseJson(res, 200, {
      license: {
        activatedAt: license.activatedAt,
        code: license.code,
        deviceId: license.deviceId,
        expiresAt: license.expiresAt || null,
        source: "code",
        status: licenseStatus(license),
        tier: "premium",
        type: license.type
      }
    });
  }

  if (pathname === "/api/app/login" && req.method === "POST") {
    const body = await readBody(req);
    const username = normalizeUsername(body.username);
    const password = String(body.password || "");
    const verificationCode = String(body.verificationCode || "").trim();
    const deviceId = String(body.deviceId || "").trim();
    if (!validateDeviceId(deviceId)) return appJson(res, 400, { error: "Invalid device identifier." });
    const user = (await readUsers()).find((candidate) => candidate.username === username);
    if (!user || !["admin", "customer"].includes(user.role) || !verifyPassword(password, user)) {
      return appJson(res, 401, { error: "Invalid username or password." });
    }
    if (user.role === "admin" && !user.totpSecret) {
      return appJson(res, 403, { error: "Set up Google Authenticator on clovachat.com before using admin login in the app." });
    }
    if (user.role === "admin" && !verifyTotp(user.totpSecret, verificationCode)) {
      return appJson(res, 401, { error: "Enter your current 6-digit authenticator code." });
    }
    if (user.role === "admin") {
      return appJson(res, 200, {
        premium: publicAdminAppLicense(user, deviceId),
        premiumError: "",
        token: createAppToken(user),
        user: publicUser(user)
      });
    }
    const premium = await assignedPremiumForUser(user, deviceId, { bindDevice: true });
    return appJson(res, 200, {
      premium: premium.license,
      premiumError: premium.premiumError,
      token: createAppToken(user),
      user: publicUser(user)
    });
  }

  if (pathname === "/api/app/account" && req.method === "GET") {
    const session = readAppSession(req);
    if (!session) return appJson(res, 401, { error: "Login required." });
    const deviceId = String(new URL(req.url, `http://${req.headers.host || "localhost"}`).searchParams.get("deviceId") || "").trim();
    if (!validateDeviceId(deviceId)) return appJson(res, 400, { error: "Invalid device identifier." });
    const user = (await readUsers()).find((candidate) => candidate.id === session.sub && candidate.username === session.username);
    if (!user || !["admin", "customer"].includes(user.role)) return appJson(res, 401, { error: "Login required." });
    if (user.role === "admin") {
      return appJson(res, 200, {
        premium: publicAdminAppLicense(user, deviceId),
        premiumError: "",
        user: publicUser(user)
      });
    }
    const premium = await assignedPremiumForUser(user, deviceId, { bindDevice: true });
    return appJson(res, 200, {
      premium: premium.license,
      premiumError: premium.premiumError,
      user: publicUser(user)
    });
  }

  return json(res, 404, { error: "Not found." });
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const isHtml = ext === ".html";
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": isHtml ? "no-cache" : "public, max-age=300, must-revalidate"
    });
    res.end(data);
  });
}

function staticPath(pathname) {
  if (pathname === "/") return path.join(ROOT, "index.html");
  if (pathname === "/login") return path.join(ROOT, "login.html");
  if (pathname === "/signup") return path.join(ROOT, "signup.html");
  if (pathname === "/account") return path.join(ROOT, "account.html");
  if (pathname === "/admin") return path.join(ROOT, "admin.html");
  if (pathname === "/admin/setup") return path.join(ROOT, "admin-setup.html");
  const decoded = decodeURIComponent(pathname);
  const filePath = path.normalize(path.join(ROOT, decoded));
  if (!filePath.startsWith(ROOT)) return null;
  return filePath;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url.pathname);
      return;
    }
    const filePath = staticPath(url.pathname);
    if (!filePath) return json(res, 400, { error: "Invalid path." });
    sendFile(res, filePath);
  } catch (error) {
    json(res, 500, { error: error.message || "Server error." });
  }
});

async function start() {
  await initStorage();
  await bootstrapAdminFromEnv();
  server.listen(PORT, () => {
    console.log(`ClovaChat website listening on ${PORT}`);
  });
}

start().catch((error) => {
  console.error("Failed to start ClovaChat website:", error);
  process.exit(1);
});
