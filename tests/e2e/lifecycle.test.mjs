// Every fake-adapter fixture script driven through the whole lifecycle via the server API. This is v0's CI gate (spec §1).
import { test } from "node:test"; import assert from "node:assert/strict";
import { worldWithMoon } from "../fixtures/world.mjs";
import { launchMoon } from "../../dist/server/commands/launch.js"; import { inspectMoon } from "../../dist/server/commands/review.js"; import { dockMoon } from "../../dist/server/commands/dock.js";
import { replyMoon, dropMoon } from "../../dist/server/commands/park.js"; import { rebuild, dumpProjections } from "../../dist/db/rebuild.js";

const settle = (w) => { const b = dumpProjections(w.g.db); rebuild(w.g.db); assert.equal(dumpProjections(w.g.db), b, "rebuild byte-equal"); };

test("e2e happy → merged", async () => { const w = await worldWithMoon("happy"); await launchMoon(w.g, { taskId: "T1" }); await inspectMoon(w.g, { taskId: "T1" }); assert.equal(dockMoon(w.g, { taskId: "T1" }).moonStatus, "merged"); settle(w); w.cleanup(); });
test("e2e scope violation → adrift → reply → merged", async () => { const w = await worldWithMoon("scope-violation"); assert.equal((await launchMoon(w.g, { taskId: "T1" })).moonStatus, "adrift"); replyMoon(w.g, { taskId: "T1", note: "stay in scope" }); assert.equal((await launchMoon(w.g, { taskId: "T1" })).moonStatus, "audited"); await inspectMoon(w.g, { taskId: "T1" }); assert.equal(dockMoon(w.g, { taskId: "T1" }).moonStatus, "merged"); settle(w); w.cleanup(); });
test("e2e rate-limited → adrift → drop → barren", async () => { const w = await worldWithMoon("rate-limited"); assert.equal((await launchMoon(w.g, { taskId: "T1" })).moonStatus, "adrift"); const { moonId } = dropMoon(w.g, { taskId: "T1" }); assert.equal(w.g.db.get("moons.byId", { id: moonId }).body_status, "barren"); settle(w); w.cleanup(); });
test("e2e crash → adrift", async () => { const w = await worldWithMoon("crash-midrun"); assert.equal((await launchMoon(w.g, { taskId: "T1" })).moonStatus, "adrift"); settle(w); w.cleanup(); });
test("e2e fix round → merged at round 2", async () => { const w = await worldWithMoon("fix-round"); await launchMoon(w.g, { taskId: "T1" }); assert.equal((await inspectMoon(w.g, { taskId: "T1", reviewScript: "review-fix" })).moonStatus, "audited"); assert.equal((await launchMoon(w.g, { taskId: "T1" })).moonStatus, "audited"); await inspectMoon(w.g, { taskId: "T1" }); assert.equal(dockMoon(w.g, { taskId: "T1" }).moonStatus, "merged"); assert.equal(w.g.db.get("moons.byTask", { task_id: "T1" }).round, 2); settle(w); w.cleanup(); });
test("e2e max rounds → adrift", async () => { const w = await worldWithMoon("fix-round", (c) => { c.roles = { implement: ["fake"], review: ["fake"] }; c.automation = { level: "manual", max_fix_rounds: 1 }; }); await launchMoon(w.g, { taskId: "T1" }); assert.equal((await inspectMoon(w.g, { taskId: "T1", reviewScript: "review-fix" })).moonStatus, "adrift"); settle(w); w.cleanup(); });
test("e2e reject → quarantined → reply → merged", async () => { const w = await worldWithMoon("happy"); await launchMoon(w.g, { taskId: "T1" }); assert.equal((await inspectMoon(w.g, { taskId: "T1", reviewScript: "review-reject" })).moonStatus, "quarantined"); replyMoon(w.g, { taskId: "T1", note: "it is fine, re-run" }); await launchMoon(w.g, { taskId: "T1" }); await inspectMoon(w.g, { taskId: "T1" }); assert.equal(dockMoon(w.g, { taskId: "T1" }).moonStatus, "merged"); settle(w); w.cleanup(); });

// C1: history is keyed by task, not by body. A dropped task's voyages/verdicts/events must not leak into the next task on the same moon.
test("drop → assign another spec to the freed body → happy → merged", async () => {
  const { writeSpec, read } = await import("../helpers.mjs"); const { assignMoon } = await import("../../dist/server/commands/assign.js");
  const w = await worldWithMoon("fix-round");
  const jobs = []; const real = w.g.adapters.fake;
  w.g.adapters.fake = { ...real, dispatch: (job, ctx) => { jobs.push(job); return real.dispatch(job, ctx); } };
  await launchMoon(w.g, { taskId: "T1" }); await inspectMoon(w.g, { taskId: "T1", reviewScript: "review-fix" });
  await launchMoon(w.g, { taskId: "T1" }); assert.equal((await inspectMoon(w.g, { taskId: "T1", reviewScript: "review-reject" })).moonStatus, "quarantined");
  const { moonId: m1 } = dropMoon(w.g, { taskId: "T1" });
  const spec = writeSpec(w.dir, "T2", read("tests/fixtures/specs/good-basic.md")); w.git("add", "-A"); w.git("commit", "-qm", "s2");
  const { moonId: m2 } = assignMoon(w.g, { planetId: w.planetId, specPath: spec });
  assert.equal(m2, m1, "the freed body is reused");
  jobs.length = 0;
  assert.equal((await launchMoon(w.g, { taskId: "T2" })).moonStatus, "audited");
  assert.equal(jobs[0].previousSessionId, undefined, "T2 does not resume T1's session");
  const launched = w.g.db.all("events.byTask", { task_id: "T2" }).filter((e) => e.kind === "voyage.launched").map((e) => JSON.parse(e.payload));
  assert.equal(launched[0].session_id, undefined);
  assert.equal((await inspectMoon(w.g, { taskId: "T2" })).moonStatus, "reviewing", "inspect finds T2's own holding freighter, not T1's");
  assert.equal(dockMoon(w.g, { taskId: "T2" }).moonStatus, "merged");
  assert.ok(w.g.db.all("voyages.byTask", { task_id: "T2" }).every((v) => v.task_id === "T2"));
  assert.equal(w.g.db.all("verdicts.byTask", { task_id: "T2" }).length, 1);
  settle(w); w.cleanup();
});
