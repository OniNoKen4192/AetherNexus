import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../../dist/db/open.js";
import { append } from "../../dist/db/events.js";
import { rebuild, dumpProjections } from "../../dist/db/rebuild.js";
import { tmpDb } from "../helpers.mjs";
import { seedSystem, seedFleet } from "../fixtures/world.mjs";

function world() {
  const db = openDb(tmpDb()); const gen = seedSystem(db); seedFleet(db);
  const sys = "S-20261013-demo"; const planet = `${sys}/${gen.planets[0].name}`; const moon = `${planet}/${gen.planets[0].moons[0].name}`;
  append(db, { kind: "planet.assigned", system_id: sys, planet_id: planet, payload: { stream_id: "P1", mission: "m", territory: ["src/lib/**"], depends_on: [], branch: `system/${sys}/${gen.planets[0].name}`, worktree: `.nexus/worktrees/${sys}/${gen.planets[0].name}` } });
  append(db, { kind: "moon.assigned", system_id: sys, planet_id: planet, moon_id: moon, payload: { task_id: "T1", spec_path: ".nexus/specs/T1.md", spec_sha: "abc", touch: ["src/lib/thing.js"], depends_on: [], tier: "terra" } });
  return { db, moon, base: { system_id: sys, planet_id: planet, moon_id: moon } };
}
function gate(db, base, round = 1) { append(db, { kind: "moon.gated", ...base, payload: { base_sha: "0".repeat(40), state_path: ".nexus/state/T1.json", round } }); }
function launch(db, base, ship, role, voyage, round = 1) { append(db, { kind: "voyage.launched", ...base, voyage_id: voyage, ship_id: ship.id, provider: "fake", payload: { role, round, provider: "fake", ship_id: ship.id, worktree: ".nexus/worktrees/T1" } }); }
function assertRebuildEqual(db) { const before = dumpProjections(db); rebuild(db); assert.equal(dumpProjections(db), before); }

test("a delivery that runs out of fuel releases its ship and leaves cargo awaiting pickup", () => {
  const { db, moon, base } = world(); const ship = db.get("ships.pickIdle", { job: "delivery", fleet: "fake", weight: "standard" }); const voyage = `${ship.id}/T1/implement/1`; const count = ship.voyage_count;
  gate(db, base); launch(db, base, ship, "implement", voyage);
  append(db, { kind: "voyage.out_of_fuel", ...base, voyage_id: voyage, payload: {} });
  append(db, { kind: "ship.released", ...base, voyage_id: voyage, ship_id: ship.id, payload: { voyage_id: voyage, outcome: "out_of_fuel" } });
  append(db, { kind: "moon.awaiting_pickup", ...base, payload: {} });
  assert.equal(db.get("voyages.byId", { id: voyage }).status, "out_of_fuel");
  const released = db.get("ships.byId", { id: ship.id }); assert.equal(released.status, "idle"); assert.equal(released.voyage_count, count);
  const cargo = db.get("moons.byId", { id: moon }); assert.equal(cargo.status, "awaiting_pickup"); assert.equal(cargo.park_reason, null);
  assertRebuildEqual(db); db.close();
});

test("a customs ship that runs out of fuel abandons review without changing the cargo round", () => {
  const { db, moon, base } = world(); const delivery = db.get("ships.pickIdle", { job: "delivery", fleet: "fake", weight: "standard" }); const customs = db.get("ships.pickIdle", { job: "customs", fleet: "fake", weight: "standard" });
  const freightVoyage = `${delivery.id}/T1/implement/1`; const reviewVoyage = `${customs.id}/T1/review/1`;
  gate(db, base, 3); launch(db, base, delivery, "implement", freightVoyage, 3);
  append(db, { kind: "voyage.returned", ...base, voyage_id: freightVoyage, payload: { role: "implement", report: {} } });
  append(db, { kind: "voyage.audited", ...base, voyage_id: freightVoyage, payload: { audit: {} } });
  launch(db, base, customs, "review", reviewVoyage, 3);
  append(db, { kind: "voyage.out_of_fuel", ...base, voyage_id: reviewVoyage, payload: {} });
  append(db, { kind: "ship.released", ...base, voyage_id: reviewVoyage, ship_id: customs.id, payload: { voyage_id: reviewVoyage, outcome: "out_of_fuel" } });
  append(db, { kind: "moon.review_abandoned", ...base, payload: {} });
  const cargo = db.get("moons.byId", { id: moon }); assert.equal(cargo.status, "audited"); assert.equal(cargo.round, 3);
  assert.equal(db.get("ships.byId", { id: customs.id }).status, "idle"); assert.equal(db.get("voyages.byId", { id: freightVoyage }).status, "holding");
  assertRebuildEqual(db); db.close();
});

test("cargo awaiting pickup clears an earlier park reason", () => {
  const { db, moon, base } = world(); const ship = db.get("ships.pickIdle", { job: "delivery", fleet: "fake", weight: "standard" }); const voyage = `${ship.id}/T1/implement/1`;
  append(db, { kind: "moon.adrift", ...base, payload: { reason: "needs a person" } }); assert.equal(db.get("moons.byId", { id: moon }).park_reason, "needs a person");
  gate(db, base); launch(db, base, ship, "implement", voyage); append(db, { kind: "voyage.out_of_fuel", ...base, voyage_id: voyage, payload: {} }); append(db, { kind: "moon.awaiting_pickup", ...base, payload: {} });
  const cargo = db.get("moons.byId", { id: moon }); assert.equal(cargo.status, "awaiting_pickup"); assert.equal(cargo.park_reason, null);
  assertRebuildEqual(db); db.close();
});

test("fuel and limiter log events change no projections", () => {
  const { db, base } = world(); const before = dumpProjections(db);
  for (const kind of ["fuel.reading", "fuel.exhausted", "limiter.held", "limiter.rerouted", "limiter.refuelled"]) append(db, { kind, ...base, payload: {} });
  assert.equal(dumpProjections(db), before); assertRebuildEqual(db); db.close();
});
