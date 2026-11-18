import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { worldWithMoon } from "../fixtures/world.mjs";
import { append, rowToEvent } from "../../dist/db/events.js";
import { rebuild, dumpProjections } from "../../dist/db/rebuild.js";
import { launchMoon } from "../../dist/server/commands/launch.js";
import { loadMoon } from "../../dist/server/dispatch.js";

const iso = (ms = 0) => new Date(Date.now() + ms).toISOString();
function config(c, { probe = false, refuel = false, level = "manual" } = {}) {
  c.providers.fake.pool = { kind: "window", reserve_floor: 0.1, ...(refuel ? { refuel: { provider: "probe", models: { terra: "m-cheap" }, min_wait_minutes: 0 } } : {}) };
  if (probe || refuel) c.providers.probe = { adapter: "fake", pool: { kind: "window", reserve_floor: 0.1 } };
  c.roles = { implement: probe ? ["fake", "probe"] : ["fake"], review: ["fake"] };
  c.fleet.freighters = 3;
  c.automation = { level, max_fix_rounds: 3 };
}
function low(w) {
  const resets_at = iso(3_600_000);
  append(w.g.db, { kind: "fuel.reading", provider: "fake", payload: { window: "5h", used: 0.95, resets_at, source: "reported" } });
  return resets_at;
}
function dry(w) {
  const until = iso(3_600_000);
  append(w.g.db, { kind: "fuel.exhausted", provider: "fake", payload: { until, voyage_id: "prior" } });
  return until;
}
const events = (w, kind) => w.g.db.all("events.byAssignment", { assignment_id: loadMoon(w.g, "T1").assignment_id }).map(rowToEvent).filter((e) => e.kind === kind);
function stable(w) { const before = dumpProjections(w.g.db); rebuild(w.g.db); assert.equal(dumpProjections(w.g.db), before); }

test("1. a low sole provider holds a launch with fuel details", async () => {
  const w = await worldWithMoon("happy", (c) => config(c));
  try { const until = low(w); await assert.rejects(launchMoon(w.g, { taskId: "T1" }), (e) => { assert.match(e.message, /is waiting on fake fuel \(low\), resets /); assert.deepEqual(e.details, { provider: "fake", reason: "low", until, can_refuel: null }); return true; }); } finally { w.cleanup(); }
});

test("2. a fuel hold happens before every launch side effect", async () => {
  const w = await worldWithMoon("happy", (c) => config(c));
  try { low(w); const before = w.g.db.get("events.maxId").id; await assert.rejects(launchMoon(w.g, { taskId: "T1" })); assert.equal(fs.existsSync(path.join(w.dir, ".nexus", "worktrees", "T1")), false); assert.equal(events(w, "moon.gated").length, 0); assert.ok(w.g.db.all("ships.all").every((s) => s.status === "idle")); assert.equal(loadMoon(w.g, "T1").status, "emitted"); assert.equal(w.g.db.all("decisions.pending").length, 0); assert.equal(w.g.db.get("events.maxId").id, before); } finally { w.cleanup(); }
});

test("3. override flies through a low pool without limiter log events", async () => {
  const w = await worldWithMoon("happy", (c) => config(c));
  try { low(w); const r = await launchMoon(w.g, { taskId: "T1", override: true }); assert.equal(r.moonStatus, "audited"); assert.equal(w.g.db.get("voyages.byId", { id: r.voyageId }).provider, "fake"); assert.equal(events(w, "limiter.rerouted").length, 0); assert.equal(events(w, "limiter.refuelled").length, 0); stable(w); } finally { w.cleanup(); }
});

test("4. a second wall hit after pickup parks the moon as rate_limited", async () => {
  const w = await worldWithMoon("wall-twice", (c) => config(c));
  try { const first = await launchMoon(w.g, { taskId: "T1" }); assert.equal(first.moonStatus, "awaiting_pickup"); await assert.rejects(launchMoon(w.g, { taskId: "T1" }), /waiting on fake fuel \(dry\)/); const second = await launchMoon(w.g, { taskId: "T1", override: true }); assert.equal(second.moonStatus, "adrift"); assert.equal(loadMoon(w.g, "T1").park_reason, "rate_limited"); assert.equal(w.g.db.all("decisions.pending").length, 1); stable(w); } finally { w.cleanup(); }
});

test("5. launch reroutes from a low provider and records the choice before launch", async () => {
  const w = await worldWithMoon("happy", (c) => config(c, { probe: true }));
  try { low(w); const r = await launchMoon(w.g, { taskId: "T1" }); assert.equal(w.g.db.get("voyages.byId", { id: r.voyageId }).provider, "probe"); const rerouted = events(w, "limiter.rerouted"); assert.equal(rerouted.length, 1); assert.deepEqual(rerouted[0].payload, { task_id: "T1", from: "fake", to: "probe", reason: "low" }); assert.ok(rerouted[0].id < events(w, "voyage.launched")[0].id); stable(w); } finally { w.cleanup(); }
});

test("6. a requested held provider is not rerouted", async () => {
  const w = await worldWithMoon("happy", (c) => config(c, { probe: true }));
  try { low(w); await assert.rejects(launchMoon(w.g, { taskId: "T1", provider: "fake" }), /waiting on fake fuel/); assert.equal(events(w, "limiter.rerouted").length, 0); } finally { w.cleanup(); }
});

test("7. refuel by hand flies the mapped model and records the refuel", async () => {
  const w = await worldWithMoon("happy", (c) => config(c, { refuel: true }));
  try { low(w); await assert.rejects(launchMoon(w.g, { taskId: "T1" }), (e) => { assert.deepEqual(e.details.can_refuel, { provider: "probe", model: "m-cheap" }); return true; }); const r = await launchMoon(w.g, { taskId: "T1", refuel: true }); const voyage = w.g.db.get("voyages.byId", { id: r.voyageId }); assert.equal(voyage.provider, "probe"); assert.equal(voyage.model, "m-cheap"); assert.equal(events(w, "voyage.launched")[0].payload.refuel_for, "fake"); assert.ok(events(w, "voyage.event").some((e) => e.payload.event?.data?.text === "fake: model m-cheap")); assert.deepEqual(events(w, "limiter.refuelled")[0].payload, { task_id: "T1", from: "fake", to: "probe", model: "m-cheap", reason: "low" }); stable(w); } finally { w.cleanup(); }
});

test("8. verdict trust refuels a dry provider without a flag", async () => {
  const w = await worldWithMoon("happy", (c) => config(c, { refuel: true, level: "verdicts" }));
  try { dry(w); const r = await launchMoon(w.g, { taskId: "T1" }); assert.equal(w.g.db.get("voyages.byId", { id: r.voyageId }).provider, "probe"); assert.equal(events(w, "limiter.refuelled")[0].payload.reason, "dry"); stable(w); } finally { w.cleanup(); }
});

test("9. refuel cannot invent an undeclared refuel provider", async () => {
  const w = await worldWithMoon("happy", (c) => config(c));
  try { low(w); await assert.rejects(launchMoon(w.g, { taskId: "T1", refuel: true }), (e) => { assert.equal(e.details.can_refuel, null); return true; }); } finally { w.cleanup(); }
});

test("10. cargo awaiting pickup relaunches without a reply", async () => {
  const w = await worldWithMoon("wall", (c) => config(c));
  try { assert.equal((await launchMoon(w.g, { taskId: "T1" })).moonStatus, "awaiting_pickup"); const r = await launchMoon(w.g, { taskId: "T1", override: true }); assert.equal(r.moonStatus, "audited"); assert.equal(r.audit.verdict, "clean"); assert.equal(loadMoon(w.g, "T1").round, 2); stable(w); } finally { w.cleanup(); }
});

test("11. an adrift moon still needs a reply", async () => {
  const w = await worldWithMoon("crash-midrun", (c) => config(c));
  try { assert.equal((await launchMoon(w.g, { taskId: "T1" })).moonStatus, "adrift"); await assert.rejects(launchMoon(w.g, { taskId: "T1" }), /adrift.*reply/); } finally { w.cleanup(); }
});

test("12. a RATE_LIMITED report awaits pickup while BLOCKED still parks", async () => {
  for (const status of ["RATE_LIMITED", "BLOCKED"]) {
    const w = await worldWithMoon("happy", (c) => config(c));
    try { w.g.adapters.fake = { id: "fake", roles: ["implement", "review"], classify: () => "unknown", async *dispatch() { yield { kind: "done", ts: iso(), data: { report: { status, blocked_reason: status.toLowerCase(), raw: `STATUS: ${status}` } } }; } }; const r = await launchMoon(w.g, { taskId: "T1" }); const moon = loadMoon(w.g, "T1"), voyage = w.g.db.get("voyages.byId", { id: r.voyageId }); if (status === "RATE_LIMITED") { assert.equal(moon.status, "awaiting_pickup"); assert.equal(moon.park_reason, null); assert.equal(voyage.status, "out_of_fuel"); assert.equal(w.g.db.get("ships.byId", { id: voyage.ship_id }).status, "idle"); assert.equal(w.g.db.all("decisions.pending").length, 0); assert.equal(events(w, "fuel.exhausted").length, 1); stable(w); } else { assert.equal(moon.status, "adrift"); assert.equal(moon.park_reason, "blocked"); } } finally { w.cleanup(); }
  }
});
