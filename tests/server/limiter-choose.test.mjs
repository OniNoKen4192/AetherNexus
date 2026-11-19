import { test } from "node:test";
import assert from "node:assert/strict";
import { makeGalaxy } from "../helpers.mjs";
import { worldWithMoon } from "../fixtures/world.mjs";
import { append } from "../../dist/db/events.js";
import { loadMoon, moonScope } from "../../dist/server/dispatch.js";
import { chooseProvider, fuelCheck, fuelHold } from "../../dist/server/limiter/limiter.js";

const T = Date.parse("2026-11-17T12:00:00.000Z");
const iso = (offset) => new Date(T + offset).toISOString();
function patch(c, refuel = false) {
  c.providers.fake.pool = { kind: "window", reserve_floor: 0.1, ...(refuel ? { refuel: { provider: "probe", models: { sol: "haiku-model" }, min_wait_minutes: 30 } } : {}) };
  c.providers.probe = { adapter: "fake", pool: { kind: "window", reserve_floor: 0.1 } };
  c.roles = { implement: ["fake", "probe"], review: ["fake", "probe"] };
  c.fleet.freighters = 3; c.fleet.customs = 2;
}
async function world(refuel = false) { const w = await makeGalaxy((c) => patch(c, refuel)); w.g.now = () => T; return w; }
function read(w, provider, used, extra = {}) { append(w.g.db, { kind: "fuel.reading", provider, ts: iso(0), payload: { window: "window", used, ...(extra.resets_at === null ? {} : { resets_at: extra.resets_at ?? iso(3_600_000) }), source: "reported", ...(extra.model_family ? { model_family: extra.model_family } : {}) } }); }
const pick = (g, extra = {}) => chooseProvider(g, { role: "implement", tier: "sol", mayRefuel: false, ...extra });
const LOW = { kind: "held", provider: "fake", reason: "low", until: "2026-11-17T13:00:00.000Z" };
async function assignedWorld(freighters, max) {
  const w = await worldWithMoon("happy", (c) => {
    patch(c);
    c.fleet.freighters = freighters;
    c.scheduler.per_provider_max = max === undefined ? {} : { fake: max };
  });
  w.g.now = () => T;
  return w;
}
function launch(w, provider = "fake") {
  const scope = moonScope(w.g, loadMoon(w.g, "T1"));
  append(w.g.db, { kind: "moon.gated", ...scope, payload: { base_sha: "0".repeat(40), state_path: ".nexus/state/T1.json", round: 1 } });
  const ship = w.g.db.get("ships.pickIdle", { class: "freighter", fleet: provider });
  const voyageId = `${ship.id}/T1/implement/1`;
  append(w.g.db, { kind: "voyage.launched", ...scope, ts: iso(0), voyage_id: voyageId, ship_id: ship.id, provider, payload: { role: "implement", round: 1, provider, ship_id: ship.id, worktree: "w" } });
  return voyageId;
}

test("fuelCheck holds dry for both roles, low only for implement, and allows other states", async () => {
  const w = await world();
  try {
    read(w, "fake", 0.95);
    assert.deepEqual(fuelCheck(w.g, "implement", "fake"), { allow: false, reason: "low", until: iso(3_600_000) });
    assert.deepEqual(fuelCheck(w.g, "review", "fake"), { allow: true });
    append(w.g.db, { kind: "fuel.exhausted", provider: "fake", ts: iso(1), payload: { until: iso(7_200_000), voyage_id: "v" } });
    assert.equal(fuelCheck(w.g, "implement", "fake").reason, "dry"); assert.equal(fuelCheck(w.g, "review", "fake").reason, "dry");
    assert.deepEqual(fuelCheck(w.g, "implement", "probe"), { allow: true });
  } finally { w.cleanup(); }
});

test("chooser flies, reroutes only for fuel, honors requested, and override bypasses dry", async () => {
  const w = await world();
  try {
    read(w, "fake", 0.95); read(w, "probe", 0.2);
    const rerouted = pick(w.g); assert.equal(rerouted.provider, "probe"); assert.deepEqual(rerouted.reroutedFrom, { provider: "fake", reason: "low" });
    assert.equal(pick(w.g, { requested: "probe" }).provider, "probe");
    assert.equal(pick(w.g, { requested: "fake" }).kind, "held");
    append(w.g.db, { kind: "fuel.exhausted", provider: "fake", ts: iso(1), payload: { until: iso(7_200_000), voyage_id: "v" } });
    const forced = pick(w.g, { requested: "fake", override: true }); assert.equal(forced.kind, "fly"); assert.equal(forced.reroutedFrom, undefined);
  } finally { w.cleanup(); }
});

test("chooser reproduces exact none messages and silently skips unavailable providers", async () => {
  const w = await world();
  try {
    w.g.config.roles.implement = []; assert.deepEqual(pick(w.g), { kind: "none", message: "no provider is configured for the implement role" });
    assert.deepEqual(pick(w.g, { requested: "missing" }), { kind: "none", message: "provider 'missing' is not configured" });
    w.g.config.roles.implement = ["fake", "probe"];
    w.g.config.scheduler.per_provider_max.fake = 1;
    const capped = { free: 2, providerUse: new Map([["fake", 1]]), claimed: new Set() };
    const skipped = pick(w.g, { capacity: capped }); assert.equal(skipped.kind, "fly"); assert.equal(skipped.provider, "probe"); assert.equal(skipped.reroutedFrom, undefined);
    assert.deepEqual(pick(w.g, { requested: "fake", capacity: capped }), { kind: "none", message: "provider 'fake' is at its limit of 1 (scheduler.per_provider_max)" });
    const claimed = new Set(w.g.db.all("ships.all").filter((s) => s.fleet === "fake" && s.class === "freighter").map((s) => s.id));
    assert.deepEqual(pick(w.g, { requested: "fake", capacity: { free: 1, providerUse: new Map(), claimed } }), { kind: "none", message: "all freighters in fleet 'fake' are assigned" });
  } finally { w.cleanup(); }
});

test("refuel flies or advertises canRefuel only when all conditions pass", async () => {
  const w = await world(true);
  try {
    read(w, "fake", 0.95, { resets_at: iso(3_600_000) });
    const held = pick(w.g, { requested: "fake" }); assert.equal(held.kind, "held"); assert.deepEqual(held.canRefuel, { provider: "probe", model: "haiku-model" });
    const refuelled = pick(w.g, { requested: "fake", mayRefuel: true }); assert.equal(refuelled.kind, "fly"); assert.equal(refuelled.provider, "probe"); assert.equal(refuelled.model, "haiku-model"); assert.deepEqual(refuelled.refuelFor, { provider: "fake", reason: "low" });
    read(w, "probe", 0.99, { model_family: "opus" });
    assert.equal(pick(w.g, { requested: "fake", mayRefuel: true }).kind, "fly", "unrelated family does not block mapped model");
    w.g.config.providers.fake.pool.refuel.min_wait_minutes = 90;
    assert.equal(pick(w.g, { requested: "fake" }).canRefuel, undefined, "a reset inside minimum wait cannot refuel");
  } finally { w.cleanup(); }
});

test("capacity claims unique ships, enforces free and provider caps, and mutates only its view", async () => {
  const w = await world();
  try {
    w.g.config.scheduler.per_provider_max.fake = 1;
    const capacity = { free: 2, providerUse: new Map(), claimed: new Set() };
    const a = pick(w.g, { capacity }); const b = pick(w.g, { capacity }); const c = pick(w.g, { capacity });
    assert.equal(a.provider, "fake"); assert.equal(b.provider, "probe"); assert.notEqual(a.shipId, b.shipId);
    assert.deepEqual(c, { kind: "none", message: "the concurrency limit is reached" });
    assert.equal(capacity.providerUse.get("fake"), 1); assert.equal(capacity.claimed.size, 2);
  } finally { w.cleanup(); }
});

test("chooseProvider and fuelHold append nothing; fuelHold handles held, fly, and unknown moons", async () => {
  const w = await worldWithMoon("happy", (c) => { patch(c, true); });
  w.g.now = () => T;
  try {
    const before = w.g.db.get("events.maxId").id;
    read(w, "fake", 0.95); read(w, "probe", 0.95);
    assert.equal(fuelHold(w.g, "T1", "send").kind, "held");
    assert.equal(fuelHold(w.g, "missing", "send"), null);
    assert.equal(w.g.db.get("events.maxId").id, before + 2);
    read(w, "fake", 0.2); assert.equal(fuelHold(w.g, "T1", "send"), null);
    const afterRead = w.g.db.get("events.maxId").id; pick(w.g); assert.equal(w.g.db.get("events.maxId").id, afterRead);
  } finally { w.cleanup(); }
});

test("c10: ok, unknown and free allow both roles", async () => {
  const w = await world();
  try {
    read(w, "fake", 0.2);
    assert.deepEqual(fuelCheck(w.g, "implement", "fake"), { allow: true });
    assert.deepEqual(fuelCheck(w.g, "review", "fake"), { allow: true });
    assert.deepEqual(fuelCheck(w.g, "implement", "probe"), { allow: true });
    assert.deepEqual(fuelCheck(w.g, "review", "probe"), { allow: true });
    delete w.g.config.providers.probe.pool;
    assert.deepEqual(fuelCheck(w.g, "implement", "probe"), { allow: true });
    assert.deepEqual(fuelCheck(w.g, "review", "probe"), { allow: true });
    append(w.g.db, { kind: "fuel.exhausted", provider: "fake", ts: iso(1), payload: { until: "2026-11-17T14:00:00.000Z", voyage_id: "v" } });
    assert.deepEqual(fuelCheck(w.g, "implement", "fake"), { allow: false, reason: "dry", until: "2026-11-17T14:00:00.000Z" });
    assert.deepEqual(fuelCheck(w.g, "review", "fake"), { allow: false, reason: "dry", until: "2026-11-17T14:00:00.000Z" });
  } finally { w.cleanup(); }
});

test("c11: a single ok provider flies with no reroutedFrom", async () => {
  const w = await world();
  try {
    w.g.config.roles.implement = ["fake"];
    read(w, "fake", 0.2);
    const choice = pick(w.g);
    const freighters = w.g.db.all("ships.all").filter((ship) => ship.fleet === "fake" && ship.class === "freighter" && ship.status === "idle").map((ship) => ship.id);
    assert.equal(choice.kind, "fly");
    assert.equal(choice.provider, "fake");
    assert.ok(freighters.includes(choice.shipId));
    assert.equal("reroutedFrom" in choice, false);
    assert.equal("refuelFor" in choice, false);
    assert.equal("model" in choice, false);
  } finally { w.cleanup(); }
});

test("c12: review flies on a low first provider", async () => {
  const w = await world();
  try {
    read(w, "fake", 0.95); read(w, "probe", 0.2);
    const choice = chooseProvider(w.g, { role: "review", tier: null, mayRefuel: false });
    const ship = w.g.db.get("ships.byId", { id: choice.shipId });
    assert.equal(choice.kind, "fly");
    assert.equal(choice.provider, "fake");
    assert.equal(ship.class, "customs");
    assert.equal(ship.fleet, "fake");
    assert.equal("reroutedFrom" in choice, false);
  } finally { w.cleanup(); }
});

test("c13: a first provider with every freighter assigned is skipped without reroutedFrom", async () => {
  const w = await assignedWorld(1);
  try {
    read(w, "fake", 0.2); read(w, "probe", 0.2); launch(w, "fake");
    const choice = pick(w.g);
    assert.equal(choice.kind, "fly");
    assert.equal(choice.provider, "probe");
    assert.equal("reroutedFrom" in choice, false);
  } finally { w.cleanup(); }
});

test("c14: a low provider is held with until and a dry one is held for both roles", async () => {
  const w = await world();
  try {
    read(w, "fake", 0.95);
    assert.deepEqual(pick(w.g, { requested: "fake" }), LOW);
    append(w.g.db, { kind: "fuel.exhausted", provider: "fake", ts: iso(1), payload: { until: "2026-11-17T14:00:00.000Z", voyage_id: "v" } });
    const dry = { kind: "held", provider: "fake", reason: "dry", until: "2026-11-17T14:00:00.000Z" };
    assert.deepEqual(pick(w.g, { requested: "fake" }), dry);
    assert.deepEqual(chooseProvider(w.g, { role: "review", tier: null, mayRefuel: false, requested: "fake" }), dry);
  } finally { w.cleanup(); }
});

test("c15: without capacity the at-limit and all-assigned messages are exact", async () => {
  const capped = await assignedWorld(2, 1), assigned = await assignedWorld(1);
  try {
    launch(capped, "fake");
    assert.deepEqual(pick(capped.g, { requested: "fake" }), { kind: "none", message: "provider 'fake' is at its limit of 1 (scheduler.per_provider_max)" });
    launch(assigned, "fake");
    assert.deepEqual(pick(assigned.g, { requested: "fake" }), { kind: "none", message: "all freighters in fleet 'fake' are assigned" });
  } finally { capped.cleanup(); assigned.cleanup(); }
});

test("c16: requested flies the second provider while the first is fine", async () => {
  const w = await world();
  try {
    read(w, "fake", 0.2); read(w, "probe", 0.2);
    assert.equal(pick(w.g).provider, "fake");
    const choice = pick(w.g, { requested: "probe" });
    assert.equal(choice.kind, "fly");
    assert.equal(choice.provider, "probe");
    assert.equal("reroutedFrom" in choice, false);
  } finally { w.cleanup(); }
});

test("c18: a dry hold refuels with refuelFor reason dry", async () => {
  const w = await world(true);
  try {
    append(w.g.db, { kind: "fuel.exhausted", provider: "fake", ts: iso(0), payload: { until: "2026-11-17T14:00:00.000Z", voyage_id: "v" } });
    const choice = pick(w.g, { requested: "fake", mayRefuel: true });
    assert.equal(choice.kind, "fly");
    assert.equal(choice.provider, "probe");
    assert.equal(choice.model, "haiku-model");
    assert.deepEqual(choice.refuelFor, { provider: "fake", reason: "dry" });
    assert.equal("reroutedFrom" in choice, false);
    assert.deepEqual(pick(w.g, { requested: "fake", mayRefuel: false }), { kind: "held", provider: "fake", reason: "dry", until: "2026-11-17T14:00:00.000Z", canRefuel: { provider: "probe", model: "haiku-model" } });
  } finally { w.cleanup(); }
});

test("c19: each refuel condition failing alone is held without canRefuel", async () => {
  const cases = [
    async (w) => { delete w.g.config.providers.fake.pool.refuel; },
    async () => ({ tier: null }),
    async () => ({ tier: "luna" }),
    async (w) => { read(w, "probe", 0.95); },
    async (w) => { append(w.g.db, { kind: "fuel.exhausted", provider: "probe", ts: iso(1), payload: { until: "2026-11-17T14:00:00.000Z", voyage_id: "v" } }); },
    async (w) => { w.g.config.providers.fake.pool.refuel.min_wait_minutes = 90; },
    async (w) => { w.g.config.providers.fake.pool.refuel.min_wait_minutes = 60; },
    async (w) => ({ capacity: { free: 5, providerUse: new Map(), claimed: new Set(w.g.db.all("ships.all").filter((ship) => ship.fleet === "probe" && ship.class === "freighter").map((ship) => ship.id)) } }),
    async (w) => { w.g.config.scheduler.per_provider_max.probe = 1; return { capacity: { free: 5, providerUse: new Map([["probe", 1]]), claimed: new Set() } }; },
  ];
  for (const setup of cases) {
    const w = await world(true);
    try {
      read(w, "fake", 0.95);
      const extra = await setup(w) ?? {};
      assert.deepEqual(pick(w.g, { requested: "fake", ...extra }), LOW);
    } finally { w.cleanup(); }
  }
});

test("c19: an unknown until allows the refuel", async () => {
  const w = await world(true);
  try {
    read(w, "fake", 0.95, { resets_at: null });
    assert.deepEqual(pick(w.g, { requested: "fake" }), { kind: "held", provider: "fake", reason: "low", canRefuel: { provider: "probe", model: "haiku-model" } });
    const choice = pick(w.g, { requested: "fake", mayRefuel: true });
    assert.equal(choice.kind, "fly");
    assert.equal(choice.provider, "probe");
    assert.equal(choice.model, "haiku-model");
    assert.deepEqual(choice.refuelFor, { provider: "fake", reason: "low" });
  } finally { w.cleanup(); }
});

test("c19: a tier that is not an own key of refuel.models cannot refuel", async () => {
  const w = await world(true);
  try {
    read(w, "fake", 0.95);
    for (const tier of ["constructor", "toString", "hasOwnProperty", "__proto__"]) assert.deepEqual(pick(w.g, { requested: "fake", mayRefuel: true, tier }), LOW);
  } finally { w.cleanup(); }
});

test("c21: flights on one fleet take different ships", async () => {
  const w = await world();
  try {
    read(w, "fake", 0.2);
    const capacity = { free: 5, providerUse: new Map(), claimed: new Set() };
    const choices = [pick(w.g, { requested: "fake", capacity }), pick(w.g, { requested: "fake", capacity }), pick(w.g, { requested: "fake", capacity })];
    assert.deepEqual(choices.map((choice) => choice.kind), ["fly", "fly", "fly"]);
    assert.equal(new Set(choices.map((choice) => choice.shipId)).size, 3);
    assert.equal(capacity.free, 2);
    assert.equal(capacity.providerUse.get("fake"), 3);
    assert.deepEqual(capacity.claimed, new Set(choices.map((choice) => choice.shipId)));
    assert.deepEqual(pick(w.g, { requested: "fake", capacity }), { kind: "none", message: "all freighters in fleet 'fake' are assigned" });
  } finally { w.cleanup(); }
});
