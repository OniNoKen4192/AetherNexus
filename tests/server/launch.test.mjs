import { test } from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { writeSpec, read } from "../helpers.mjs"; import { worldWithMoon } from "../fixtures/world.mjs";
import { assignMoon } from "../../dist/server/commands/assign.js";
import { launchMoon } from "../../dist/server/commands/launch.js";
import { renderPrompt } from "../../dist/server/dispatch.js";

test("happy launch: gate → voyage events logged → audit clean → moon audited, freighter holding", async () => {
  const w = await worldWithMoon("happy"); const seen = [];
  const r = await launchMoon(w.g, { taskId: "T1", provider: "fake", onEvent: (e) => seen.push(e.kind) });
  assert.equal(r.moonStatus, "audited"); assert.equal(r.audit.verdict, "clean"); assert.deepEqual(r.audit.in_scope.sort(), ["src/lib/thing.js", "src/lib/thing.test.js"]);
  assert.deepEqual(seen, ["text", "tool_use", "file_changed", "file_changed", "usage", "done"]);
  const v = w.g.db.get("voyages.byId", { id: r.voyageId }); assert.equal(v.status, "holding"); assert.equal(v.role, "implement");
  assert.equal(w.g.db.all("events.byMoon", { moon_id: w.moonId }).filter((e) => e.kind === "voyage.event").length, 6);
  assert.ok(fs.existsSync(path.join(w.dir, ".nexus", "worktrees", "T1", "src", "lib", "thing.test.js")));
  assert.equal(w.git("status", "--porcelain"), "", "main tree untouched");
  const ship = w.g.db.get("ships.byId", { id: v.ship_id }); assert.equal(ship.status, "assigned");
  w.cleanup();
});

test("Review Focus #5: scope violation with IMPLEMENTED report → audit decides → adrift with out_of_scope", async () => {
  const w = await worldWithMoon("scope-violation"); const r = await launchMoon(w.g, { taskId: "T1", provider: "fake" });
  assert.equal(r.moonStatus, "adrift"); assert.deepEqual(r.audit.out_of_scope, ["README.md"]);
  const m = w.g.db.get("moons.byTask", { task_id: "T1" }); assert.equal(m.park_reason, "audit_violations");
  assert.equal(w.g.db.all("decisions.pending").length, 1); assert.equal(w.g.db.get("voyages.byId", { id: r.voyageId }).status, "adrift");
  w.cleanup();
});

test("rate-limited and crash both park the voyage with the reason; nothing half-written", async () => {
  for (const [script, reason] of [["rate-limited", "rate_limited"], ["crash-midrun", "backend_failure"]]) {
    const w = await worldWithMoon(script); const r = await launchMoon(w.g, { taskId: "T1", provider: "fake" });
    assert.equal(r.moonStatus, "adrift"); assert.equal(w.g.db.get("moons.byTask", { task_id: "T1" }).park_reason, reason, script);
    assert.equal(w.g.db.get("voyages.byId", { id: r.voyageId }).status, "adrift"); w.cleanup();
  }
});

test("launch refuses when no freighter is idle, and when moon is in the wrong state", async () => {
  const w = await worldWithMoon("happy", (c) => { c.roles = { implement: ["fake"], review: ["fake"] }; c.fleet = { freighters: 1, customs: 1, carriers: 1, surveyors: 1, name_theme: "classic" }; });
  await launchMoon(w.g, { taskId: "T1", provider: "fake" });               // freighter now holding (assigned)
  const spec2 = writeSpec(w.dir, "T2", read("tests/fixtures/specs/good-basic.md").replace("src/lib/thing.js", "src/lib/two.js")); w.git("add", "-A"); w.git("commit", "-qm", "s2");
  assignMoon(w.g, { planetId: w.planetId, specPath: spec2 });
  await assert.rejects(launchMoon(w.g, { taskId: "T2", provider: "fake" }), /all freighters in fleet 'fake' are assigned/);
  await assert.rejects(launchMoon(w.g, { taskId: "T1", provider: "fake" }), /is 'audited'/);
  w.cleanup();
});

test("launch refuses a moon whose spec body changed since assign, before any side effect", async () => {
  const w = await worldWithMoon("happy"); const p = path.join(w.dir, ".nexus", "specs", "T1.md");
  fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace("Add X to thing.", "Add Y to thing."));
  await assert.rejects(launchMoon(w.g, { taskId: "T1", provider: "fake" }), /spec body changed since assign/);
  assert.equal(w.g.db.get("moons.byTask", { task_id: "T1" }).status, "emitted"); assert.ok(!fs.existsSync(path.join(w.dir, ".nexus", "worktrees", "T1")));
  w.cleanup();
});

test("launch refuses an adrift moon and points at reply/drop", async () => {
  const w = await worldWithMoon("rate-limited"); await launchMoon(w.g, { taskId: "T1", provider: "fake" });
  await assert.rejects(launchMoon(w.g, { taskId: "T1", provider: "fake" }), /adrift.*reply/);
  w.cleanup();
});

test("renderPrompt substitutes in one pass and throws on an unknown variable", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-prompt-")); const tmp = path.join(dir, "t.md");
  fs.writeFileSync(tmp, "a {{x}} b {{y}}\n");
  assert.equal(renderPrompt(tmp, { x: "{{y}}", y: "Y" }), "a {{y}} b Y\n");
  assert.throws(() => renderPrompt(tmp, { x: "1" }), /unknown variable '\{\{y\}\}'/);
  fs.rmSync(dir, { recursive: true, force: true });
});
