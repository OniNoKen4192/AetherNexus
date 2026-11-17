import { test } from "node:test";
import assert from "node:assert/strict";
import { makeGalaxy } from "../helpers.mjs";
import { worldWithMoon } from "../fixtures/world.mjs";
import { append } from "../../dist/db/events.js";
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
function read(w, provider, used, extra = {}) { append(w.g.db, { kind: "fuel.reading", provider, ts: iso(0), payload: { window: "window", used, resets_at: extra.resets_at ?? iso(3_600_000), source: "reported", ...(extra.model_family ? { model_family: extra.model_family } : {}) } }); }
const pick = (g, extra = {}) => chooseProvider(g, { role: "implement", tier: "sol", mayRefuel: false, ...extra });

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
    assert.equal(fuelHold(w.g, "T1", "launch").kind, "held");
    assert.equal(fuelHold(w.g, "missing", "launch"), null);
    assert.equal(w.g.db.get("events.maxId").id, before + 2);
    read(w, "fake", 0.2); assert.equal(fuelHold(w.g, "T1", "launch"), null);
    const afterRead = w.g.db.get("events.maxId").id; pick(w.g); assert.equal(w.g.db.get("events.maxId").id, afterRead);
  } finally { w.cleanup(); }
});
