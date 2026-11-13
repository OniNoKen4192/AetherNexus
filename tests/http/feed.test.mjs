import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { append } from "../../dist/db/events.js";
import { createFeed } from "../../dist/server/http/feed.js";
import { launchMoon } from "../../dist/server/commands/launch.js";
import { rawRequest, readFeed, startWorld } from "./helpers.mjs";

const maxId = (g) => g.db.get("events.maxId")?.id ?? 0;

async function eventually(predicate, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function addTrees(g, count) {
  g.db.transaction(() => {
    for (let i = 0; i < count; i++) g.db.run("events.insert", {
      ts: new Date().toISOString(), kind: "tree.written", system_id: null, planet_id: null, moon_id: null,
      voyage_id: null, ship_id: null, task_id: null, assignment_id: null, provider: null,
      payload: JSON.stringify({ paths: [`x${i}`] }),
    });
  });
}

async function directFeed(g, opts = {}) {
  const feed = createFeed(g, { pollMs: 20, ...opts });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    feed.handle(req, res, url.searchParams);
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  let closing;
  return {
    feed, srv: { port, token: "direct" }, server,
    close: () => closing ??= new Promise((resolve) => {
      feed.close();
      server.close(resolve);
      server.closeAllConnections();
    }),
  };
}

function runCli(cwd, args) {
  const cli = path.resolve("dist/cli/main.js");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`CLI exited ${code}: ${stderr}`)));
  });
}

test("backlog over three pages is complete and live events arrive exactly once", async () => {
  const x = await startWorld(undefined, undefined, { server: { pollMs: 20 } });
  const feed = readFeed(x.srv, { since: 0 });
  try {
    addTrees(x.w.g, 1500);
    const n = maxId(x.w.g);
    await feed.waitFor(n);
    assert.deepEqual(feed.events.map((e) => e.id), Array.from({ length: n }, (_, i) => i + 1));
    const row = append(x.w.g.db, { kind: "tree.written", payload: { paths: ["after"] } });
    await feed.waitFor(n + 1);
    assert.equal(feed.events.filter((e) => e.id === row.id).length, 1);
  } finally { feed.close(); await x.close(); }
});

test("Last-Event-ID resumes after its cursor and wins over since", async () => {
  const x = await startWorld(undefined, undefined, { server: { pollMs: 20 } });
  let feed;
  try {
    const k = maxId(x.w.g) - 2;
    feed = readFeed(x.srv, { since: 0, lastEventId: k });
    await feed.waitFor(2);
    assert.deepEqual(feed.events.map((e) => e.id), [k + 1, k + 2]);
  } finally { feed?.close(); await x.close(); }
});

test("a client without a cursor starts at the present", async () => {
  const x = await startWorld(undefined, undefined, { server: { pollMs: 20 } });
  const feed = readFeed(x.srv);
  try {
    assert.equal(await feed.status, 200); assert.deepEqual(feed.events, []);
    const row = append(x.w.g.db, { kind: "tree.written", payload: { paths: ["new"] } });
    await feed.waitFor(1); assert.equal(feed.events[0].id, row.id);
  } finally { feed.close(); await x.close(); }
});

test("an event appended by another process reaches the feed", async () => {
  const x = await startWorld(undefined, undefined, { server: { pollMs: 20 } });
  const feed = readFeed(x.srv);
  try {
    await feed.status;
    await runCli(x.w.dir, ["system", "create", "other", "--title", "t", "--brief-text", "b"]);
    await feed.waitFor((events) => events.some((e) => e.kind === "system.created" && e.payload.title === "t"));
  } finally { feed.close(); await x.close(); }
});

test("voyage activity arrives while launch is still in flight", async () => {
  const x = await startWorld("slow", undefined, { server: { pollMs: 20 } });
  const feed = readFeed(x.srv);
  let launch;
  try {
    await feed.status;
    let settled = false;
    launch = launchMoon(x.w.g, { taskId: "T1" }).finally(() => { settled = true; });
    await feed.waitFor((events) => events.some((e) => e.kind === "voyage.launched"));
    assert.equal(settled, false);
    await launch;
  } finally { feed.close(); await launch?.catch(() => {}); await x.close(); }
});

test("notify sends one server event to every connected client", async () => {
  const x = await startWorld();
  const d = await directFeed(x.w.g);
  const a = readFeed(d.srv), b = readFeed(d.srv);
  try {
    await Promise.all([a.status, b.status]); d.feed.notify();
    await eventually(() => a.server === 1 && b.server === 1);
    assert.equal(a.server, 1); assert.equal(b.server, 1);
  } finally { a.close(); b.close(); await d.close(); await x.close(); }
});

test("clients with different cursors each retain a complete ordered stream", async () => {
  const x = await startWorld(undefined, undefined, { server: { pollMs: 20 } });
  const cursor = maxId(x.w.g);
  const all = readFeed(x.srv, { since: 0 }), live = readFeed(x.srv, { since: cursor });
  try {
    await Promise.all([all.status, live.status]); addTrees(x.w.g, 20);
    await Promise.all([all.waitFor(cursor + 20), live.waitFor(20)]);
    assert.deepEqual(all.events.map((e) => e.id), Array.from({ length: cursor + 20 }, (_, i) => i + 1));
    assert.deepEqual(live.events.map((e) => e.id), Array.from({ length: 20 }, (_, i) => cursor + i + 1));
  } finally { all.close(); live.close(); await x.close(); }
});

test("a disconnected client is dropped without affecting another client", async () => {
  const x = await startWorld();
  const d = await directFeed(x.w.g);
  const gone = readFeed(d.srv), kept = readFeed(d.srv);
  try {
    await Promise.all([gone.status, kept.status]); gone.close(); await gone.closed;
    const row = append(x.w.g.db, { kind: "tree.written", payload: { paths: ["still"] } });
    d.feed.notify();
    await kept.waitFor(1); await eventually(() => kept.server === 1);
    assert.equal(kept.events[0].id, row.id);
  } finally { gone.close(); kept.close(); await d.close(); await x.close(); }
});

test("invalid cursors answer 400 with an error", async () => {
  const x = await startWorld();
  try {
    const headers = { cookie: `nexus_token=${x.srv.token}` };
    for (const p of ["/api/events?since=abc", "/api/events?since=-1"]) {
      const r = await rawRequest(x.srv.port, { path: p, headers }); assert.equal(r.status, 400); assert.equal(typeof r.json.error, "string");
    }
    const r = await rawRequest(x.srv.port, { path: "/api/events", headers: { ...headers, "last-event-id": "x" } });
    assert.equal(r.status, 400); assert.equal(typeof r.json.error, "string");
  } finally { await x.close(); }
});

test("event streams have SSE headers and remain access controlled", async () => {
  const x = await startWorld();
  const feed = readFeed(x.srv);
  try {
    assert.equal(await feed.status, 200);
    const headers = await new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: x.srv.port, path: "/api/events", headers: { cookie: `nexus_token=${x.srv.token}` } }, (res) => { resolve(res.headers); res.destroy(); });
      req.on("error", reject); req.end();
    });
    assert.match(headers["content-type"], /^text\/event-stream/); assert.equal(headers["cache-control"], "no-store");
    assert.equal((await rawRequest(x.srv.port, { path: "/api/events" })).status, 401);
  } finally { feed.close(); await x.close(); }
});

test("idle clients receive heartbeat comments", async () => {
  const x = await startWorld();
  const d = await directFeed(x.w.g, { heartbeatMs: 50 });
  let req;
  try {
    const text = await new Promise((resolve, reject) => {
      let body = "";
      req = http.request({ host: "127.0.0.1", port: d.srv.port, path: "/api/events" }, (res) => {
        res.setEncoding("utf8"); res.on("data", (chunk) => { body += chunk; if (body.includes(": hb\n\n")) resolve(body); });
      });
      req.on("error", reject); req.end();
      setTimeout(() => reject(new Error("heartbeat timed out")), 1000).unref();
    });
    assert.match(text, /: hb\n\n/);
  } finally { req?.destroy(); await d.close(); await x.close(); }
});

test("closing the server ends every open stream and resolves", async () => {
  const x = await startWorld();
  const a = readFeed(x.srv), b = readFeed(x.srv);
  try {
    await Promise.all([a.status, b.status]);
    await x.srv.close();
    await Promise.all([a.closed, b.closed]);
  } finally { a.close(); b.close(); await x.close(); }
});
