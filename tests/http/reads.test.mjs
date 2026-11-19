import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startWorld } from "./helpers.mjs";
import { read } from "../helpers.mjs";
import { idleShip } from "../fixtures/world.mjs";
import { append } from "../../dist/db/events.js";
import { assignMoon } from "../../dist/server/commands/assign.js";
import { sendDelivery, repliedSincePark } from "../../dist/server/commands/delivery.js";
import { sendCustoms } from "../../dist/server/commands/customs.js";
import { dockCargo } from "../../dist/server/commands/dock.js";
import { replyMoon, cancelDelivery, parkStaleMoon } from "../../dist/server/commands/park.js";
import { availableActions } from "../../dist/server/commands/query.js";
import { loadMoon, moonScope } from "../../dist/server/dispatch.js";

const maxId = (w) => w.g.db.get("events.maxId").id;

test("snapshot contains the complete fresh galaxy and only unassigned valid and invalid specs", async () => {
  const x = await startWorld();
  try {
    const good = read("tests/fixtures/specs/good-basic.md").replace("**Task ID**: T1", "**Task ID**: T2");
    fs.writeFileSync(path.join(x.w.g.paths.specs, "T2.md"), good);
    fs.writeFileSync(path.join(x.w.g.paths.specs, "broken.md"), "not a spec\n");
    fs.writeFileSync(path.join(x.w.g.paths.specs, "empty.md"), good.replace("**Task ID**: T2", "**Task ID**: T3").replace(/^\|\s*`[^`]+`.*$/gm, ""));
    const before = maxId(x.w); const r = await x.api("/api/snapshot");
    assert.equal(r.status, 200); assert.equal(r.json.cursor, before); assert.equal(r.json.rung, "manual");
    assert.equal(r.json.limits.in_flight, 0); assert.deepEqual(r.json.roles, x.w.g.config.roles);
    assert.ok(r.json.systems[0].planets.length > 1); assert.ok(r.json.systems[0].planets.every((p) => Array.isArray(p.moons)));
    assert.ok(r.json.systems[0].planets.some((p) => p.body_status === "barren"));
    assert.ok(r.json.systems[0].planets.some((p) => p.moons.some((m) => m.body_status === "barren")));
    assert.equal(r.json.specs.some((s) => s.taskId === "T1"), false);
    assert.deepEqual(r.json.specs.find((s) => s.taskId === "T2").touch, ["src/lib/thing.js", "src/lib/thing.test.js"]);
    assert.ok(r.json.specs.find((s) => s.path.endsWith("broken.md")).error);
    assert.ok(r.json.specs.find((s) => s.path.endsWith("empty.md")).error);
    assert.equal(maxId(x.w), before, "snapshot appended an event");
  } finally { await x.close(); }
});

test("stale voyage ownership drives park_stale and disappears after parking", async () => {
  const x = await startWorld();
  try {
    const moon = loadMoon(x.w.g, "T1"), scope = moonScope(x.w.g, moon);
    const ship = idleShip(x.w.g.db);
    append(x.w.g.db, { kind: "moon.gated", ...scope, payload: { baseline_sha: "x" } });
    append(x.w.g.db, { kind: "voyage.launched", ...scope, voyage_id: "stale-v", ship_id: ship.id, provider: "fake",
      payload: { role: "implement", round: 0, provider: "fake", ship_id: ship.id, worktree: "x", owner_pid: 2147483646 } });
    let r = await x.api("/api/snapshot");
    assert.equal(r.json.limits.in_flight, 1); assert.equal(r.json.voyages.find((v) => v.id === "stale-v").owner, "stale");
    assert.deepEqual(availableActions(x.w.g, "T1", { ownPid: process.pid }), ["park_stale"]);
    const detail = await x.api("/api/moons/T1");
    assert.deepEqual(detail.json.actions, ["park_stale"]); assert.equal(detail.json.voyages.find((v) => v.id === "stale-v").owner, "stale");
    parkStaleMoon(x.w.g, { taskId: "T1", reason: "dead" });
    r = await x.api("/api/snapshot"); assert.equal(r.json.limits.in_flight, 0);
    assert.equal(r.json.voyages.find((v) => v.id === "stale-v").owner, null);
  } finally { await x.close(); }
});

test("available actions follow launch, approve, dock and command refusals", async () => {
  const x = await startWorld();
  try {
    const actions = () => availableActions(x.w.g, "T1", { ownPid: process.pid });
    assert.deepEqual(actions(), ["send"]); await assert.rejects(sendCustoms(x.w.g, { taskId: "T1" })); assert.throws(() => dockCargo(x.w.g, { taskId: "T1" }));
    await sendDelivery(x.w.g, { taskId: "T1" }); assert.deepEqual(actions(), ["inspect"]); await assert.rejects(sendDelivery(x.w.g, { taskId: "T1" })); assert.throws(() => dockCargo(x.w.g, { taskId: "T1" }));
    await sendCustoms(x.w.g, { taskId: "T1", reviewScript: "review-approve" }); assert.deepEqual(actions(), ["dock"]); await assert.rejects(sendCustoms(x.w.g, { taskId: "T1" })); await assert.rejects(sendDelivery(x.w.g, { taskId: "T1" }));
    dockCargo(x.w.g, { taskId: "T1" }); assert.deepEqual(actions(), []); await assert.rejects(sendDelivery(x.w.g, { taskId: "T1" })); await assert.rejects(sendCustoms(x.w.g, { taskId: "T1" })); assert.throws(() => dockCargo(x.w.g, { taskId: "T1" }));
  } finally { await x.close(); }
});

test("FIX round returns to inspect before approval and dock", async () => {
  const x = await startWorld("fix-round");
  try {
    const actions = () => availableActions(x.w.g, "T1", { ownPid: process.pid });
    const apiActions = async () => (await x.api("/api/moons/T1")).json.actions;
    await sendDelivery(x.w.g, { taskId: "T1" });
    await sendCustoms(x.w.g, { taskId: "T1", reviewScript: "review-fix" });
    assert.deepEqual(actions(), ["send"]); assert.deepEqual(await apiActions(), ["send"]);
    await sendDelivery(x.w.g, { taskId: "T1" });
    assert.deepEqual(actions(), ["inspect"]); assert.deepEqual(await apiActions(), ["inspect"]);
    await sendCustoms(x.w.g, { taskId: "T1" });
    assert.deepEqual(actions(), ["dock"]); assert.deepEqual(await apiActions(), ["dock"]);
    dockCargo(x.w.g, { taskId: "T1" });
  } finally { await x.close(); }
});

test("REJECT reply and FIX expose exactly the accepted actions", async () => {
  const reject = await startWorld();
  try {
    await sendDelivery(reject.w.g, { taskId: "T1" }); await sendCustoms(reject.w.g, { taskId: "T1", reviewScript: "review-reject" });
    assert.deepEqual(availableActions(reject.w.g, "T1", { ownPid: process.pid }), ["reply", "cancel_delivery"]);
    replyMoon(reject.w.g, { taskId: "T1", note: "again" }); assert.equal(repliedSincePark(reject.w.g, loadMoon(reject.w.g, "T1").assignment_id), true);
    assert.deepEqual(availableActions(reject.w.g, "T1", { ownPid: process.pid }), ["reply", "cancel_delivery", "send"]);
  } finally { await reject.close(); }
  const fix = await startWorld();
  try {
    await sendDelivery(fix.w.g, { taskId: "T1" }); await sendCustoms(fix.w.g, { taskId: "T1", reviewScript: "review-fix" });
    assert.deepEqual(availableActions(fix.w.g, "T1", { ownPid: process.pid }), ["send"]);
  } finally { await fix.close(); }
});

test("a pending main_tree_changed decision takes priority on an audited moon", async () => {
  const x = await startWorld();
  try {
    await sendDelivery(x.w.g, { taskId: "T1" });
    const moon = loadMoon(x.w.g, "T1"), scope = moonScope(x.w.g, moon);
    append(x.w.g.db, { kind: "decision.opened", ...scope, payload: { kind: "main_tree_changed", target_kind: "moon", target_id: "T1", reasoning: "changed" } });
    assert.deepEqual(availableActions(x.w.g, "T1", { ownPid: process.pid }), ["answer"]);
  } finally { await x.close(); }
});

test("moon detail is assignment-scoped, validates suffixes, and both reads append nothing", async () => {
  const x = await startWorld();
  try {
    const spec = fs.readFileSync(path.join(x.w.dir, ".nexus/specs/T1.md"), "utf8");
    await sendDelivery(x.w.g, { taskId: "T1" }); await sendCustoms(x.w.g, { taskId: "T1", reviewScript: "review-reject" }); cancelDelivery(x.w.g, { taskId: "T1" });
    const old = maxId(x.w); assignMoon(x.w.g, { planetId: x.w.planetId, specPath: ".nexus/specs/T1.md" }); const assigned = maxId(x.w);
    const r = await x.api("/api/moons/T1"); assert.equal(r.status, 200); assert.equal(r.json.spec, spec);
    assert.deepEqual(r.json.voyages, []); assert.deepEqual(r.json.verdicts, []); assert.ok(r.json.events.every((e) => e.id > old));
    const missing = await x.api("/api/moons/nope"); assert.equal(missing.status, 404); assert.equal(missing.json.error, "no moon is assigned task 'nope'");
    assert.equal((await x.api("/api/moons/")).status, 404); assert.equal((await x.api("/api/moons/a/b")).status, 404);
    await x.api("/api/snapshot"); assert.equal(maxId(x.w), assigned, "read routes appended an event");
  } finally { await x.close(); }
});

test("a reviewing moon whose implement voyage is docked (a crashed dock) still offers dock", async () => {
  const x = await startWorld();
  try {
    await sendDelivery(x.w.g, { taskId: "T1" });
    await sendCustoms(x.w.g, { taskId: "T1", reviewScript: "review-approve" });
    const moon = loadMoon(x.w.g, "T1"), scope = moonScope(x.w.g, moon);
    const voyage = x.w.g.db.get("voyages.latestByAssignmentRole", { assignment_id: moon.assignment_id, role: "implement" });
    append(x.w.g.db, { kind: "voyage.departed", ...scope, voyage_id: voyage.id, ship_id: voyage.ship_id, payload: {} });
    append(x.w.g.db, { kind: "voyage.docked", ...scope, voyage_id: voyage.id, ship_id: voyage.ship_id, payload: { merge_sha: "x", planet_branch: "x" } });
    assert.equal(x.w.g.db.get("voyages.byId", { id: voyage.id }).status, "docked");
    assert.equal(loadMoon(x.w.g, "T1").status, "reviewing");
    assert.deepEqual(availableActions(x.w.g, "T1", { ownPid: process.pid }), ["dock"]);
  } finally { await x.close(); }
});

test("fuel: snapshot and moon detail expose matching pool holds", async () => {
  const x = await startWorld("happy", (c) => {
    c.providers.fake.pool = { kind: "window", reserve_floor: 0.1 };
    c.roles = { implement: ["fake"], review: ["fake"] };
  });
  try {
    const until = new Date(Date.now() + 3_600_000).toISOString();
    append(x.w.g.db, { kind: "fuel.reading", provider: "fake", payload: { window: "5h", used: 0.95, resets_at: until, source: "reported" } });
    const snapshot = await x.api("/api/snapshot"), detail = await x.api("/api/moons/T1");
    assert.equal(snapshot.status, 200); assert.equal(detail.status, 200);
    assert.equal(snapshot.json.pools.length, 1); assert.equal(snapshot.json.pools[0].provider, "fake");
    const assigned = snapshot.json.systems.flatMap((s) => s.planets).flatMap((p) => p.moons).filter((m) => m.task_id !== null);
    assert.ok(assigned.length > 0); assert.ok(assigned.every((m) => Object.hasOwn(m, "waiting_on_fuel") && Object.hasOwn(m, "can_refuel")));
    const moon = assigned.find((m) => m.task_id === "T1"), wait = { provider: "fake", reason: "low", until };
    assert.deepEqual(moon.waiting_on_fuel, wait); assert.equal(moon.can_refuel, null);
    assert.deepEqual(detail.json.moon.waiting_on_fuel, wait); assert.equal(detail.json.moon.can_refuel, null);
  } finally { await x.close(); }
});

test("fuel: reads append nothing with current reading and exhaustion events", async () => {
  const x = await startWorld("happy", (c) => {
    c.providers.fake.pool = { kind: "window", reserve_floor: 0.1 };
    c.roles = { implement: ["fake"], review: ["fake"] };
  });
  try {
    append(x.w.g.db, { kind: "fuel.reading", provider: "fake", payload: { window: "5h", used: 0.95, resets_at: new Date(Date.now() + 3_600_000).toISOString(), source: "reported" } });
    append(x.w.g.db, { kind: "fuel.exhausted", provider: "fake", payload: { until: new Date(Date.now() + 3_600_000).toISOString(), voyage_id: "prior" } });
    const before = maxId(x.w);
    assert.equal((await x.api("/api/snapshot")).status, 200); assert.equal(maxId(x.w), before);
    assert.equal((await x.api("/api/moons/T1")).status, 200); assert.equal(maxId(x.w), before);
  } finally { await x.close(); }
});
