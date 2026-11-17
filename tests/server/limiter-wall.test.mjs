import assert from "node:assert/strict";
import test from "node:test";
import { append, rowToEvent } from "../../dist/db/events.js";
import { dumpProjections, rebuild } from "../../dist/db/rebuild.js";
import { openDb } from "../../dist/db/open.js";
import { endOutOfFuel } from "../../dist/server/limiter/wall.js";
import { tmpDb } from "../helpers.mjs";
import { seedFleet, seedSystem } from "../fixtures/world.mjs";

const NOW = Date.parse("2026-11-17T18:00:00.000Z");

function world(fleets = ["fake"]) {
  const db = openDb(tmpDb());
  const generated = seedSystem(db); seedFleet(db, fleets);
  const system = "S-20261013-demo";
  const planet = `${system}/${generated.planets[0].name}`;
  const moon = `${planet}/${generated.planets[0].moons[0].name}`;
  append(db, { kind: "planet.assigned", system_id: system, planet_id: planet, payload: { stream_id: "P1", mission: "m", territory: ["src/**"], depends_on: [], branch: "system/demo/planet", worktree: ".nexus/worktrees/planet" } });
  append(db, { kind: "moon.assigned", system_id: system, planet_id: planet, moon_id: moon, payload: { task_id: "T1", spec_path: ".nexus/specs/T1.md", spec_sha: "abc", touch: ["src/x.ts"], depends_on: [], tier: "terra" } });
  const assigned = db.get("moons.byId", { id: moon });
  const base = { system_id: system, planet_id: planet, moon_id: moon, task_id: "T1", assignment_id: assigned.assignment_id };
  return { db, g: { db, now: () => NOW }, moon, base, serial: 0 };
}

function gate(w, round = 1) {
  append(w.db, { kind: "moon.gated", ...w.base, payload: { base_sha: "0".repeat(40), state_path: ".nexus/state/T1.json", round } });
}

function launch(w, role = "implement", provider = "fake", round = 1) {
  const cls = role === "implement" ? "freighter" : "customs";
  const ship = w.db.get("ships.pickIdle", { class: cls, fleet: provider });
  assert.ok(ship, `idle ${provider} ${cls}`);
  const voyageId = `${ship.id}/T1/${role}/${round}#${++w.serial}`;
  append(w.db, {
    kind: "voyage.launched", ...w.base, voyage_id: voyageId, ship_id: ship.id, provider,
    payload: { role, round, provider, ship_id: ship.id, worktree: ".nexus/worktrees/T1" },
  });
  return { voyageId, shipId: ship.id, voyageCount: ship.voyage_count };
}

function hit(w, voyage, extra = {}) {
  return endOutOfFuel(w.g, { taskId: "T1", role: "implement", provider: "fake", details: "allowance exhausted", ...voyage, ...extra });
}

function nextAfter(w, voyageId, round = 1) {
  append(w.db, { kind: "voyage.superseded", ...w.base, voyage_id: voyageId, payload: {} });
  gate(w, round);
}

function events(w, kind) {
  return w.db.all("events.byAssignment", { assignment_id: w.base.assignment_id }).map(rowToEvent).filter((event) => event.kind === kind);
}

function finish(w) {
  const before = dumpProjections(w.db); rebuild(w.db); assert.equal(dumpProjections(w.db), before, "rebuild byte-equal"); w.db.close();
}

test("until comes from a valid future resetsAt and fuel.exhausted has the complete envelope", () => {
  const w = world(); gate(w); const voyage = launch(w); const resetsAt = new Date(NOW + 7 * 60_000).toISOString();
  const result = hit(w, voyage, { resetsAt, modelFamily: "opus" });
  assert.equal(result.until, resetsAt);
  const exhausted = events(w, "fuel.exhausted").at(-1);
  assert.equal(exhausted.provider, "fake"); assert.equal(exhausted.voyage_id, voyage.voyageId);
  assert.deepEqual(exhausted.payload, { until: resetsAt, voyage_id: voyage.voyageId, model_family: "opus" });
  finish(w);

  const noFamily = world(); gate(noFamily); const other = launch(noFamily); hit(noFamily, other, { resetsAt });
  assert.equal(Object.hasOwn(events(noFamily, "fuel.exhausted").at(-1).payload, "model_family"), false);
  finish(noFamily);
});

test("without resetsAt the earliest live reading supplies until", () => {
  const w = world(); gate(w); const voyage = launch(w);
  const soon = new Date(NOW + 10 * 60_000).toISOString(); const late = new Date(NOW + 3 * 86_400_000).toISOString();
  append(w.db, { kind: "fuel.reading", ...w.base, provider: "fake", ts: new Date(NOW).toISOString(), payload: { window: "three-day", used: 0.8, resets_at: late } });
  append(w.db, { kind: "fuel.reading", ...w.base, provider: "fake", ts: new Date(NOW).toISOString(), payload: { window: "ten-minute", used: 1, resets_at: soon } });
  assert.equal(hit(w, voyage).until, soon); finish(w);
});

test("without resetsAt or readings until is thirty minutes from now", () => {
  const w = world(); gate(w); const voyage = launch(w);
  assert.equal(hit(w, voyage).until, new Date(NOW + 30 * 60_000).toISOString()); finish(w);
});

test("past and near resets clamp to sixty seconds while an unparseable reset falls back", () => {
  for (const [resetsAt, expected] of [
    [new Date(NOW - 1).toISOString(), NOW + 60_000],
    ["soon", NOW + 30 * 60_000],
    [new Date(NOW + 5_000).toISOString(), NOW + 60_000],
  ]) {
    const w = world(); gate(w); const voyage = launch(w);
    assert.equal(hit(w, voyage, { resetsAt }).until, new Date(expected).toISOString()); finish(w);
  }
});

test("first hit in flight releases the freighter and leaves cargo awaiting pickup", () => {
  const w = world(); gate(w); const voyage = launch(w); const result = hit(w, voyage);
  assert.equal(result.parked, false); assert.equal(w.db.get("voyages.byId", { id: voyage.voyageId }).status, "out_of_fuel");
  const ship = w.db.get("ships.byId", { id: voyage.shipId }); assert.equal(ship.status, "idle"); assert.equal(ship.voyage_count, voyage.voyageCount);
  const moon = w.db.get("moons.byId", { id: w.moon }); assert.equal(moon.status, "awaiting_pickup"); assert.equal(moon.park_reason, null);
  assert.equal(w.db.all("decisions.pendingByTarget", { target_id: "T1" }).length, 0); finish(w);
});

test("first hit from holding releases the freighter and leaves audited cargo awaiting pickup", () => {
  const w = world(); gate(w); const voyage = launch(w);
  append(w.db, { kind: "voyage.returned", ...w.base, voyage_id: voyage.voyageId, payload: { role: "implement", report: { rate_limited: true } } });
  append(w.db, { kind: "voyage.audited", ...w.base, voyage_id: voyage.voyageId, payload: { audit: {} } });
  hit(w, voyage);
  assert.equal(w.db.get("voyages.byId", { id: voyage.voyageId }).status, "out_of_fuel"); assert.equal(w.db.get("ships.byId", { id: voyage.shipId }).status, "idle");
  assert.equal(w.db.get("moons.byId", { id: w.moon }).status, "awaiting_pickup"); finish(w);
});

test("first customs hit abandons review without changing cargo round or the holding freighter", () => {
  const w = world(); gate(w, 3); const freight = launch(w, "implement", "fake", 3);
  append(w.db, { kind: "voyage.returned", ...w.base, voyage_id: freight.voyageId, payload: { role: "implement", report: {} } });
  append(w.db, { kind: "voyage.audited", ...w.base, voyage_id: freight.voyageId, payload: { audit: {} } });
  const customs = launch(w, "review", "fake", 3);
  const result = hit(w, customs, { role: "review" });
  assert.equal(result.parked, false); assert.equal(w.db.get("voyages.byId", { id: customs.voyageId }).status, "out_of_fuel");
  assert.equal(w.db.get("ships.byId", { id: customs.shipId }).status, "idle");
  const moon = w.db.get("moons.byId", { id: w.moon }); assert.equal(moon.status, "audited"); assert.equal(moon.round, 3);
  assert.equal(w.db.get("voyages.byId", { id: freight.voyageId }).status, "holding"); assert.equal(w.db.get("ships.byId", { id: freight.shipId }).status, "assigned"); finish(w);
});

test("second hit on the same provider parks the voyage and records another exhaustion", () => {
  const w = world(); gate(w); const first = launch(w); assert.equal(hit(w, first).parked, false);
  nextAfter(w, first.voyageId); const second = launch(w); const result = hit(w, second);
  assert.equal(result.parked, true); const moon = w.db.get("moons.byId", { id: w.moon }); assert.equal(moon.status, "adrift"); assert.equal(moon.park_reason, "rate_limited");
  assert.equal(w.db.all("decisions.pendingByTarget", { target_id: "T1" }).length, 1); assert.equal(w.db.get("ships.byId", { id: second.shipId }).status, "adrift");
  assert.equal(events(w, "fuel.exhausted").length, 2); finish(w);
});

test("other providers do not reset repeat detection, while a normal same-provider voyage does", () => {
  const w = world(["A", "B"]); gate(w); const a1 = launch(w, "implement", "A"); assert.equal(hit(w, a1, { provider: "A" }).parked, false);
  nextAfter(w, a1.voyageId); const b = launch(w, "implement", "B"); assert.equal(hit(w, b, { provider: "B" }).parked, false);
  nextAfter(w, b.voyageId); const a2 = launch(w, "implement", "A"); assert.equal(hit(w, a2, { provider: "A" }).parked, true); finish(w);

  const normal = world(["A"]); gate(normal); const returned = launch(normal, "implement", "A");
  append(normal.db, { kind: "voyage.returned", ...normal.base, voyage_id: returned.voyageId, payload: { role: "implement", report: {} } });
  append(normal.db, { kind: "voyage.audited", ...normal.base, voyage_id: returned.voyageId, payload: { audit: {} } });
  gate(normal); const later = launch(normal, "implement", "A"); assert.equal(hit(normal, later, { provider: "A" }).parked, false); finish(normal);
});
