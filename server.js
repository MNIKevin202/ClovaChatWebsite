const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 4173);
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const LICENSES_FILE = path.join(DATA_DIR, "licenses.json");
const SESSION_COOKIE = "clovachat_session";
const SESSION_DAYS = 7;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const LICENSE_CODE_LENGTH = 62;
const LICENSE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

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

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, JSON.stringify({ users: [] }, null, 2));
  }
  if (!fs.existsSync(LICENSES_FILE)) {
    fs.writeFileSync(LICENSES_FILE, JSON.stringify({ licenses: [] }, null, 2));
  }
}

function readUsers() {
  ensureDataDir();
  try {
    const data = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
    return Array.isArray(data.users) ? data.users : [];
  } catch {
    return [];
  }
}

function writeUsers(users) {
  ensureDataDir();
  fs.writeFileSync(USERS_FILE, JSON.stringify({ users }, null, 2));
}

function readLicenses() {
  ensureDataDir();
  try {
    const data = JSON.parse(fs.readFileSync(LICENSES_FILE, "utf8"));
    return Array.isArray(data.licenses) ? data.licenses : [];
  } catch {
    return [];
  }
}

function writeLicenses(licenses) {
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

function licenseJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...licenseCorsHeaders(),
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store"
  });
  res.end(payload);
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

function adminExists() {
  return readUsers().some((user) => user.role === "admin");
}

function bootstrapAdminFromEnv() {
  const username = normalizeUsername(process.env.ADMIN_USERNAME);
  const password = String(process.env.ADMIN_PASSWORD || "");
  if (!username || !password || adminExists()) return;
  const validationError = validateCredentials(username, password);
  if (validationError) {
    console.warn(`Admin bootstrap skipped: ${validationError}`);
    return;
  }
  const passwordParts = hashPassword(password);
  const users = readUsers();
  users.push({
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    passwordHash: passwordParts.hash,
    passwordSalt: passwordParts.salt,
    role: "admin",
    username
  });
  writeUsers(users);
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

async function handleApi(req, res, pathname) {
  if (pathname === "/api/licenses/activate" && req.method === "OPTIONS") {
    res.writeHead(204, licenseCorsHeaders());
    res.end();
    return;
  }

  if (pathname === "/api/auth/status" && req.method === "GET") {
    const session = readSession(req);
    return json(res, 200, {
      authenticated: Boolean(session),
      user: session ? { role: session.role, username: session.username } : null
    });
  }

  if (pathname === "/api/auth/register" && req.method === "POST") {
    const body = await readBody(req);
    const username = normalizeUsername(body.username);
    const password = String(body.password || "");
    const validationError = validateCredentials(username, password);
    if (validationError) return json(res, 400, { error: validationError });
    const users = readUsers();
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
    writeUsers(users);
    setSessionCookie(res, createSession(user));
    return json(res, 201, { user: { role: user.role, username: user.username } });
  }

  if (pathname === "/api/auth/login" && req.method === "POST") {
    const body = await readBody(req);
    const username = normalizeUsername(body.username);
    const password = String(body.password || "");
    const user = readUsers().find((candidate) => candidate.username === username);
    if (!user || !verifyPassword(password, user)) {
      return json(res, 401, { error: "Invalid username or password." });
    }
    setSessionCookie(res, createSession(user));
    return json(res, 200, { user: { role: user.role, username: user.username } });
  }

  if (pathname === "/api/auth/logout" && req.method === "POST") {
    clearSessionCookie(res);
    return json(res, 200, { ok: true });
  }

  if (pathname === "/api/admin/me" && req.method === "GET") {
    const session = requireAdmin(req, res);
    if (!session) return;
    return json(res, 200, { user: { role: session.role, username: session.username } });
  }

  if (pathname === "/api/admin/licenses" && req.method === "GET") {
    if (!requireAdmin(req, res)) return;
    const licenses = readLicenses()
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map(publicLicense);
    return json(res, 200, { licenses });
  }

  if (pathname === "/api/admin/licenses" && req.method === "POST") {
    const session = requireAdmin(req, res);
    if (!session) return;
    const body = await readBody(req);
    const validationError = validateLicenseInput(body);
    if (validationError) return json(res, 400, { error: validationError });

    const licenses = readLicenses();
    const createdAt = new Date();
    const type = String(body.type).trim();
    const durationAmount = type === "trial" ? Number(body.durationAmount) : null;
    const durationUnit = type === "trial" ? String(body.durationUnit).trim() : "";
    const expiresAt = type === "trial"
      ? addDuration(createdAt, durationAmount, durationUnit).toISOString()
      : null;
    const license = {
      activatedAt: null,
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
    writeLicenses(licenses);
    return json(res, 201, { license: publicLicense(license) });
  }

  const revokeMatch = pathname.match(/^\/api\/admin\/licenses\/([^/]+)\/revoke$/);
  if (revokeMatch && req.method === "POST") {
    const session = requireAdmin(req, res);
    if (!session) return;
    const licenses = readLicenses();
    const license = licenses.find((candidate) => candidate.id === revokeMatch[1]);
    if (!license) return json(res, 404, { error: "License not found." });
    license.revokedAt ||= new Date().toISOString();
    license.revokedBy = session.username;
    writeLicenses(licenses);
    return json(res, 200, { license: publicLicense(license) });
  }

  if (pathname === "/api/licenses/activate" && req.method === "POST") {
    const body = await readBody(req);
    const code = normalizeLicenseCode(body.code);
    const deviceId = String(body.deviceId || "").trim();
    if (code.length !== LICENSE_CODE_LENGTH) return licenseJson(res, 400, { error: "Invalid license code." });
    if (!validateDeviceId(deviceId)) return licenseJson(res, 400, { error: "Invalid device identifier." });

    const licenses = readLicenses();
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
      writeLicenses(licenses);
    }
    return licenseJson(res, 200, {
      license: {
        activatedAt: license.activatedAt,
        code: license.code,
        deviceId: license.deviceId,
        expiresAt: license.expiresAt || null,
        status: licenseStatus(license),
        tier: "premium",
        type: license.type
      }
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

ensureDataDir();
bootstrapAdminFromEnv();
server.listen(PORT, () => {
  console.log(`ClovaChat website listening on ${PORT}`);
});
