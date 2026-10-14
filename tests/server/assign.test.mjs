import { test } from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs"; import path from "node:path";
import { makeGalaxy, writeSpec, read } from "../helpers.mjs";
import { createSystem, showSystem } from "../../dist/server/commands/system.js";
import { assignPlanet, assignMoon } from "../../dist/server/commands/assign.js";

test("createSystem: id, base sha, integration branch, 6 planets; main untouched; refuses duplicate", async () => {
  const w = await makeGalaxy(); const r = createSystem(w.g, { slug: "auth", title: "Auth", brief: "b", seed: 42 });
  assert.match(r.systemId, /^S-\d{8}-auth$/); assert.equal(r.planets, 6); assert.ok(r.moons >= 6);
  assert.equal(w.g.git.branchExists(`system/${r.systemId}/integration`), true);
  assert.equal(w.git("rev-parse", "--abbrev-ref", "HEAD"), "main");
  assert.throws(() => createSystem(w.g, { slug: "auth", title: "Auth", brief: "b" }), /already exists/);
  assert.throws(() => createSystem(w.g, { slug: "../x", title: "t", brief: "b" }), /canonical/);
  const s = showSystem(w.g, r.systemId); assert.equal(s.planets.length, 6); assert.ok(s.planets[0].moons.length >= 1); w.cleanup();
});

test("assignPlanet: inner planets first, then discovery beyond the belt; branch from integration; worktree exists", async () => {
  const w = await makeGalaxy(); const { systemId } = createSystem(w.g, { slug: "big", title: "t", brief: "b", seed: 1 });
  const results = []; for (let i = 0; i < 7; i++) results.push(assignPlanet(w.g, { systemId, streamId: `P${i}`, mission: "m", territory: [`src/p${i}/**`] }));
  assert.deepEqual(results.slice(0, 6).map((r) => r.discovered), [false, false, false, false, false, false]); assert.equal(results[6].discovered, true);
  const p7 = w.g.db.get("planets.byId", { id: results[6].planetId }); assert.equal(p7.kind, "gas_giant"); assert.equal(p7.orbit_index, 6);
  assert.ok(fs.existsSync(path.join(w.dir, results[0].worktree, "README.md")));
  assert.equal(w.g.git.branchExists(results[0].branch), true);
  assert.throws(() => assignPlanet(w.g, { systemId, streamId: "dup", mission: "m", territory: ["x/**"], planetName: p7.name }), /not barren/);
  w.cleanup();
});

test("assignMoon: barren moon then discovery; spec hash recorded; duplicate task refused (Review Focus #2); restricted → adrift + decision", async () => {
  const w = await makeGalaxy((c) => { c.roles = { implement: ["fake"], review: ["fake"] }; c.routing.attention = { billing: ["src/lib/**"] }; });
  const { systemId } = createSystem(w.g, { slug: "m", title: "t", brief: "b", seed: 3 });
  const { planetId } = assignPlanet(w.g, { systemId, streamId: "P1", mission: "m", territory: ["src/**"] });
  const nMoons = w.g.db.all("moons.byPlanet", { planet_id: planetId }).length;
  const ids = [];
  for (let i = 0; i <= nMoons; i++) { const spec = writeSpec(w.dir, `T${i}`, read("tests/fixtures/specs/good-basic.md").replaceAll("src/lib/thing", `src/other/t${i}`)); const r = assignMoon(w.g, { planetId, specPath: spec }); ids.push(r); assert.equal(r.discovered, i === nMoons, `moon ${i}`); }
  const m = w.g.db.get("moons.byTask", { task_id: "T0" }); assert.equal(m.spec_sha.length, 64); assert.equal(m.status, "emitted");
  assert.throws(() => assignMoon(w.g, { planetId, specPath: writeSpec(w.dir, "T0") }), /task 'T0' is already assigned to moon/);
  // restricted: touch matches attention → parked (gate_failed → adrift) with a pending decision
  const spec = writeSpec(w.dir, "TR"); const r = assignMoon(w.g, { planetId, specPath: spec });
  assert.deepEqual(r.attention, { billing: ["src/lib/thing.js", "src/lib/thing.test.js"] });
  assert.equal(w.g.db.get("moons.byTask", { task_id: "TR" }).status, "adrift");
  assert.equal(w.g.db.all("decisions.pending").filter((d) => d.kind === "restricted").length, 1);
  w.cleanup();
});
