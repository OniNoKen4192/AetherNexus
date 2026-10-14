import { test } from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs"; import path from "node:path";
import { worldWithMoon } from "../fixtures/world.mjs";
import { launchMoon } from "../../dist/server/commands/launch.js"; import { inspectMoon } from "../../dist/server/commands/review.js"; import { dockMoon } from "../../dist/server/commands/dock.js";
import { rebuild, dumpProjections } from "../../dist/db/rebuild.js"; import { append } from "../../dist/db/events.js";

async function approved(script = "happy") {
  const w = await worldWithMoon(script); await launchMoon(w.g, { taskId: "T1", provider: "fake" }); await inspectMoon(w.g, { taskId: "T1", provider: "fake" }); return w;
}

test("dock: commit in worktree, merge --no-ff into planet, moon merged + settled, ship idle, worktree removed, main untouched; rebuild equal", async () => {
  const w = await approved();
  const r = dockMoon(w.g, { taskId: "T1" });
  assert.equal(r.moonStatus, "merged"); assert.equal(w.git("rev-parse", r.planetBranch), r.mergeSha);
  assert.equal(w.git("log", "-1", "--format=%P", r.planetBranch).split(" ").length, 2, "merge commit has two parents");
  assert.match(w.git("show", `${r.planetBranch}:src/lib/thing.js`), /thing = 2/);
  assert.equal(w.git("rev-parse", "--abbrev-ref", "HEAD"), "main"); assert.equal(w.git("status", "--porcelain"), "");
  const m = w.g.db.get("moons.byTask", { task_id: "T1" }); assert.equal(m.body_status, "settled");
  assert.equal(fs.existsSync(path.join(w.dir, ".nexus", "worktrees", "T1")), false);
  assert.equal(w.g.git.branchExists("nexus/T1"), true, "the merged task branch is kept");
  assert.ok(w.g.db.all("ships.all").every((s) => s.status === "idle"));
  assert.ok(w.g.db.all("events.byMoon", { moon_id: w.moonId }).some((e) => e.kind === "voyage.event" && e.payload.includes('"merge"')), "git calls are logged as voyage events");
  const before = dumpProjections(w.g.db); rebuild(w.g.db); assert.equal(dumpProjections(w.g.db), before); w.cleanup();
});

test("dock is idempotent after a crash between merge and event (check-before-act)", async () => {
  const w = await approved();
  // simulate: commit + departed happened, merge happened, but voyage.docked was never written
  const planet = w.g.db.get("planets.byId", { id: w.planetId }); const wt = path.join(w.dir, ".nexus", "worktrees", "T1");
  w.g.git.commitAll(wt, "T1", { name: "implement/fake", email: "nexus@local" });
  const v = w.g.db.get("voyages.latestByMoonRole", { moon_id: w.moonId, role: "implement" });
  append(w.g.db, { kind: "voyage.departed", moon_id: w.moonId, voyage_id: v.id, payload: {} });
  w.g.git.mergeNoFF(path.join(w.dir, planet.worktree), "nexus/T1", "manual merge");
  const r = dockMoon(w.g, { taskId: "T1" });          // must not try to merge again
  assert.equal(r.moonStatus, "merged"); assert.equal(w.git("log", "--merges", "--oneline", planet.branch).split(/\r?\n/).filter(Boolean).length, 1, "exactly one merge commit"); w.cleanup();
});

test("Review Focus #4: planet worktree deleted by hand → recreated from the planet branch, dock proceeds", async () => {
  const w = await approved();
  const planet = w.g.db.get("planets.byId", { id: w.planetId }); fs.rmSync(path.join(w.dir, planet.worktree), { recursive: true, force: true }); w.git("worktree", "prune");
  const r = dockMoon(w.g, { taskId: "T1" }); assert.equal(r.moonStatus, "merged"); w.cleanup();
});

test("merge conflict parks the voyage and keeps the worktree", async () => {
  const w = await approved();
  const planet = w.g.db.get("planets.byId", { id: w.planetId }); const pw = path.join(w.dir, planet.worktree);
  fs.writeFileSync(path.join(pw, "src", "lib", "thing.js"), "export const thing = 99;\n"); w.g.git.commitAll(pw, "conflicting planet edit", { name: "x", email: "x@x" });
  const r = dockMoon(w.g, { taskId: "T1" });
  assert.equal(r.moonStatus, "adrift"); assert.equal(r.mergeSha, null); assert.equal(w.g.db.get("moons.byTask", { task_id: "T1" }).park_reason, "merge_conflict");
  assert.ok(fs.existsSync(path.join(w.dir, ".nexus", "worktrees", "T1"))); w.cleanup();
});
test("dock refuses before APPROVE", async () => {
  const w = await worldWithMoon("happy"); await launchMoon(w.g, { taskId: "T1", provider: "fake" });
  assert.throws(() => dockMoon(w.g, { taskId: "T1" }), /is 'audited'/); w.cleanup();
});
