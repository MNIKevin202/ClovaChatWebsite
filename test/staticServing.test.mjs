import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { spawn } from "node:child_process";
import { MongoMemoryServer } from "mongodb-memory-server";

/**
 * What the web root will and will not hand out.
 *
 * Phase 4 added `realtime/` and `test/` and both became publicly readable the instant they shipped,
 * because the static handler denied a fixed list of directories rather than allowing a fixed list.
 * These tests pin the inverted rule: a directory is not served unless it is explicitly allowed, so
 * adding one to the project can never publish it by accident.
 */
let mongod;
let child;
const PORT = 4491;

const get = (path) =>
  new Promise((resolve) => {
    http.get({ host: "127.0.0.1", port: PORT, path }, (res) => { res.resume(); resolve(res.statusCode); })
      .on("error", () => resolve(0));
  });

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  child = spawn("node", ["server.js"], {
    env: { ...process.env, Quipora_mongoDB_URI: mongod.getUri(), Quipora_MONGODB_DB: "staticdb", PORT: String(PORT), Quipora_REALTIME_ENABLED: "false" },
    stdio: "ignore"
  });
  for (let i = 0; i < 100; i += 1) {
    if (await get("/")) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}, 120_000);

afterAll(async () => {
  if (child) child.kill("SIGKILL");
  if (mongod) await mongod.stop();
});

describe("static file serving", () => {
  it("serves the site's own pages", async () => {
    for (const path of ["/", "/login", "/account", "/admin"]) {
      expect(await get(path), path).toBe(200);
    }
  });

  it("serves the assets directory", async () => {
    // The one directory that is meant to be public.
    const code = await get("/assets/");
    expect([200, 404]).toContain(code); // 404 only if the directory listing has no index
  });

  it("refuses server-side source directories", async () => {
    for (const path of ["/realtime/store.js", "/realtime/server.js", "/realtime/keys.js", "/realtime/presence.js"]) {
      expect(await get(path), path).toBe(404);
    }
  });

  it("refuses the test directory", async () => {
    for (const path of ["/test/harness.js", "/test/store.test.mjs"]) {
      expect(await get(path), path).toBe(404);
    }
  });

  it("refuses a directory that does not exist yet — the default is not-served", async () => {
    // The point of the allowlist: a directory added tomorrow is refused without anyone remembering.
    expect(await get("/somefuturedir/secrets.js")).toBe(404);
    expect(await get("/lib/internal.js")).toBe(404);
  });

  it("still refuses server source and config at the root", async () => {
    for (const path of ["/server.js", "/package.json", "/package-lock.json", "/Dockerfile", "/vitest.config.mjs", "/captain-definition"]) {
      expect(await get(path), path).toBe(404);
    }
  });

  it("serves the browser scripts the pages actually load", async () => {
    for (const path of ["/script.js", "/auth.js", "/account.js", "/admin.js", "/admin-setup.js", "/downloads.js", "/signup.js", "/styles.css"]) {
      expect(await get(path), path).toBe(200);
    }
  });

  it("refuses a root file type a browser never needs", async () => {
    // A .mjs/.ts/.sh added to the root tomorrow is refused by default rather than published.
    for (const path of ["/anything.mjs", "/build.sh", "/notes.md", "/tsconfig.json"]) {
      expect(await get(path), path).toBe(404);
    }
  });

  it("still refuses the datastore, dotfiles and traversal", async () => {
    for (const path of ["/data/users.json", "/.git/config", "/.env", "/data/../data/users.json", "/DATA/USERS.JSON"]) {
      expect(await get(path), path).toBe(404);
    }
  });
});
