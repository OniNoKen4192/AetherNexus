import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { startWorld, rawRequest } from "./helpers.mjs";

async function withWorld(fn, ...args) {
  const x = await startWorld(...args);
  try { await fn(x); } finally { await x.close(); }
}

test("api without the cookie is 401; with it 200", () => withWorld(async ({ srv, api }) => {
  assert.equal((await rawRequest(srv.port, { path: "/api/ping" })).status, 401);
  assert.equal((await rawRequest(srv.port, { path: "/api/ping", headers: { cookie: "nexus_token=nope" } })).status, 401);
  assert.equal((await rawRequest(srv.port, { path: "/api/ping", headers: { cookie: `x_nexus_token=${srv.token}` } })).status, 401);
  const ok = await api("/api/ping");
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { ok: true });
  assert.equal(ok.headers["x-content-type-options"], "nosniff");
  assert.equal((await api("/api/nothing")).status, 404);
}));

test("a wrong Host header is 403 (api and static)", () => withWorld(async ({ srv }) => {
  const cookie = `nexus_token=${srv.token}`;
  assert.equal((await rawRequest(srv.port, { path: "/api/ping", headers: { host: "evil.example", cookie } })).status, 403);
  assert.equal((await rawRequest(srv.port, { path: "/api/ping", headers: { host: `evil.example:${srv.port}`, cookie } })).status, 403);
  assert.equal((await rawRequest(srv.port, { path: "/", headers: { host: "evil.example" } })).status, 403);
  assert.equal((await rawRequest(srv.port, { path: "/api/ping", headers: { host: `localhost:${srv.port}`, cookie } })).status, 200);
}));

test("a POST without a matching Origin is 403", () => withWorld(async ({ srv, api }) => {
  const post = (headers) => api("/api/ping", { method: "POST", body: {}, headers });
  assert.equal((await post({ origin: "http://evil.example" })).status, 403);
  assert.equal((await post({ origin: `http://127.0.0.1:${srv.port}.evil.example` })).status, 403);
  assert.equal((await post({ origin: "null" })).status, 403);
  // Origin absent: api() always sends one, so send it raw.
  const bare = await rawRequest(srv.port, { method: "POST", path: "/api/ping", headers: { cookie: `nexus_token=${srv.token}`, "content-type": "application/json" }, body: "{}" });
  assert.equal(bare.status, 403);
  // A matching Origin passes the gate (ping is GET-only, so the route answers 404 rather than 403).
  assert.equal((await post({ origin: `http://localhost:${srv.port}` })).status, 404);
}));

test("the token URL sets an HttpOnly SameSite=Strict cookie and redirects; a wrong token is 403", () => withWorld(async ({ srv }) => {
  const good = await rawRequest(srv.port, { path: `/?token=${srv.token}` });
  assert.equal(good.status, 302);
  assert.equal(good.headers.location, "/");
  assert.equal(good.headers["set-cookie"][0], `nexus_token=${srv.token}; HttpOnly; SameSite=Strict; Path=/`);
  assert.equal((await rawRequest(srv.port, { path: "/?token=wrong" })).status, 403);
  assert.equal((await rawRequest(srv.port, { path: `/?token=${srv.token}x` })).status, 403);
  assert.equal((await rawRequest(srv.port, { path: "/?token=" })).status, 403);
  // The token in the query string grants nothing on the API.
  assert.equal((await rawRequest(srv.port, { path: `/api/ping?token=${srv.token}` })).status, 401);
}));

test("static: ../ traversal is refused; missing build answers 503 with the build hint", async () => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-webouter-"));
  const webRoot = path.join(outer, "web");
  fs.mkdirSync(webRoot);
  const x = await startWorld(undefined, undefined, { webRoot });
  try {
    fs.writeFileSync(path.join(outer, "secret.txt"), "secret");
    const get = (p) => rawRequest(x.srv.port, { path: p });
    const noPage = await get("/");
    assert.equal(noPage.status, 503);
    assert.equal(noPage.text, "the page is not built — run npm run build");
    fs.writeFileSync(path.join(webRoot, "index.html"), "<h1>hi</h1>");
    fs.writeFileSync(path.join(webRoot, "app.js"), "1");
    const page = await get("/");
    assert.equal(page.status, 200);
    assert.match(page.headers["content-type"], /text\/html/);
    assert.equal(page.headers["x-content-type-options"], "nosniff");
    assert.equal((await get("/app.js")).status, 200);
    assert.equal((await get("/missing.js")).status, 404);
    for (const p of ["/../secret.txt", "/%2e%2e/secret.txt", "/%2e%2e%2fsecret.txt", "/..%2fsecret.txt", "/..%5csecret.txt", "/%2e%2e%5csecret.txt", "/..\\secret.txt", "/a/../../secret.txt", "/%00", "/app.js%00"]) {
      const r = await get(p);
      assert.ok([400, 403, 404].includes(r.status), `${p} -> ${r.status}`);
      assert.doesNotMatch(r.text, /secret/, p);
    }
    // Raw (unnormalised) request target: bypass any client-side cleanup.
    const raw = await new Promise((resolve, reject) => {
      const s = net.connect(x.srv.port, "127.0.0.1", () => s.write(`GET /../secret.txt HTTP/1.1\r\nHost: 127.0.0.1:${x.srv.port}\r\nConnection: close\r\n\r\n`));
      let out = ""; s.on("data", (d) => { out += d; }); s.on("end", () => resolve(out)); s.on("error", reject);
    });
    assert.doesNotMatch(raw, /secret/);
    assert.match(raw, /HTTP\/1.1 (403|404)/);
  } finally {
    await x.close();
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

test("a second server on the same galaxy refuses; a stale lock from a dead pid is replaced", () => withWorld(async ({ w, srv }) => {
  const { startServer } = await import("../../dist/server/http/server.js");
  const { pidAlive } = await import("../../dist/server/lock.js");
  const lockFile = path.join(w.g.paths.nexusDir, "server.json");
  const held = JSON.parse(fs.readFileSync(lockFile, "utf8"));
  assert.equal(held.pid, process.pid);
  assert.equal(held.port, srv.port);
  assert.ok(held.started);
  await assert.rejects(startServer(w.g, { port: 0 }), /already running \(pid \d+, port \d+\)/);
  assert.equal(JSON.parse(fs.readFileSync(lockFile, "utf8")).port, srv.port, "a refused start must not touch the lock");
  await srv.close();
  assert.equal(fs.existsSync(lockFile), false);
  // A dead pid: spawn a process, let it exit, reuse its pid.
  const deadPid = Number(spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout);
  assert.equal(pidAlive(deadPid), false);
  assert.equal(pidAlive(process.pid), true);
  fs.writeFileSync(lockFile, JSON.stringify({ pid: deadPid, port: 1, started: "then" }));
  const again = await startServer(w.g, { port: 0 });
  try { assert.equal(JSON.parse(fs.readFileSync(lockFile, "utf8")).pid, process.pid); } finally { await again.close(); }
  fs.writeFileSync(lockFile, "not json");
  await (await startServer(w.g, { port: 0 })).close();
}));

test("a busy port refuses with a hint and leaves no lock", () => withWorld(async ({ w, srv }) => {
  const { startServer } = await import("../../dist/server/http/server.js");
  await srv.close();
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, "127.0.0.1", r));
  const port = blocker.address().port;
  try {
    await assert.rejects(startServer(w.g, { port }), new RegExp(`port ${port} is in use — pass --port or set server.port in .nexus/config.json`));
    assert.equal(fs.existsSync(path.join(w.g.paths.nexusDir, "server.json")), false);
  } finally { await new Promise((r) => blocker.close(r)); }
}));

test("server.json does not appear in git status (even in a galaxy whose .gitignore predates it)", () => withWorld(async ({ w, srv }) => {
  const { startServer } = await import("../../dist/server/http/server.js");
  assert.match(fs.readFileSync(path.join(w.g.paths.nexusDir, ".gitignore"), "utf8"), /^server\.json$/m);
  await srv.close();
  // Old galaxy: drop the .gitignore line so only .git/info/exclude can hide the file.
  fs.writeFileSync(path.join(w.g.paths.nexusDir, ".gitignore"), "nexus.db*\nworktrees/\nstate/\n");
  w.git("add", "-A"); w.git("commit", "-qm", "old gitignore");
  const again = await startServer(w.g, { port: 0 });
  try {
    assert.ok(fs.existsSync(path.join(w.g.paths.nexusDir, "server.json")));
    assert.equal(w.git("status", "--porcelain"), "");
  } finally { await again.close(); }
}));

test("close() releases the lock and frees the port", async () => {
  const x = await startWorld();
  const lockFile = path.join(x.w.g.paths.nexusDir, "server.json");
  const port = x.srv.port;
  try {
    assert.ok(fs.existsSync(lockFile));
    await x.srv.close();
    await x.srv.close(); // idempotent
    assert.equal(fs.existsSync(lockFile), false);
    await assert.rejects(rawRequest(port, { path: "/" }), /ECONNREFUSED/);
    const probe = net.createServer();
    await new Promise((r, j) => { probe.once("error", j); probe.listen(port, "127.0.0.1", r); });
    await new Promise((r) => probe.close(r));
  } finally { await x.close(); }
});
