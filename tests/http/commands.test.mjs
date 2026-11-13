import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createVoyageRunner } from "../../dist/server/http/runner.js";
import { errorResponse } from "../../dist/server/http/commands.js";
import { Refusal } from "../../dist/server/errors.js";
import { launchMoon } from "../../dist/server/commands/launch.js";
import { inspectMoon } from "../../dist/server/commands/review.js";
import { rebuild, dumpProjections } from "../../dist/db/rebuild.js";
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

test("moon.launch answers 202 while owned by the server and completes on the feed", async () => {
  const x = await startWorld("slow");
  const feed = readFeed(x.srv);
  try {
    assert.equal(await feed.status, 200);
    const launched = await x.api("/api/commands/moon.launch", { method: "POST", body: { taskId: "T1" } });
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
      x.api("/api/commands/moon.launch", { method: "POST", body: { taskId: "T1" } }),
      x.api("/api/commands/moon.launch", { method: "POST", body: { taskId: "T1" } }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [202, 409]);
    const assignmentId = x.w.g.db.get("moons.byId", { id: x.w.moonId }).assignment_id;
    assert.equal(x.w.g.db.all("voyages.byAssignment", { assignment_id: assignmentId }).length, 1);
    const launch = a.status === 202 ? a : b;
    await x.api("/api/commands/voyage.cancel", { method: "POST", body: { voyageId: launch.json.voyageId } });
    await waitFor(() => x.w.g.db.get("voyages.byId", { id: launch.json.voyageId }).status === "adrift");
    const again = await x.api("/api/commands/moon.launch", { method: "POST", body: { taskId: "T1" } });
    assert.equal(again.status, 409);
  } finally { await x.close(); }
});

test("voyage.cancel parks as interrupted and unknown cancellation is refused", async () => {
  const x = await startWorld("slow");
  try {
    const launch = await x.api("/api/commands/moon.launch", { method: "POST", body: { taskId: "T1" } });
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
      ["/api/commands/moon.launch", "{", 400],
      ["/api/commands/moon.launch", "[]", 400],
      ["/api/commands/moon.launch", '"x"', 400],
      ["/api/commands/nope", "{}", 404],
      ["/api/commands/moon.launch", "{}", 400],
      ["/api/commands/moon.launch", '{"taskId":5}', 400],
      ["/api/commands/moon.launch", '{"taskId":""}', 400],
      ["/api/commands/moon.launch", '{"taskId":"T1","extra":1}', 400],
      ["/api/commands/config.roles", '{"role":"bogus","order":[]}', 400],
      ["/api/commands/decision.answer", '{"decisionId":"1","answer":"mine"}', 400],
    ];
    for (const [p, body, status] of cases) {
      const response = await rawRequest(x.srv.port, { method: "POST", path: p, headers: { ...auth, "content-type": "application/json" }, body });
      assert.equal(response.status, status, `${p}: ${body}`);
    }
    assert.equal((await rawRequest(x.srv.port, { method: "POST", path: "/api/commands/moon.launch", headers: { ...auth, "content-type": "text/plain" }, body: "{}" })).status, 415);
    assert.equal((await rawRequest(x.srv.port, { method: "POST", path: "/api/commands/moon.launch", headers: { ...auth, "content-type": "application/json" }, body: `{"taskId":"${"x".repeat(2 * 1024 * 1024)}"}` })).status, 413);
    assert.equal((await x.api("/api/ping")).status, 200);
    assert.notEqual((await rawRequest(x.srv.port, { path: "//[x", headers: auth })).status, 500);
    assert.equal(x.w.g.db.get("events.maxId")?.id ?? 0, before);
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

test("unexpected errors are hidden and Refusal details map to 409", () => {
  assert.deepEqual(errorResponse(new Error("C:\\secret\\file.ts")), { status: 500, body: { error: "internal error" } });
  assert.deepEqual(errorResponse(new Refusal("no", { state: "bad" })), { status: 409, body: { error: "no", details: { state: "bad" } } });
});

test("voyage.dock twice merges exactly once and refuses the duplicate", async () => {
  const x = await startWorld("happy");
  try {
    await launchMoon(x.w.g, { taskId: "T1", provider: "fake" });
    await inspectMoon(x.w.g, { taskId: "T1", provider: "fake" });
    const first = await x.api("/api/commands/voyage.dock", { method: "POST", body: { taskId: "T1" } });
    const second = await x.api("/api/commands/voyage.dock", { method: "POST", body: { taskId: "T1" } });
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
    await launchMoon(x.w.g, { taskId: "T1" });
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
    if (name === "moons.setStatus" && ++moonTransitions === 3) throw new Error("injected after launch");
    return originalRun(name, params);
  };
  try {
    assert.equal(await feed.status, 200);
    const launch = await x.api("/api/commands/moon.launch", { method: "POST", body: { taskId: "T1" } });
    assert.equal(launch.status, 202);
    const snap = await waitFor(async () => {
      const response = await x.api("/api/snapshot");
      return response.json.failures.length ? response.json : undefined;
    });
    await waitFor(() => feed.server > 0);
    assert.equal(snap.failures[0].taskId, "T1");
    assert.equal(snap.failures[0].voyageId, launch.json.voyageId);
    assert.match(snap.failures[0].message, /injected after launch/);
  } finally {
    x.w.g.db.run = originalRun;
    feed.close();
    await x.close();
  }
});

test("closing a server aborts and parks its voyage and projections rebuild exactly", async () => {
  const x = await startWorld("slow");
  let cleaned = false;
  try {
    const launch = await x.api("/api/commands/moon.launch", { method: "POST", body: { taskId: "T1" } });
    assert.equal(launch.status, 202);
    await x.srv.close();
    await waitFor(() => x.w.g.db.get("voyages.byId", { id: launch.json.voyageId }).status === "adrift");
    assert.equal(x.w.g.db.get("moons.byId", { id: x.w.moonId }).park_reason, "interrupted");
    assert.ok(x.w.g.db.all("ships.all").every((ship) => ship.status === "idle" || ship.assignment_id !== null));
    const before = dumpProjections(x.w.g.db);
    rebuild(x.w.g.db);
    assert.equal(dumpProjections(x.w.g.db), before);
    x.w.cleanup(); cleaned = true;
  } finally { if (!cleaned) await x.close(); }
});
