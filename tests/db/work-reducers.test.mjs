import { test } from "node:test"; import assert from "node:assert/strict";
import { openDb } from "../../dist/db/open.js"; import { append } from "../../dist/db/events.js";
import { rebuild, dumpProjections } from "../../dist/db/rebuild.js";
import { TransitionRefused } from "../../dist/core/transitions.js";
import { tmpDb } from "../helpers.mjs"; import { seedSystem, seedFleet } from "../fixtures/world.mjs";

function world() {
  const db = openDb(tmpDb()); const gen = seedSystem(db); seedFleet(db);
  const sys = "S-20261013-demo"; const planet = `${sys}/${gen.planets[0].name}`; const moon = `${planet}/${gen.planets[0].moons[0].name}`;
  append(db, { kind: "planet.assigned", system_id: sys, planet_id: planet, payload: { stream_id: "P1", mission: "m", territory: ["src/lib/**"], depends_on: [], branch: `system/${sys}/${gen.planets[0].name}`, worktree: ".nexus/worktrees/S-20261013-demo/" + gen.planets[0].name } });
  append(db, { kind: "moon.assigned", system_id: sys, planet_id: planet, moon_id: moon, payload: { task_id: "T1", spec_path: ".nexus/specs/T1.md", spec_sha: "abc", touch: ["src/lib/thing.js"], depends_on: [], tier: "terra", gravity: null } });
  return { db, sys, planet, moon };
}

test("assign: planet and moon rows carry work columns; task lookup works", () => {
  const { db, planet, moon } = world();
  const p = db.get("planets.byId", { id: planet }); assert.equal(p.body_status, "assigned"); assert.equal(p.stream_id, "P1"); assert.equal(p.status, "open");
  const m = db.get("moons.byTask", { task_id: "T1" }); assert.equal(m.id, moon); assert.equal(m.body_status, "assigned"); assert.equal(m.status, "emitted");
  db.close();
});

test("full freighter + customs lifecycle through reducers; rebuild matches", () => {
  const { db, sys, planet, moon } = world(); const ship = db.get("ships.pickIdle", { class: "freighter", fleet: "fake" }); const customs = db.get("ships.pickIdle", { class: "customs", fleet: "fake" });
  const base = { system_id: sys, planet_id: planet, moon_id: moon };
  append(db, { kind: "moon.gated", ...base, payload: { base_sha: "0".repeat(40), state_path: ".nexus/state/T1.json", round: 1 } });
  assert.equal(db.get("moons.byId", { id: moon }).round, 1);
  const v1 = `${ship.id}/T1/implement/1`;
  append(db, { kind: "ship.assigned", ship_id: ship.id, payload: { voyage_id: v1 } });
  append(db, { kind: "voyage.launched", ...base, voyage_id: v1, ship_id: ship.id, provider: "fake", payload: { role: "implement", round: 1, provider: "fake", ship_id: ship.id, worktree: ".nexus/worktrees/T1" } });
  assert.equal(db.get("moons.byId", { id: moon }).status, "implementing"); assert.equal(db.get("voyages.byId", { id: v1 }).status, "launched");
  append(db, { kind: "voyage.event", ...base, voyage_id: v1, payload: { event: { kind: "text", ts: "t", data: "hi" } } });
  assert.equal(db.get("voyages.byId", { id: v1 }).status, "working");
  append(db, { kind: "voyage.returned", ...base, voyage_id: v1, payload: { role: "implement", report: { status: "IMPLEMENTED" } } });
  append(db, { kind: "voyage.audited", ...base, voyage_id: v1, payload: { audit: { verdict: "clean" } } });
  assert.equal(db.get("moons.byId", { id: moon }).status, "audited"); assert.equal(db.get("voyages.byId", { id: v1 }).status, "holding");
  const v2 = `${customs.id}/T1/review/1`;
  append(db, { kind: "ship.assigned", ship_id: customs.id, payload: { voyage_id: v2 } });
  append(db, { kind: "voyage.launched", ...base, voyage_id: v2, ship_id: customs.id, provider: "fake", payload: { role: "review", round: 1, provider: "fake", ship_id: customs.id, worktree: ".nexus/worktrees/T1" } });
  assert.equal(db.get("moons.byId", { id: moon }).status, "reviewing");
  append(db, { kind: "voyage.event", ...base, voyage_id: v2, payload: { event: { kind: "text", ts: "t", data: "inspecting" } } });
  append(db, { kind: "voyage.returned", ...base, voyage_id: v2, payload: { role: "review", report: { verdict: "APPROVE" } } });
  assert.equal(db.get("voyages.byId", { id: v2 }).status, "docked");
  append(db, { kind: "verdict.issued", ...base, voyage_id: v2, payload: { verdict: "APPROVE", reasoning: "fine", round: 1, voyage_id: v2 } });
  assert.equal(db.all("verdicts.byMoon", { moon_id: moon }).length, 1);
  append(db, { kind: "voyage.cleared", ...base, voyage_id: v1, payload: {} });
  append(db, { kind: "voyage.departed", ...base, voyage_id: v1, payload: {} });
  append(db, { kind: "voyage.docked", ...base, voyage_id: v1, payload: { merge_sha: "1".repeat(40), planet_branch: "x" } });
  append(db, { kind: "moon.merged", ...base, payload: { merge_sha: "1".repeat(40) } });
  const m = db.get("moons.byId", { id: moon }); assert.equal(m.status, "merged"); assert.equal(m.body_status, "settled");
  assert.equal(db.get("voyages.byId", { id: v1 }).status, "docked");
  const before = dumpProjections(db); rebuild(db); assert.equal(dumpProjections(db), before); db.close();
});

test("illegal transition inside append is refused and nothing is written", () => {
  const { db, sys, planet, moon } = world(); const n = db.all("events.since", { id: 0 }).length;
  assert.throws(() => append(db, { kind: "moon.merged", system_id: sys, planet_id: planet, moon_id: moon, payload: { merge_sha: "x" } }), TransitionRefused);
  assert.equal(db.all("events.since", { id: 0 }).length, n); db.close();
});

test("REJECT -> quarantined + decision; drop -> dropped then moon.cleared -> barren", () => {
  const { db, sys, planet, moon } = world(); const base = { system_id: sys, planet_id: planet, moon_id: moon };
  // voyages.ship_id is a foreign key, so use real seeded ships
  const f = db.get("ships.pickIdle", { class: "freighter", fleet: "fake" }).id; const c = db.get("ships.pickIdle", { class: "customs", fleet: "fake" }).id;
  const vi = `${f}/T1/implement/1`, vr = `${c}/T1/review/1`;
  // fast-forward to reviewing
  append(db, { kind: "moon.gated", ...base, payload: { base_sha: "0".repeat(40), state_path: "s", round: 1 } });
  append(db, { kind: "voyage.launched", ...base, voyage_id: vi, ship_id: f, provider: "fake", payload: { role: "implement", round: 1, provider: "fake", ship_id: f, worktree: "w" } });
  append(db, { kind: "voyage.returned", ...base, voyage_id: vi, payload: { role: "implement", report: {} } });
  append(db, { kind: "voyage.audited", ...base, voyage_id: vi, payload: { audit: {} } });
  append(db, { kind: "voyage.launched", ...base, voyage_id: vr, ship_id: c, provider: "fake", payload: { role: "review", round: 1, provider: "fake", ship_id: c, worktree: "w" } });
  append(db, { kind: "verdict.issued", ...base, voyage_id: vr, payload: { verdict: "REJECT", reasoning: "no", round: 1, voyage_id: vr } });
  assert.equal(db.get("moons.byId", { id: moon }).status, "quarantined");
  append(db, { kind: "voyage.quarantined", ...base, voyage_id: vi, payload: {} });
  append(db, { kind: "decision.opened", ...base, payload: { kind: "reject", target_kind: "moon", target_id: "T1", reasoning: "no" } });
  const d = db.all("decisions.pending")[0]; assert.equal(d.kind, "reject"); assert.equal(d.reasoning, "no");
  append(db, { kind: "decision.resolved", ...base, payload: { decision_id: d.id, outcome: "drop", human_note: "" } });
  assert.equal(db.all("decisions.pending").length, 0);
  assert.throws(() => append(db, { kind: "decision.resolved", ...base, payload: { decision_id: d.id, outcome: "retry", human_note: "again" } }), new RegExp(`decision ${d.id} is 'resolved'`));
  assert.equal(db.get("decisions.byId", { id: d.id }).outcome, "drop");
  append(db, { kind: "moon.dropped", ...base, payload: {} });
  assert.equal(db.get("moons.byId", { id: moon }).status, "dropped");
  append(db, { kind: "moon.cleared", ...base, payload: {} });
  const m = db.get("moons.byId", { id: moon }); assert.equal(m.body_status, "barren"); assert.equal(m.task_id, null); assert.equal(m.status, null);
  db.close();
});
