import { test } from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs"; import path from "node:path";
import { worldWithMoon } from "../fixtures/world.mjs";
import { launchMoon } from "../../dist/server/commands/launch.js"; import { inspectMoon } from "../../dist/server/commands/review.js";
import { replyMoon, dropMoon, retireShip } from "../../dist/server/commands/park.js"; import { status, events, fleet } from "../../dist/server/commands/query.js";

test("reply: amendment appended, decision resolved, ship released; relaunch allowed; without reply relaunch refused", async () => {
  const w = await worldWithMoon("scope-violation"); await launchMoon(w.g, { taskId: "T1", provider: "fake" });
  await assert.rejects(launchMoon(w.g, { taskId: "T1", provider: "fake" }), /adrift.*reply/);
  const r = replyMoon(w.g, { taskId: "T1", note: "only touch src/lib" }); assert.equal(r.round, 2);
  assert.match(fs.readFileSync(path.join(w.dir, ".nexus", "specs", "T1.md"), "utf8"), /### A1 .* human: only touch src\/lib/);
  assert.equal(w.g.db.all("decisions.pending").length, 0); assert.ok(w.g.db.all("ships.all").every((s) => s.status === "idle"));
  // the fake adapter's default pick for "scope-violation" at round >= 2 is "happy" (same rule as fix-round)
  const l2 = await launchMoon(w.g, { taskId: "T1", provider: "fake" }); assert.equal(l2.moonStatus, "audited");
  assert.equal(w.g.db.get("moons.byTask", { task_id: "T1" }).round, 2); w.cleanup();
});
test("reply after a review-voyage park: freighter voyage superseded, both ships released, relaunch works", async () => {
  const w = await worldWithMoon("happy"); await launchMoon(w.g, { taskId: "T1", provider: "fake" }); await inspectMoon(w.g, { taskId: "T1", provider: "fake", reviewScript: "review-rate-limited" });
  assert.equal(w.g.db.get("moons.byTask", { task_id: "T1" }).status, "adrift");
  replyMoon(w.g, { taskId: "T1", note: "retry" });
  assert.ok(w.g.db.all("voyages.byTask", { task_id: "T1" }).every((v) => v.status === "superseded"));
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

const wtOf = (w) => path.join(w.dir, ".nexus", "worktrees", "T1");

test("relaunch restores only the recorded violation; moon.restored is logged first", async () => {
  const w = await worldWithMoon("scope-violation"); await launchMoon(w.g, { taskId: "T1", provider: "fake" });
  replyMoon(w.g, { taskId: "T1", note: "only touch src/lib" });
  const l2 = await launchMoon(w.g, { taskId: "T1", provider: "fake" }); assert.equal(l2.moonStatus, "audited");
  const ev = events(w.g, { moon: w.moonId }); const r = ev.find((e) => e.kind === "moon.restored");
  assert.ok(r, "moon.restored event"); assert.deepEqual(r.payload.paths, { reverted: ["README.md"], deleted: [] });
  assert.ok(r.id < ev.find((e) => e.kind === "moon.gated" && e.id > r.id).id); w.cleanup();
});
test("relaunch with an extra hand-edited violation restores nothing and refuses", async () => {
  const w = await worldWithMoon("scope-violation"); await launchMoon(w.g, { taskId: "T1", provider: "fake" });
  fs.writeFileSync(path.join(wtOf(w), "src", "other.js"), "export const other = 1;\n");
  replyMoon(w.g, { taskId: "T1", note: "only touch src/lib" });
  await assert.rejects(launchMoon(w.g, { taskId: "T1", provider: "fake" }), /carryover_violations/);
  assert.ok(fs.existsSync(path.join(wtOf(w), "README.md")), "recorded violation untouched");
  assert.ok(fs.existsSync(path.join(wtOf(w), "src", "other.js")), "hand edit untouched");
  assert.ok(!events(w.g, { moon: w.moonId }).some((e) => e.kind === "moon.restored"));
  assert.equal(w.g.db.get("moons.byTask", { task_id: "T1" }).status, "adrift"); w.cleanup();
});
test("drop: a failed branch delete records nothing and can be retried", async () => {
  const w = await worldWithMoon("happy"); await launchMoon(w.g, { taskId: "T1", provider: "fake" }); await inspectMoon(w.g, { taskId: "T1", provider: "fake", reviewScript: "review-reject" });
  const other = path.join(w.dir, ".nexus", "worktrees", "other"); w.git("worktree", "add", "--force", other, "nexus/T1");
  assert.throws(() => dropMoon(w.g, { taskId: "T1" }), /nexus\/T1/);
  assert.equal(w.g.db.get("moons.byTask", { task_id: "T1" }).status, "quarantined"); assert.equal(w.g.git.branchExists("nexus/T1"), true);
  w.git("worktree", "remove", "--force", other);
  const r = dropMoon(w.g, { taskId: "T1" }); assert.equal(w.g.db.get("moons.byId", { id: r.moonId }).body_status, "barren"); w.cleanup();
});
test("a gate_failed park can be replied to and relaunched with a fresh gate", async () => {
  const w = await worldWithMoon("happy"); const planet = w.g.db.get("planets.byId", { id: w.planetId });
  w.g.git.worktreeAdd(wtOf(w), "nexus/T1", w.g.git.revParse(planet.branch)); fs.writeFileSync(path.join(wtOf(w), "junk.txt"), "x\n");
  await assert.rejects(launchMoon(w.g, { taskId: "T1", provider: "fake" }), /gate failed/);
  assert.equal(w.g.db.get("moons.byTask", { task_id: "T1" }).status, "adrift");
  replyMoon(w.g, { taskId: "T1", note: "cleaned" }); fs.rmSync(path.join(wtOf(w), "junk.txt"));
  const l = await launchMoon(w.g, { taskId: "T1", provider: "fake" }); assert.equal(l.moonStatus, "audited"); w.cleanup();
});

test("I2: moon park parks a voyage whose process is gone (stale:<reason>); refuses when nothing is in flight", async () => {
  const { parkStaleMoon } = await import("../../dist/server/commands/park.js");
  const w = await worldWithMoon("happy");
  assert.throws(() => parkStaleMoon(w.g, { taskId: "T1", reason: "x" }), /only an implementing or reviewing moon/);
  // A dispatch that never finishes on its own: the moon sits in 'implementing' as if its process had died.
  let started; const running = new Promise((res) => { started = res; });
  w.g.adapters.fake = { id: "fake", roles: ["implement", "review"], classify: () => "unknown", fuel: async () => ({ source: "unknown" }),
    async *dispatch(_job, ctx) { started(); await new Promise((res) => ctx.signal.addEventListener("abort", res, { once: true })); } };
  const ac = new AbortController(); const launch = launchMoon(w.g, { taskId: "T1", provider: "fake", signal: ac.signal });
  await running;
  assert.equal(w.g.db.get("moons.byTask", { task_id: "T1" }).status, "implementing");
  const r = parkStaleMoon(w.g, { taskId: "T1", reason: "laptop rebooted" });
  assert.equal(r.reason, "stale:laptop rebooted");
  const m = w.g.db.get("moons.byTask", { task_id: "T1" }); assert.equal(m.status, "adrift"); assert.equal(m.park_reason, "stale:laptop rebooted");
  const v = w.g.db.get("voyages.byId", { id: r.voyageId }); assert.equal(v.status, "adrift");
  assert.equal(w.g.db.get("ships.byId", { id: v.ship_id }).status, "adrift"); assert.equal(w.g.db.all("decisions.pending").length, 1);
  assert.throws(() => parkStaleMoon(w.g, { taskId: "T1", reason: "again" }), /only an implementing or reviewing moon/);
  // If the "dead" process was in fact alive, its late end must not fight the park.
  ac.abort(); const out = await launch; assert.equal(out.moonStatus, "adrift");
  assert.equal(w.g.db.get("moons.byTask", { task_id: "T1" }).park_reason, "stale:laptop rebooted");
  replyMoon(w.g, { taskId: "T1", note: "go again" });
  w.g.adapters.fake = (await import("../../dist/providers/fake/index.js")).createFakeAdapter(path.join((await import("../helpers.mjs")).repoRoot, "tests", "fixtures", "scripts"));
  assert.equal((await launchMoon(w.g, { taskId: "T1", provider: "fake" })).moonStatus, "audited", "a stale park is an ordinary park: reply + relaunch work");
  w.cleanup();
});


// A dropped assignment's gate baseline must not be mistaken for the re-assigned task's: drop removes the state file, and a
// relaunch takes the carry-over path only when the current assignment has been gated.
test("drop removes the gate baseline; same-id re-assign → gate fails → reply → clean → relaunch audits", async () => {
  const { assignMoon } = await import("../../dist/server/commands/assign.js");
  const w = await worldWithMoon("happy"); const stateFile = path.join(w.g.paths.stateDir, "T1.json");
  await launchMoon(w.g, { taskId: "T1", provider: "fake" });
  assert.equal(fs.existsSync(stateFile), true, "the first assignment's gate wrote a baseline");
  assert.equal((await inspectMoon(w.g, { taskId: "T1", provider: "fake", reviewScript: "review-reject" })).moonStatus, "quarantined");
  dropMoon(w.g, { taskId: "T1" });
  assert.equal(fs.existsSync(stateFile), false, "drop removes the dropped assignment's gate baseline");
  w.git("commit", "-qm", "retry", "--allow-empty");
  assignMoon(w.g, { planetId: w.planetId, specPath: ".nexus/specs/T1.md" });
  const moon = w.g.db.get("moons.byTask", { task_id: "T1" }); const planet = w.g.db.get("planets.byId", { id: moon.planet_id });
  const wt = path.join(w.g.paths.worktrees, "T1");
  w.g.git.worktreeAdd(wt, "nexus/T1", w.g.git.revParse(planet.branch)); fs.writeFileSync(path.join(wt, "junk.txt"), "dirt");
  await assert.rejects(launchMoon(w.g, { taskId: "T1", provider: "fake" }), /gate failed/);
  assert.equal(w.g.db.get("moons.byTask", { task_id: "T1" }).status, "adrift");
  replyMoon(w.g, { taskId: "T1", note: "cleaned" }); fs.rmSync(path.join(wt, "junk.txt"));
  assert.equal((await launchMoon(w.g, { taskId: "T1", provider: "fake" })).moonStatus, "audited");
  w.cleanup();
});

test("a stale baseline file with no gate in the current assignment is not a baseline: relaunch gates afresh", async () => {
  const w = await worldWithMoon("happy"); const stateFile = path.join(w.g.paths.stateDir, "T1.json");
  const moon = w.g.db.get("moons.byTask", { task_id: "T1" }); const planet = w.g.db.get("planets.byId", { id: moon.planet_id });
  const wt = path.join(w.g.paths.worktrees, "T1");
  w.g.git.worktreeAdd(wt, "nexus/T1", w.g.git.revParse(planet.branch)); fs.writeFileSync(path.join(wt, "junk.txt"), "dirt");
  await assert.rejects(launchMoon(w.g, { taskId: "T1", provider: "fake" }), /gate failed/);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(stateFile, "{\"stale\":true}");
  replyMoon(w.g, { taskId: "T1", note: "cleaned" }); fs.rmSync(path.join(wt, "junk.txt"));
  assert.equal((await launchMoon(w.g, { taskId: "T1", provider: "fake" })).moonStatus, "audited");
  w.cleanup();
});
