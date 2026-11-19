import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../../dist/db/open.js";
import { append } from "../../dist/db/events.js";
import { legacyShip, pickIdleShip } from "../../dist/core/fleet.js";
import { rebuild, dumpProjections } from "../../dist/db/rebuild.js";
import { tmpDb } from "../helpers.mjs";
import { seedFleet, seedSystem } from "../fixtures/world.mjs";

test("register → idle; voyage.launched → assigned; release → idle with voyage_count", () => {
  const db = openDb(tmpDb()); const gen = seedSystem(db); seedFleet(db);
  const sys = "S-20261013-demo", planet = `${sys}/${gen.planets[0].name}`, moon = `${planet}/${gen.planets[0].moons[0].name}`, base = { system_id: sys, planet_id: planet, moon_id: moon };
  append(db, { kind: "moon.assigned", ...base, payload: { task_id: "T1", spec_path: "s", spec_sha: "x", touch: ["a"], depends_on: [], tier: "" } });
  append(db, { kind: "moon.gated", ...base, payload: { base_sha: "0".repeat(40), state_path: "s", round: 1 } });
  const s = pickIdleShip(db, "delivery", "fake", "standard"); assert.ok(s); assert.equal(s.status, "idle");
  // ship.assigned is gone: the voyage.launched reducer takes the ship (one transaction).
  append(db, { kind: "voyage.launched", ...base, voyage_id: "v1", ship_id: s.id, provider: "fake", payload: { role: "implement", round: 1, provider: "fake", ship_id: s.id, worktree: "w" } });
  assert.equal(db.get("ships.byId", { id: s.id }).status, "assigned");
  const other = pickIdleShip(db, "delivery", "fake", "standard"); assert.notEqual(other.id, s.id, "assigned ship is not picked");
  append(db, { kind: "ship.released", ship_id: s.id, payload: { voyage_id: "v1", outcome: "docked" } });
  const row = db.get("ships.byId", { id: s.id }); assert.equal(row.status, "idle"); assert.equal(row.voyage_count, 1);
  assert.equal(pickIdleShip(db, "delivery", "fake", "standard").id, other.id, "lowest voyage_count wins");
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
  assert.equal(pickIdleShip(db, "delivery", "fake", "standard"), undefined);
  db.close();
});

test("rebuild reproduces the roster", () => {
  const db = openDb(tmpDb()); seedFleet(db); const before = dumpProjections(db); rebuild(db); assert.equal(dumpProjections(db), before); db.close();
});

test("ship.commissioned inserts the whole record, idle; ship.registered inserts the legacy record", () => {
  const db = openDb(tmpDb());
  const formation = { id: "carrier-group", name: "Carrier group", vessels: [{ hull: "carrier", count: 1, role: "lead" }, { hull: "frigate", count: 4, role: "escort" }], art: null };
  const ship = { id: "kestrel", name: "Kestrel", fleet: "claude", job: "delivery", faction: "anthropic", weight: "heavy", formation };
  const ev = append(db, { kind: "ship.commissioned", ship_id: ship.id, provider: ship.fleet, payload: { ship } });
  const row = db.get("ships.byId", { id: "kestrel" });
  assert.deepEqual({ ...row }, { id: "kestrel", name: "Kestrel", job: "delivery", fleet: "claude", faction: "anthropic", weight: "heavy", formation: JSON.stringify(formation), status: "idle", voyage_count: 0, last_event_id: ev.id });
  assert.equal(pickIdleShip(db, "delivery", "claude", "heavy").id, "kestrel");
  assert.equal(pickIdleShip(db, "delivery", "claude", "standard"), undefined, "a heavy ship is not taken for a standard job");
  assert.equal(pickIdleShip(db, "customs", "claude", "heavy"), undefined);
  assert.equal(pickIdleShip(db, "delivery", "codex", "heavy"), undefined);

  const old = { id: "pilgrim", name: "Pilgrim", class: "carrier", fleet: "codex" };
  append(db, { kind: "ship.registered", ship_id: old.id, provider: old.fleet, payload: { ship: old } });
  const legacy = legacyShip(old);
  assert.deepEqual(legacy, { id: "pilgrim", name: "Pilgrim", fleet: "codex", job: "transfer", faction: "codex", weight: "standard", formation: { id: "legacy-transfer", name: "Carrier", vessels: [{ hull: "carrier", count: 1, role: "lead" }] } });
  const reg = db.get("ships.byId", { id: "pilgrim" });
  assert.deepEqual([reg.job, reg.faction, reg.weight, reg.formation, reg.status], ["transfer", "codex", "standard", JSON.stringify(legacy.formation), "idle"]);
  assert.throws(() => append(db, { kind: "ship.commissioned", ship_id: "k2", provider: "claude", payload: { ship: { ...ship, id: "k2" } } }), /UNIQUE constraint failed/, "a name is given out once");
  assert.throws(() => legacyShip({ ...old, class: "constructor" }), /unknown class/);

  const before = dumpProjections(db); rebuild(db); assert.equal(dumpProjections(db), before);
  db.close();
});

test("cargo on voyage.launched is stored on the voyage; a voyage without cargo stores NULL", () => {
  const db = openDb(tmpDb()); const gen = seedSystem(db); seedFleet(db);
  const sys = "S-20261013-demo", planet = `${sys}/${gen.planets[0].name}`, moon = `${planet}/${gen.planets[0].moons[0].name}`, base = { system_id: sys, planet_id: planet, moon_id: moon };
  append(db, { kind: "moon.assigned", ...base, payload: { task_id: "T1", spec_path: "s", spec_sha: "x", touch: ["a"], depends_on: [], tier: "" } });
  append(db, { kind: "moon.gated", ...base, payload: { base_sha: "0".repeat(40), state_path: "s", round: 1 } });
  const d = pickIdleShip(db, "delivery", "fake", "standard"), c = pickIdleShip(db, "customs", "fake", "standard");
  append(db, { kind: "voyage.launched", ...base, voyage_id: "v1", ship_id: d.id, provider: "fake", payload: { role: "implement", round: 1, provider: "fake", ship_id: d.id, worktree: "w", cargo: { id: "diplomat", label: "a diplomat" } } });
  assert.equal(db.get("voyages.byId", { id: "v1" }).cargo, JSON.stringify({ id: "diplomat", label: "a diplomat" }));
  append(db, { kind: "voyage.returned", ...base, voyage_id: "v1", ship_id: d.id, payload: { role: "implement", report: {} } });
  append(db, { kind: "voyage.audited", ...base, voyage_id: "v1", payload: {} });
  append(db, { kind: "voyage.launched", ...base, voyage_id: "v2", ship_id: c.id, provider: "fake", payload: { role: "review", round: 1, provider: "fake", ship_id: c.id, worktree: "w" } });
  assert.equal(db.get("voyages.byId", { id: "v2" }).cargo, null);
  const before = dumpProjections(db); rebuild(db); assert.equal(dumpProjections(db), before);
  db.close();
});
