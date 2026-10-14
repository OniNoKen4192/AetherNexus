import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../../dist/db/open.js";
import { append } from "../../dist/db/events.js";
import { pickIdleShip } from "../../dist/core/fleet.js";
import { rebuild, dumpProjections } from "../../dist/db/rebuild.js";
import { tmpDb } from "../helpers.mjs";
import { seedFleet, seedSystem } from "../fixtures/world.mjs";

test("register → idle; voyage.launched → assigned; release → idle with voyage_count", () => {
  const db = openDb(tmpDb()); const gen = seedSystem(db); seedFleet(db);
  const sys = "S-20261013-demo", planet = `${sys}/${gen.planets[0].name}`, moon = `${planet}/${gen.planets[0].moons[0].name}`, base = { system_id: sys, planet_id: planet, moon_id: moon };
  append(db, { kind: "moon.assigned", ...base, payload: { task_id: "T1", spec_path: "s", spec_sha: "x", touch: ["a"], depends_on: [], tier: "" } });
  append(db, { kind: "moon.gated", ...base, payload: { base_sha: "0".repeat(40), state_path: "s", round: 1 } });
  const s = pickIdleShip(db, "freighter", "fake"); assert.ok(s); assert.equal(s.status, "idle");
  // ship.assigned is gone: the voyage.launched reducer takes the ship (one transaction).
  append(db, { kind: "voyage.launched", ...base, voyage_id: "v1", ship_id: s.id, provider: "fake", payload: { role: "implement", round: 1, provider: "fake", ship_id: s.id, worktree: "w" } });
  assert.equal(db.get("ships.byId", { id: s.id }).status, "assigned");
  const other = pickIdleShip(db, "freighter", "fake"); assert.notEqual(other.id, s.id, "assigned ship is not picked");
  append(db, { kind: "ship.released", ship_id: s.id, payload: { voyage_id: "v1", outcome: "docked" } });
  const row = db.get("ships.byId", { id: s.id }); assert.equal(row.status, "idle"); assert.equal(row.voyage_count, 1);
  assert.equal(pickIdleShip(db, "freighter", "fake").id, other.id, "lowest voyage_count wins");
  db.close();
});

test("adrift, quarantined, retired; retired never picked", () => {
  const db = openDb(tmpDb()); const ships = seedFleet(db);
  const [f1, f2] = ships.filter((s) => s.class === "freighter");
  append(db, { kind: "ship.adrift", ship_id: f1.id, payload: { voyage_id: "v" } });
  assert.equal(db.get("ships.byId", { id: f1.id }).status, "adrift");
  append(db, { kind: "ship.released", ship_id: f1.id, payload: { voyage_id: "v", outcome: "reply" } });
  assert.equal(db.get("ships.byId", { id: f1.id }).voyage_count, 0, "reply does not count a voyage");
  append(db, { kind: "ship.quarantined", ship_id: f2.id, payload: { voyage_id: "v" } });
  assert.equal(db.get("ships.byId", { id: f2.id }).status, "quarantined");
  append(db, { kind: "ship.retired", ship_id: f1.id, payload: { reason: "human" } });
  append(db, { kind: "ship.retired", ship_id: f2.id, payload: { reason: "human" } });
  assert.equal(pickIdleShip(db, "freighter", "fake"), undefined);
  db.close();
});

test("rebuild reproduces the roster", () => {
  const db = openDb(tmpDb()); seedFleet(db); const before = dumpProjections(db); rebuild(db); assert.equal(dumpProjections(db), before); db.close();
});
