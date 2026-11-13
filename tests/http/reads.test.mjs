import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startWorld } from "./helpers.mjs";
import { read } from "../helpers.mjs";
import { append } from "../../dist/db/events.js";
import { assignMoon } from "../../dist/server/commands/assign.js";
import { launchMoon, repliedSincePark } from "../../dist/server/commands/launch.js";
import { inspectMoon } from "../../dist/server/commands/review.js";
import { dockMoon } from "../../dist/server/commands/dock.js";
import { replyMoon, dropMoon, parkStaleMoon } from "../../dist/server/commands/park.js";
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
    const ship = x.w.g.db.all("ships.all").find((s) => s.class === "freighter");
    append(x.w.g.db, { kind: "moon.gated", ...scope, payload: { baseline_sha: "x" } });
    append(x.w.g.db, { kind: "voyage.launched", ...scope, voyage_id: "stale-v", ship_id: ship.id, provider: "fake",
      payload: { role: "implement", round: 0, provider: "fake", ship_id: ship.id, worktree: "x", owner_pid: 2147483646 } });
    let r = await x.api("/api/snapshot");
    assert.equal(r.json.limits.in_flight, 1); assert.equal(r.json.voyages.find((v) => v.id === "stale-v").owner, "stale");
    assert.deepEqual(availableActions(x.w.g, "T1", { ownPid: process.pid }), ["park_stale"]);
    parkStaleMoon(x.w.g, { taskId: "T1", reason: "dead" });
    r = await x.api("/api/snapshot"); assert.equal(r.json.limits.in_flight, 0);
    assert.equal(r.json.voyages.find((v) => v.id === "stale-v").owner, null);
  } finally { await x.close(); }
});

test("available actions follow launch, approve, dock and command refusals", async () => {
  const x = await startWorld();
  try {
    const actions = () => availableActions(x.w.g, "T1", { ownPid: process.pid });
    assert.deepEqual(actions(), ["launch"]); await assert.rejects(inspectMoon(x.w.g, { taskId: "T1" })); assert.throws(() => dockMoon(x.w.g, { taskId: "T1" }));
    await launchMoon(x.w.g, { taskId: "T1" }); assert.deepEqual(actions(), ["inspect"]); await assert.rejects(launchMoon(x.w.g, { taskId: "T1" }));
    await inspectMoon(x.w.g, { taskId: "T1", reviewScript: "review-approve" }); assert.deepEqual(actions(), ["dock"]); await assert.rejects(inspectMoon(x.w.g, { taskId: "T1" }));
    dockMoon(x.w.g, { taskId: "T1" }); assert.deepEqual(actions(), []); await assert.rejects(launchMoon(x.w.g, { taskId: "T1" }));
  } finally { await x.close(); }
});

test("REJECT reply and FIX expose exactly the accepted actions", async () => {
  const reject = await startWorld();
  try {
    await launchMoon(reject.w.g, { taskId: "T1" }); await inspectMoon(reject.w.g, { taskId: "T1", reviewScript: "review-reject" });
    assert.deepEqual(availableActions(reject.w.g, "T1", { ownPid: process.pid }), ["reply", "drop"]);
    replyMoon(reject.w.g, { taskId: "T1", note: "again" }); assert.equal(repliedSincePark(reject.w.g, loadMoon(reject.w.g, "T1").assignment_id), true);
    assert.deepEqual(availableActions(reject.w.g, "T1", { ownPid: process.pid }), ["reply", "drop", "launch"]);
  } finally { await reject.close(); }
  const fix = await startWorld();
  try {
    await launchMoon(fix.w.g, { taskId: "T1" }); await inspectMoon(fix.w.g, { taskId: "T1", reviewScript: "review-fix" });
    assert.deepEqual(availableActions(fix.w.g, "T1", { ownPid: process.pid }), ["launch"]);
  } finally { await fix.close(); }
});

test("a pending main_tree_changed decision takes priority on an audited moon", async () => {
  const x = await startWorld();
  try {
    await launchMoon(x.w.g, { taskId: "T1" });
    const moon = loadMoon(x.w.g, "T1"), scope = moonScope(x.w.g, moon);
    append(x.w.g.db, { kind: "decision.opened", ...scope, payload: { kind: "main_tree_changed", target_kind: "moon", target_id: "T1", reasoning: "changed" } });
    assert.deepEqual(availableActions(x.w.g, "T1", { ownPid: process.pid }), ["answer"]);
  } finally { await x.close(); }
});

test("moon detail is assignment-scoped, validates suffixes, and both reads append nothing", async () => {
  const x = await startWorld();
  try {
    const spec = fs.readFileSync(path.join(x.w.dir, ".nexus/specs/T1.md"), "utf8");
    await launchMoon(x.w.g, { taskId: "T1" }); await inspectMoon(x.w.g, { taskId: "T1", reviewScript: "review-reject" }); dropMoon(x.w.g, { taskId: "T1" });
    const old = maxId(x.w); assignMoon(x.w.g, { planetId: x.w.planetId, specPath: ".nexus/specs/T1.md" }); const assigned = maxId(x.w);
    const r = await x.api("/api/moons/T1"); assert.equal(r.status, 200); assert.equal(r.json.spec, spec);
    assert.deepEqual(r.json.voyages, []); assert.deepEqual(r.json.verdicts, []); assert.ok(r.json.events.every((e) => e.id > old));
    assert.equal((await x.api("/api/moons/nope")).status, 404); assert.equal((await x.api("/api/moons/")).status, 404); assert.equal((await x.api("/api/moons/a/b")).status, 404);
    await x.api("/api/snapshot"); assert.equal(maxId(x.w), assigned, "read routes appended an event");
  } finally { await x.close(); }
});
