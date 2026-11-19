import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { append } from "../../dist/db/events.js";
import { createFeed } from "../../dist/server/http/feed.js";
import { sendDelivery } from "../../dist/server/commands/delivery.js";
import { makeGalaxy } from "../helpers.mjs";
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

async function bounded(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
    ]);
  } finally { clearTimeout(timer); }
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

test("a destroyed response stops backlog paging and does not affect the next client", async () => {
  const w = await makeGalaxy();
  const g = w.g;
  addTrees(g, 600);
  const n = maxId(g);
  let pages = 0;
  let failed;
  let destroyNext = true;
  let normal;
  const all = g.db.all;
  g.db.all = (name, params) => {
    if (name === "events.page" && ++pages > 50) throw new Error("backlog loop does not stop on a destroyed response");
    return all(name, params);
  };
  const feed = createFeed(g, { pollMs: 1000 });
  const server = http.createServer((req, res) => {
    const query = new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
    if (destroyNext) {
      destroyNext = false;
      res.destroy();
      try { feed.handle(req, res, query); } catch (error) { failed = error; }
      return;
    }
    feed.handle(req, res, query);
  });
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const port = server.address().port;
    await bounded(new Promise((resolve) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/?since=0", agent: false }, (res) => {
        res.resume(); res.once("end", resolve); res.once("close", resolve);
      });
      req.once("error", resolve);
    }), 2000, "destroyed request did not finish");
    assert.equal(failed, undefined);
    assert.ok(pages <= 2, `destroyed response issued ${pages} page queries`);

    normal = readFeed({ port, token: "direct" }, { since: 0 });
    await normal.waitFor(n);
    assert.deepEqual(normal.events.map((event) => event.id), Array.from({ length: n }, (_, i) => i + 1));
  } finally {
    normal?.close();
    feed.close();
    server.closeAllConnections();
    if (server.listening) await bounded(new Promise((resolve) => server.close(resolve)), 2000, "server close timed out");
    g.db.all = all;
    w.cleanup();
  }
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
  let child;
  let exited;
  try {
    await feed.status;
    const cli = path.resolve("dist/cli/main.js");
    child = spawn(process.execPath, [cli, "system", "create", "other", "--title", "t", "--brief-text", "b"], {
      cwd: x.w.dir, stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { stderr += chunk; });
    exited = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`CLI exited ${code}: ${stderr}`)));
    });
    await bounded(exited, 20_000, "CLI process timed out");
    await feed.waitFor((events) => events.some((e) => e.kind === "system.created" && e.payload.title === "t"));
  } finally {
    if (child?.exitCode === null && child.signalCode === null) child.kill();
    if (exited) await bounded(exited, 2000, "CLI process did not exit after kill").catch(() => {});
    feed.close(); await x.close();
  }
});

test("voyage activity arrives while launch is still in flight", async () => {
  const x = await startWorld("slow", undefined, { server: { pollMs: 20 } });
  const feed = readFeed(x.srv);
  let launch;
  try {
    await feed.status;
    let settled = false;
    launch = sendDelivery(x.w.g, { taskId: "T1" }).finally(() => { settled = true; });
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
  const x = await startWorld(undefined, undefined, { server: { pollMs: 2000 } });
  const cursor = maxId(x.w.g);
  let all;
  let live;
  try {
    addTrees(x.w.g, 3);
    await new Promise((resolve) => setImmediate(resolve));
    live = readFeed(x.srv, { since: cursor });
    await live.status;
    await live.waitFor(3);

    addTrees(x.w.g, 2);
    await new Promise((resolve) => setImmediate(resolve));
    all = readFeed(x.srv, { since: 0 });
    await all.status;
    await all.waitFor(maxId(x.w.g));

    for (let i = 0; i < 3; i++) {
      addTrees(x.w.g, 2);
      await new Promise((resolve) => setImmediate(resolve));
    }
    const last = append(x.w.g.db, { kind: "tree.written", payload: { paths: ["last"] } });
    await Promise.all([
      live.waitFor((events) => events.some((event) => event.id === last.id)),
      all.waitFor((events) => events.some((event) => event.id === last.id)),
    ]);
    assert.deepEqual(live.events.map((event) => event.id), Array.from({ length: last.id - cursor }, (_, i) => cursor + i + 1));
    assert.deepEqual(all.events.map((event) => event.id), Array.from({ length: last.id }, (_, i) => i + 1));
  } finally { all?.close(); live?.close(); await x.close(); }
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

test("feed.close ends clients and permanently stops polling", async () => {
  const w = await makeGalaxy();
  const g = w.g;
  let pages = 0;
  const all = g.db.all;
  g.db.all = (name, params) => {
    if (name === "events.page") pages++;
    return all(name, params);
  };
  const d = await directFeed(g, { pollMs: 20 });
  const a = readFeed(d.srv), b = readFeed(d.srv);
  try {
    await Promise.all([a.status, b.status]);
    const before = pages;
    d.feed.close();
    await bounded(Promise.all([a.closed, b.closed]), 2000, "feed clients did not close");

    append(g.db, { kind: "tree.written", payload: { paths: ["after-close"] } });
    await assert.rejects(eventually(() => pages > before, 150), /condition timed out/);
    assert.equal(pages, before);
    assert.doesNotThrow(() => d.feed.close());
    assert.doesNotThrow(() => d.feed.notify());
  } finally {
    a.close(); b.close();
    await d.close();
    g.db.all = all;
    w.cleanup();
  }
});
