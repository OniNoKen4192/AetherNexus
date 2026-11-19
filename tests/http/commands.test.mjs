import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createVoyageRunner } from "../../dist/server/http/runner.js";
import { errorResponse } from "../../dist/server/http/commands.js";
import { Refusal } from "../../dist/server/errors.js";
import { sendDelivery } from "../../dist/server/commands/delivery.js";
import { sendCustoms } from "../../dist/server/commands/customs.js";
import { rebuild, dumpProjections } from "../../dist/db/rebuild.js";
import { append } from "../../dist/db/events.js";
import { loadMoon, moonScope } from "../../dist/server/dispatch.js";
import { writeSpec } from "../helpers.mjs";
import { rawRequest, readFeed, startWorld } from "./helpers.mjs";

const waitFor = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() >= end) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

test("delivery.send answers 202 while owned by the server and completes on the feed", async () => {
  const x = await startWorld("slow");
  const feed = readFeed(x.srv);
  try {
    assert.equal(await feed.status, 200);
    const launched = await x.api("/api/commands/delivery.send", { method: "POST", body: { taskId: "T1" } });
    assert.equal(launched.status, 202);
    assert.equal(typeof launched.json.voyageId, "string");
    const row = x.w.g.db.get("voyages.byId", { id: launched.json.voyageId });
    assert.match(row.status, /^(launched|working)$/);
    const detail = await x.api("/api/moons/T1");
    assert.equal(detail.status, 200);
    assert.equal(detail.json.voyages.at(-1).owner, "server");
    assert.deepEqual(detail.json.actions, ["cancel"]);
    await feed.waitFor((events) => events.some((event) => event.kind === "voyage.audited"));
    await waitFor(() => x.w.g.db.get("voyages.byId", { id: launched.json.voyageId }).status === "holding");
  } finally { feed.close(); await x.close(); }
});

test("launch refusal has no flight and simultaneous launches make one voyage", async () => {
  const x = await startWorld("slow");
  try {
    const [a, b] = await Promise.all([
      x.api("/api/commands/delivery.send", { method: "POST", body: { taskId: "T1" } }),
      x.api("/api/commands/delivery.send", { method: "POST", body: { taskId: "T1" } }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [202, 409]);
    const assignmentId = x.w.g.db.get("moons.byId", { id: x.w.moonId }).assignment_id;
    assert.equal(x.w.g.db.all("voyages.byAssignment", { assignment_id: assignmentId }).length, 1);
    const launch = a.status === 202 ? a : b;
    await x.api("/api/commands/voyage.cancel", { method: "POST", body: { voyageId: launch.json.voyageId } });
    await waitFor(() => x.w.g.db.get("voyages.byId", { id: launch.json.voyageId }).status === "adrift");
    const again = await x.api("/api/commands/delivery.send", { method: "POST", body: { taskId: "T1" } });
    assert.equal(again.status, 409);
  } finally { await x.close(); }
});

test("voyage.cancel parks as interrupted and unknown cancellation is refused", async () => {
  const x = await startWorld("slow");
  try {
    const launch = await x.api("/api/commands/delivery.send", { method: "POST", body: { taskId: "T1" } });
    const cancel = await x.api("/api/commands/voyage.cancel", { method: "POST", body: { voyageId: launch.json.voyageId } });
    assert.equal(cancel.status, 200);
    assert.deepEqual(cancel.json.result, { cancelled: true });
    await waitFor(() => x.w.g.db.get("voyages.byId", { id: launch.json.voyageId }).status === "adrift");
    assert.equal(x.w.g.db.get("moons.byId", { id: x.w.moonId }).park_reason, "interrupted");
    assert.equal((await x.api("/api/commands/voyage.cancel", { method: "POST", body: { voyageId: "missing" } })).status, 409);
  } finally { await x.close(); }
});

test("malformed command requests are rejected without events and server stays healthy", async () => {
  const x = await startWorld();
  try {
    const before = x.w.g.db.get("events.maxId")?.id ?? 0;
    const auth = { cookie: `nexus_token=${x.srv.token}`, origin: x.origin };
    const cases = [
      ["/api/commands/delivery.send", "{", 400],
      ["/api/commands/delivery.send", "[]", 400],
      ["/api/commands/delivery.send", '"x"', 400],
      ["/api/commands/nope", "{}", 404],
      ["/api/commands/delivery.send", "{}", 400],
      ["/api/commands/delivery.send", '{"taskId":5}', 400],
      ["/api/commands/delivery.send", '{"taskId":""}', 400],
      ["/api/commands/delivery.send", '{"taskId":"T1","extra":1}', 400],
      ["/api/commands/config.roles", '{"role":"bogus","order":[]}', 400],
      ["/api/commands/decision.answer", '{"decisionId":"1","answer":"mine"}', 400],
    ];
    for (const [p, body, status] of cases) {
      const response = await rawRequest(x.srv.port, { method: "POST", path: p, headers: { ...auth, "content-type": "application/json" }, body });
      assert.equal(response.status, status, `${p}: ${body}`);
    }
    assert.equal((await rawRequest(x.srv.port, { method: "POST", path: "/api/commands/delivery.send", headers: { ...auth, "content-type": "text/plain" }, body: "{}" })).status, 415);
    assert.equal((await rawRequest(x.srv.port, { method: "POST", path: "/api/commands/delivery.send", headers: { ...auth, "content-type": "application/json" }, body: `{"taskId":"${"x".repeat(2 * 1024 * 1024)}"}` })).status, 413);
    assert.equal((await x.api("/api/ping")).status, 200);
    assert.notEqual((await rawRequest(x.srv.port, { path: "//[x", headers: auth })).status, 500);
    assert.equal(x.w.g.db.get("events.maxId")?.id ?? 0, before);
  } finally { await x.close(); }
});

test("unknown command names inherited from Object.prototype answer 404", async () => {
  const x = await startWorld();
  try {
    const before = x.w.g.db.get("events.maxId")?.id ?? 0;
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
      for (const body of [{}, { taskId: "T1" }]) {
        const response = await x.api(`/api/commands/${name}`, { method: "POST", body });
        assert.equal(response.status, 404, `${name}: ${JSON.stringify(body)}`);
      }
    }
    assert.equal(x.w.g.db.get("events.maxId")?.id ?? 0, before);
    assert.equal((await x.api("/api/ping")).status, 200);
  } finally { await x.close(); }
});

test("delivery.send on an audited moon answers 409 with the refusal and leaves nothing in flight", async () => {
  const x = await startWorld("happy");
  try {
    const first = await x.api("/api/commands/delivery.send", { method: "POST", body: { taskId: "T1" } });
    assert.equal(first.status, 202);
    await waitFor(() => x.w.g.db.get("moons.byTask", { task_id: "T1" }).status === "audited");
    const second = await x.api("/api/commands/delivery.send", { method: "POST", body: { taskId: "T1" } });
    assert.equal(second.status, 409);
    assert.match(second.json.error, /is 'audited'/);
    assert.deepEqual(x.w.g.db.all("voyages.inFlight"), []);
  } finally { await x.close(); }
});

test("each synchronous command maps success to 200 and a refusal to 409", async () => {
  const x = await startWorld("slow");
  let launched;
  try {
    const systemBody = { slug: "two", title: "Two", brief: "second system" };
    const moonBody = { planetId: x.w.planetId, specPath: writeSpec(x.w.dir, "T2") };
    const rows = [
      {
        name: "system.create", success: () => systemBody, refusal: () => systemBody,
        check(result) {
          assert.match(result.systemId, /^S-\d{8}-two$/);
          assert.equal(typeof result.baseSha, "string");
          assert.equal(typeof result.planets, "number");
          assert.equal(typeof result.moons, "number");
        },
      },
      {
        name: "planet.assign",
        success: () => ({ systemId: x.w.systemId, streamId: "P2", mission: "m", territory: ["src/**"] }),
        refusal: () => ({ systemId: "nope", streamId: "P2", mission: "m", territory: ["src/**"] }),
        check(result) {
          assert.equal(typeof result.planetId, "string");
          assert.equal(typeof result.branch, "string");
          assert.equal(typeof result.worktree, "string");
          assert.equal(typeof result.discovered, "boolean");
        },
      },
      {
        name: "moon.assign", success: () => moonBody, refusal: () => moonBody,
        check(result) {
          assert.equal(typeof result.moonId, "string");
          assert.deepEqual({ taskId: result.taskId, discovered: result.discovered, attention: result.attention }, { taskId: "T2", discovered: false, attention: {} });
        },
      },
      {
        name: "moon.park",
        async before() {
          // A voyage owned by a dead process: moon.park refuses a voyage this server's runner is tracking.
          const moon = loadMoon(x.w.g, "T1"), scope = moonScope(x.w.g, moon);
          const ship = x.w.g.db.all("ships.all").find((s) => s.class === "freighter");
          append(x.w.g.db, { kind: "moon.gated", ...scope, payload: { baseline_sha: "x" } });
          append(x.w.g.db, { kind: "voyage.launched", ...scope, voyage_id: "stale-v", ship_id: ship.id, provider: "fake",
            payload: { role: "implement", round: 0, provider: "fake", ship_id: ship.id, worktree: "x", owner_pid: 2147483646 } });
        },
        success: () => ({ taskId: "T1", reason: "gone" }), refusal: () => ({ taskId: "T1", reason: "gone" }),
        check(result) { assert.deepEqual(result, { voyageId: "stale-v", reason: "stale:gone" }); },
      },
      {
        name: "moon.reply", success: () => ({ taskId: "T1", note: "carry on" }), refusal: () => ({ taskId: "T2", note: "x" }),
        check(result) { assert.deepEqual(result, { round: 1 }); },
      },
      {
        name: "delivery.cancel", success: () => ({ taskId: "T1" }), refusal: () => ({ taskId: "T1" }),
        check(result) { assert.deepEqual(result, { moonId: x.w.moonId }); },
      },
      {
        name: "fleet.retire",
        success: () => ({ shipId: x.w.g.db.all("ships.all").find((ship) => ship.status === "idle").id, reason: "done" }),
        refusal: (_result, body) => body,
        check(result) { assert.deepEqual(result, { retired: true }); },
      },
      {
        name: "config.roles", success: () => ({ role: "review", order: ["fake"] }), refusal: () => ({ role: "review", order: ["nope"] }),
        check(result) { assert.deepEqual(result, { roles: { implement: ["fake"], review: ["fake"] } }); },
      },
    ];
    for (const row of rows) {
      await row.before?.();
      const successBody = row.success();
      const success = await x.api(`/api/commands/${row.name}`, { method: "POST", body: successBody });
      assert.equal(success.status, 200, `${row.name} success`);
      row.check(success.json.result);
      const refusal = await x.api(`/api/commands/${row.name}`, { method: "POST", body: row.refusal(success.json.result, successBody) });
      assert.equal(refusal.status, 409, `${row.name} refusal`);
      assert.equal(typeof refusal.json.error, "string");
    }
  } finally { await x.close(); }
});

test("moon.assign rejects relative and absolute paths outside the repository", async () => {
  const x = await startWorld();
  try {
    for (const specPath of ["../outside.md", path.resolve(path.parse(x.w.dir).root, "outside.md")]) {
      const response = await x.api("/api/commands/moon.assign", { method: "POST", body: { planetId: x.w.planetId, specPath } });
      assert.equal(response.status, 400);
    }
  } finally { await x.close(); }
});

test("runner records post-launch failures, notifies, drains, and refuses starts after shutdown", async () => {
  let notifications = 0;
  const runner = createVoyageRunner({ onFailure: () => { notifications++; } });
  const answer = await runner.start("T1", async ({ onLaunched }) => {
    onLaunched("v1");
    await new Promise((resolve) => setTimeout(resolve, 10));
    throw new Error("after launch");
  });
  assert.deepEqual(answer, { launched: true, voyageId: "v1" });
  await waitFor(() => runner.inFlight() === 0);
  assert.equal(notifications, 1);
  assert.equal(runner.failures().length, 1);
  assert.deepEqual({ ...runner.failures()[0], ts: "ignored" }, { ts: "ignored", taskId: "T1", voyageId: "v1", message: "after launch" });
  await runner.abortAll();
  await assert.rejects(runner.start("T2", async () => undefined), /server is shutting down/);
  await runner.abortAll();
});

test("abortAll aborts and awaits a start that has not launched yet", async () => {
  let notified = 0;
  const runner = createVoyageRunner({ onFailure: () => { notified++; } });
  let signal;
  let settled = false;
  const started = runner.start("T1", async ({ signal: runSignal, onLaunched }) => {
    signal = runSignal;
    await new Promise((resolve) => setTimeout(resolve, 50));
    onLaunched("v1");
    await new Promise((resolve) => setTimeout(resolve, 50));
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await runner.abortAll();
  assert.equal(signal.aborted, true);
  assert.equal(settled, true);
  assert.deepEqual(await started, { launched: true, voyageId: "v1" });
  assert.equal(runner.inFlight(), 0);
  await assert.rejects(runner.start("T2", async () => undefined), /server is shutting down/);

  const rejecting = createVoyageRunner({ onFailure: () => { notified++; } });
  assert.deepEqual(await rejecting.start("T3", async ({ onLaunched }) => {
    onLaunched("v2");
    throw Object.create(null);
  }), { launched: true, voyageId: "v2" });
  await waitFor(() => rejecting.inFlight() === 0);
  assert.equal(rejecting.failures().length, 1);
  assert.equal(typeof rejecting.failures()[0].message, "string");
  assert.equal(notified, 1);
  await rejecting.abortAll();
});

test("unexpected errors are hidden and Refusal details map to 409", () => {
  assert.deepEqual(errorResponse(new Error("C:\\secret\\file.ts")), { status: 500, body: { error: "internal error" } });
  assert.deepEqual(errorResponse(new Refusal("no", { state: "bad" })), { status: 409, body: { error: "no", details: { state: "bad" } } });
});

test("cargo.dock twice merges exactly once and refuses the duplicate", async () => {
  const x = await startWorld("happy");
  try {
    await sendDelivery(x.w.g, { taskId: "T1", provider: "fake" });
    await sendCustoms(x.w.g, { taskId: "T1", provider: "fake" });
    const first = await x.api("/api/commands/cargo.dock", { method: "POST", body: { taskId: "T1" } });
    const second = await x.api("/api/commands/cargo.dock", { method: "POST", body: { taskId: "T1" } });
    assert.equal(first.status, 200);
    assert.equal(second.status, 409);
    const branch = x.w.g.db.get("planets.byId", { id: x.w.planetId }).branch;
    assert.equal(x.w.git("log", "--merges", "--oneline", branch).split(/\r?\n/).filter(Boolean).length, 1);
  } finally { await x.close(); }
});

test("decision.answer twice resolves once and then refuses", async () => {
  const x = await startWorld("happy");
  const real = x.w.g.adapters.fake;
  x.w.g.adapters.fake = { ...real, dispatch(job, ctx) { fs.writeFileSync(path.join(x.w.dir, "stray.txt"), "x\n"); return real.dispatch(job, ctx); } };
  try {
    await sendDelivery(x.w.g, { taskId: "T1" });
    const decision = x.w.g.db.all("decisions.pending").find((d) => d.kind === "main_tree_changed");
    assert.ok(decision);
    const body = { decisionId: decision.id, answer: "mine" };
    assert.equal((await x.api("/api/commands/decision.answer", { method: "POST", body })).status, 200);
    assert.equal((await x.api("/api/commands/decision.answer", { method: "POST", body })).status, 409);
  } finally { await x.close(); }
});

test("a post-launch HTTP failure appears in snapshot and notifies the feed", async () => {
  const x = await startWorld("happy");
  const feed = readFeed(x.srv);
  const originalRun = x.w.g.db.run;
  let moonTransitions = 0;
  x.w.g.db.run = (name, params) => {
    if (name === "voyages.setReturned" && ++moonTransitions === 1) throw new Error("injected after launch");
    return originalRun(name, params);
  };
  try {
    assert.equal(await feed.status, 200);
    const launch = await x.api("/api/commands/delivery.send", { method: "POST", body: { taskId: "T1" } });
    assert.equal(launch.status, 202);
    const snap = await waitFor(async () => {
      const response = await x.api("/api/snapshot");
      return response.json.failures.length ? response.json : undefined;
    });
    await waitFor(() => feed.server > 0);
    assert.equal(snap.failures[0].taskId, "T1");
    assert.equal(snap.failures[0].voyageId, launch.json.voyageId);
    assert.match(snap.failures[0].message, /injected after launch/);
    x.w.g.db.run = originalRun;
    const detail = await x.api("/api/moons/T1");
    assert.deepEqual(detail.json.actions, ["park_stale"]);
    assert.equal((await x.api("/api/commands/moon.park", { method: "POST", body: { taskId: "T1", reason: "orphaned" } })).status, 200);
    assert.deepEqual(x.w.g.db.all("voyages.inFlight"), []);
  } finally {
    x.w.g.db.run = originalRun;
    feed.close();
    await x.close();
  }
});

test("closing a server parks its voyage, leaves every ship consistent, and projections rebuild exactly", async () => {
  const x = await startWorld("slow");
  try {
    const launch = await x.api("/api/commands/delivery.send", { method: "POST", body: { taskId: "T1" } });
    assert.equal(launch.status, 202);
    await x.srv.close();
    const voyage = x.w.g.db.get("voyages.byId", { id: launch.json.voyageId });
    assert.equal(voyage.status, "adrift");
    assert.equal(x.w.g.db.get("moons.byId", { id: x.w.moonId }).park_reason, "interrupted");
    assert.deepEqual(x.w.g.db.all("voyages.inFlight"), []);
    for (const ship of x.w.g.db.all("ships.all")) assert.equal(ship.status, ship.id === voyage.ship_id ? "adrift" : "idle");
    const before = dumpProjections(x.w.g.db);
    rebuild(x.w.g.db);
    assert.equal(dumpProjections(x.w.g.db), before);
  } finally { await x.close(); }
});

test("moon.park refuses while this server runs the voyage, and the voyage keeps running", async () => {
  const x = await startWorld("slow");
  try {
    const launch = await x.api("/api/commands/delivery.send", { method: "POST", body: { taskId: "T1" } });
    assert.equal(launch.status, 202);
    const park = await x.api("/api/commands/moon.park", { method: "POST", body: { taskId: "T1", reason: "nope" } });
    assert.equal(park.status, 409);
    assert.match(park.json.error, /cancel/);
    const voyage = x.w.g.db.get("voyages.byId", { id: launch.json.voyageId });
    assert.ok(["launched", "working"].includes(voyage.status));
    assert.deepEqual((await x.api("/api/moons/T1")).json.actions, ["cancel"]);
  } finally { await x.close(); }
});

test("an oversized body is answered only after it has been read to the end", async () => {
  // Answering while the client is still sending makes the server close under the client's writes; on some
  // platforms the client then sees a connection reset instead of the 413.
  const net = await import("node:net");
  const x = await startWorld();
  const socket = net.connect(x.srv.port, "127.0.0.1");
  try {
    let received = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { received += chunk; });
    socket.on("error", () => { /* the assertions below report what was received */ });
    await new Promise((resolve) => socket.once("connect", resolve));
    const total = 2 * 1024 * 1024;
    socket.write(`POST /api/commands/delivery.send HTTP/1.1\r\nhost: 127.0.0.1:${x.srv.port}\r\ncookie: nexus_token=${x.srv.token}\r\norigin: ${x.origin}\r\ncontent-type: application/json\r\ncontent-length: ${total}\r\nconnection: close\r\n\r\n`);
    socket.write("x".repeat(total - 1024));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(received, "", "nothing is answered while the body is still arriving");
    socket.write("x".repeat(1024));
    await new Promise((resolve) => socket.once("close", resolve));
    assert.match(received, /^HTTP\/1\.1 413 /);
    assert.equal((await x.api("/api/ping")).status, 200);
  } finally { socket.destroy(); await x.close(); }
});
