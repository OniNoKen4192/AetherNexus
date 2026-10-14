import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../../dist/db/open.js";
import { append } from "../../dist/db/events.js";
import { rebuild, dumpProjections } from "../../dist/db/rebuild.js";
import { discoverPlanet } from "../../dist/core/bodies.js";
import { tmpDb } from "../helpers.mjs";
import { seedSystem } from "../fixtures/world.mjs";

test("system.created projects the system and all barren bodies", () => {
  const db = openDb(tmpDb()); const gen = seedSystem(db);
  const sys = db.get("systems.byId", { id: "S-20261013-demo" });
  assert.equal(sys.status, "open"); assert.equal(sys.base_sha, "0".repeat(40));
  assert.equal(sys.seed, 42); assert.equal(sys.theme, "classic");
  const planets = db.all("planets.bySystem", { system_id: "S-20261013-demo" });
  assert.equal(planets.length, 6);
  assert.ok(planets.every((p) => p.body_status === "barren" && p.stream_id === null && p.branch === null));
  assert.equal(planets[0].id, `S-20261013-demo/${gen.planets[0].name}`);
  const moons = db.all("moons.byPlanet", { planet_id: planets[0].id });
  assert.equal(moons.length, gen.planets[0].moons.length);
  assert.ok(moons.every((m) => m.body_status === "barren" && m.task_id === null));
  assert.equal(moons[0].id, `${planets[0].id}/${gen.planets[0].moons[0].name}`);
  assert.ok(sys.last_event_id >= 1);
  db.close();
});

test("planet.discovered appends an outer planet; moon.discovered appends a moon", () => {
  const db = openDb(tmpDb()); const gen = seedSystem(db);
  const existing = gen.planets.map(({ name, orbit_index }) => ({ name, orbit_index }));
  const p7 = discoverPlanet(42, gen.theme, existing);
  append(db, { kind: "planet.discovered", system_id: "S-20261013-demo", planet_id: `S-20261013-demo/${p7.name}`, payload: { planet: p7 } });
  const row = db.get("planets.byId", { id: `S-20261013-demo/${p7.name}` });
  assert.equal(row.kind, "gas_giant"); assert.equal(row.orbit_index, 6);
  append(db, { kind: "moon.discovered", system_id: "S-20261013-demo", planet_id: row.id, moon_id: `${row.id}/Nix`, payload: { moon: { name: "Nix", orbit_index: 0 } } });
  assert.equal(db.all("moons.byPlanet", { planet_id: row.id }).length, 1);
  db.close();
});

test("rebuild reproduces terrain byte-for-byte", () => {
  const db = openDb(tmpDb()); seedSystem(db);
  const before = dumpProjections(db); rebuild(db); assert.equal(dumpProjections(db), before); db.close();
});
