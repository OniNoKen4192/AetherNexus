import { test } from "node:test";
import assert from "node:assert/strict";
import { nextMoonStatus, TransitionRefused } from "../../dist/core/transitions.js";
import { append } from "../../dist/db/events.js";
import { rebuild, dumpProjections } from "../../dist/db/rebuild.js";
import { loadMoon, moonScope } from "../../dist/server/dispatch.js";
import { repliedSincePark } from "../../dist/server/commands/delivery.js";
import { parkMoonOnly, replyMoon } from "../../dist/server/commands/park.js";
import { worldWithMoon } from "../fixtures/world.mjs";

test("moon-only park transitions include scheduler failure states and re-parks", () => {
  assert.equal(nextMoonStatus("emitted", "moon.adrift", "T1"), "adrift");
  assert.equal(nextMoonStatus("gated", "moon.adrift", "T1"), "adrift");
  assert.equal(nextMoonStatus("adrift", "moon.adrift", "T1"), "adrift");
  assert.equal(nextMoonStatus("quarantined", "moon.adrift", "T1"), "quarantined");
  assert.throws(() => nextMoonStatus("merged", "moon.adrift", "T1"), TransitionRefused);
  assert.throws(() => nextMoonStatus("dropped", "moon.adrift", "T1"), TransitionRefused);
});

test("parkMoonOnly parks an emitted moon and opens an adrift decision", async () => {
  const w = await worldWithMoon();
  try {
    parkMoonOnly(w.g, { taskId: "T1", reason: "scheduler_refused", details: "spec body changed" });
    const moon = loadMoon(w.g, "T1");
    assert.equal(moon.status, "adrift");
    assert.equal(moon.park_reason, "scheduler_refused");
    const decisions = w.g.db.all("decisions.pendingByTarget", { target_id: "T1" });
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].kind, "adrift");
    assert.match(decisions[0].reasoning, /spec body changed/);
    const before = dumpProjections(w.g.db);
    rebuild(w.g.db);
    assert.equal(dumpProjections(w.g.db), before, "rebuild is byte-equal");
  } finally { w.cleanup(); }
});

test("re-parking an adrift moon consumes its reply and opens a fresh decision", async () => {
  const w = await worldWithMoon();
  try {
    parkMoonOnly(w.g, { taskId: "T1", reason: "scheduler_refused", details: "first refusal" });
    const assignmentId = loadMoon(w.g, "T1").assignment_id;
    replyMoon(w.g, { taskId: "T1", note: "try again" });
    assert.equal(repliedSincePark(w.g, assignmentId), true);
    assert.equal(w.g.db.all("decisions.pendingByTarget", { target_id: "T1" }).length, 0);
    parkMoonOnly(w.g, { taskId: "T1", reason: "scheduler_refused", details: "second refusal" });
    assert.equal(repliedSincePark(w.g, assignmentId), false);
    assert.equal(loadMoon(w.g, "T1").status, "adrift");
    assert.equal(w.g.db.all("decisions.pendingByTarget", { target_id: "T1" }).length, 1);
    const before = dumpProjections(w.g.db);
    rebuild(w.g.db);
    assert.equal(dumpProjections(w.g.db), before, "rebuild is byte-equal");
  } finally { w.cleanup(); }
});

test("scheduler.acted and config.changed append without projecting state", async () => {
  const w = await worldWithMoon();
  try {
    const before = dumpProjections(w.g.db);
    const moon = loadMoon(w.g, "T1");
    append(w.g.db, { kind: "scheduler.acted", ...moonScope(w.g, moon), payload: { action: "send", task_id: "T1", rung: "roundabout" } });
    append(w.g.db, { kind: "config.changed", payload: { key: "automation.level", from: "manual", to: "verdicts", pid: 1 } });
    assert.equal(dumpProjections(w.g.db), before, "no state is projected");
    rebuild(w.g.db);
    assert.equal(dumpProjections(w.g.db), before, "rebuild is byte-equal");
  } finally { w.cleanup(); }
});
