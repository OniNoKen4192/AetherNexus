import { test } from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs"; import path from "node:path";
import { worldWithMoon } from "../fixtures/world.mjs";
import { launchMoon } from "../../dist/server/commands/launch.js"; import { inspectMoon } from "../../dist/server/commands/review.js";
import { replyMoon, dropMoon, retireShip } from "../../dist/server/commands/park.js"; import { status, events, fleet } from "../../dist/server/commands/query.js";

test("reply: amendment appended, decision resolved, ship released; relaunch allowed; without reply relaunch refused", async () => {
  const w = await worldWithMoon("scope-violation"); await launchMoon(w.g, { taskId: "T1", provider: "fake" });
  await assert.rejects(launchMoon(w.g, { taskId: "T1", provider: "fake" }), /adrift.*reply/);
  const r = replyMoon(w.g, { taskId: "T1", note: "only touch src/lib" }); assert.equal(r.round, 2);
  assert.match(fs.readFileSync(path.join(w.dir, ".nexus", "specs", "T1.md"), "utf8"), /### A2 .* human: only touch src\/lib/);
  assert.equal(w.g.db.all("decisions.pending").length, 0); assert.ok(w.g.db.all("ships.all").every((s) => s.status === "idle"));
  // the fake adapter's default pick for "scope-violation" at round >= 2 is "happy" (same rule as fix-round)
  const l2 = await launchMoon(w.g, { taskId: "T1", provider: "fake" }); assert.equal(l2.moonStatus, "audited");
  assert.equal(w.g.db.get("moons.byTask", { task_id: "T1" }).round, 2); w.cleanup();
});
test("reply after a review-voyage park: freighter voyage superseded, both ships released, relaunch works", async () => {
  const w = await worldWithMoon("happy"); await launchMoon(w.g, { taskId: "T1", provider: "fake" }); await inspectMoon(w.g, { taskId: "T1", provider: "fake", reviewScript: "review-rate-limited" });
  assert.equal(w.g.db.get("moons.byTask", { task_id: "T1" }).status, "adrift");
  replyMoon(w.g, { taskId: "T1", note: "retry" });
  assert.ok(w.g.db.all("voyages.byMoon", { moon_id: w.moonId }).every((v) => v.status === "superseded"));
  assert.ok(w.g.db.all("ships.all").every((s) => s.status === "idle"));
  const l2 = await launchMoon(w.g, { taskId: "T1", provider: "fake" }); assert.equal(l2.moonStatus, "audited"); w.cleanup();
});
test("drop: moon dropped then barren again, branch and worktree gone, ship idle", async () => {
  const w = await worldWithMoon("happy"); await launchMoon(w.g, { taskId: "T1", provider: "fake" }); await inspectMoon(w.g, { taskId: "T1", provider: "fake", reviewScript: "review-reject" });
  const r = dropMoon(w.g, { taskId: "T1" }); const m = w.g.db.get("moons.byId", { id: r.moonId });
  assert.equal(m.body_status, "barren"); assert.equal(m.task_id, null); assert.equal(w.g.git.branchExists("nexus/T1"), false);
  assert.equal(w.g.db.all("decisions.pending").length, 0);
  assert.equal(fs.existsSync(path.join(w.dir, ".nexus", "worktrees", "T1")), false); assert.ok(w.g.db.all("ships.all").every((s) => s.status === "idle")); w.cleanup();
});
test("reply/drop refuse a moon that is not parked", async () => {
  const w = await worldWithMoon("happy");
  assert.throws(() => replyMoon(w.g, { taskId: "T1", note: "x" }), /only an adrift or quarantined/);
  assert.throws(() => dropMoon(w.g, { taskId: "T1" }), /only an adrift or quarantined/); w.cleanup();
});
test("retire: idle only; retired ships are not picked", async () => {
  const w = await worldWithMoon("happy"); const ships = fleet(w.g).filter((s) => s.class === "freighter" && s.fleet === "fake");
  for (const s of ships) retireShip(w.g, { shipId: s.id, reason: "test" });
  await assert.rejects(launchMoon(w.g, { taskId: "T1", provider: "fake" }), /all freighters/);
  assert.throws(() => retireShip(w.g, { shipId: ships[0].id, reason: "again" }), /not idle/); w.cleanup();
});
test("status/events/fleet shapes", async () => {
  const w = await worldWithMoon("happy"); await launchMoon(w.g, { taskId: "T1", provider: "fake" });
  const s = status(w.g, w.systemId); assert.equal(s.moons.length, 1); assert.ok(s.moons.every((m) => m.task_id)); assert.equal(s.voyages.length, 1);
  const ev = events(w.g, { moon: w.moonId }); assert.ok(ev.length > 5); assert.ok(ev.every((e) => typeof e.payload === "object"));
  assert.ok(events(w.g, { since: ev.at(-1).id }).length === 0); w.cleanup();
});
