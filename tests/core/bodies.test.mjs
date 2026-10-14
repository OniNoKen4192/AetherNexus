import { test } from "node:test";
import assert from "node:assert/strict";
import { generateSystem, discoverPlanet, discoverMoon } from "../../dist/core/bodies.js";
import { mulberry32 } from "../../dist/core/rng.js";
import { THEMES } from "../../dist/core/names.js";

test("generateSystem is deterministic and shaped per spec §4.0", () => {
  const a = generateSystem(42), b = generateSystem(42), c = generateSystem(43);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.equal(a.planets.length, 6);
  assert.deepEqual(a.planets.map((p) => p.orbit_index), [0, 1, 2, 3, 4, 5]);
  for (const p of a.planets) {
    assert.equal(p.kind, "rocky");
    assert.ok(p.moons.length >= 1 && p.moons.length <= 4, `${p.name} has ${p.moons.length} moons`);
    assert.deepEqual(p.moons.map((m) => m.orbit_index), p.moons.map((_, i) => i));
  }
  const names = a.planets.map((p) => p.name);
  assert.equal(new Set(names).size, 6, "planet names unique");
  const moonNames = a.planets.flatMap((p) => p.moons.map((m) => m.name));
  assert.equal(new Set(moonNames).size, moonNames.length, "moon names unique within a system");
});

test("discoverPlanet: 7th is a gas giant, then gas, ice, ice, dwarf…; names stay unique", () => {
  const sys = generateSystem(7);
  const existing = sys.planets.map(({ name, orbit_index }) => ({ name, orbit_index }));
  const kinds = [];
  for (let i = 0; i < 6; i++) { const p = discoverPlanet(7, "classic", existing); kinds.push(p.kind); assert.equal(p.orbit_index, 6 + i); assert.ok(!existing.some((e) => e.name === p.name)); existing.push(p); }
  assert.deepEqual(kinds, ["gas_giant", "gas_giant", "ice_giant", "ice_giant", "dwarf", "dwarf"]);
  assert.deepEqual(discoverPlanet(7, "classic", sys.planets.map(({ name, orbit_index }) => ({ name, orbit_index }))), discoverPlanet(7, "classic", sys.planets.map(({ name, orbit_index }) => ({ name, orbit_index }))));
});

test("discoverMoon appends the next orbit and a fresh name", () => {
  const sys = generateSystem(9); const p = sys.planets[0];
  const used = new Set(sys.planets.flatMap((q) => q.moons.map((m) => m.name)));
  const m = discoverMoon(9, "classic", p.orbit_index, p.moons, used);
  assert.equal(m.orbit_index, p.moons.length);
  assert.ok(!used.has(m.name));
});

test("mulberry32 is a stable sequence", () => {
  const r = mulberry32(1); const seq = [r(), r(), r()];
  const r2 = mulberry32(1); assert.deepEqual([r2(), r2(), r2()], seq);
  for (const x of seq) assert.ok(x >= 0 && x < 1);
});

test("theme lists have the required sizes and unique names", () => {
  for (const [theme, t] of Object.entries(THEMES)) {
    for (const [list, n] of [["planets", 40], ["moons", 60], ["ships", 60]]) {
      assert.equal(t[list].length, n, `${theme}.${list} length`);
      assert.equal(new Set(t[list]).size, n, `${theme}.${list} unique`);
    }
  }
  assert.ok(THEMES.classic && THEMES.pulp);
});
