import test from "node:test";
import assert from "node:assert/strict";
import { worldWithMoon } from "../fixtures/world.mjs";
import { append, rowToEvent } from "../../dist/db/events.js";
import { snapshot, moonDetail } from "../../dist/server/commands/query.js";
import { sendDelivery } from "../../dist/server/commands/delivery.js";
import { sendCustoms } from "../../dist/server/commands/customs.js";
import { dockCargo } from "../../dist/server/commands/dock.js";

const iso = (ms = 0) => new Date(Date.now() + ms).toISOString();
const ctx = { ownPid: process.pid, failures: [] };
function config(c, { pool = true, refuel = false, level = "manual", roles } = {}) {
  if (pool) c.providers.fake.pool = {
    kind: "window", reserve_floor: 0.1,
    ...(refuel ? { refuel: { provider: "probe", models: { terra: "m-cheap" }, min_wait_minutes: 0 } } : {}),
  };
  if (refuel) c.providers.probe = { adapter: "fake", pool: { kind: "window", reserve_floor: 0.1 } };
  c.roles = roles ?? { implement: ["fake"], review: ["fake"] };
  c.fleet.freighters = 3;
  c.automation = { level, max_fix_rounds: 3 };
}
function reading(w, used, extra = {}) {
  const resets_at = extra.resets_at ?? iso(3_600_000);
  append(w.g.db, { kind: "fuel.reading", provider: "fake", ts: extra.ts, payload: { window: "5h", used, resets_at, source: "reported" } });
  return resets_at;
}
function exhausted(w) {
  const until = iso(3_600_000);
  append(w.g.db, { kind: "fuel.exhausted", provider: "fake", payload: { until, voyage_id: "prior" } });
  return until;
}
function views(w) {
  const snap = snapshot(w.g, ctx);
  const moon = snap.systems.flatMap((s) => s.planets).flatMap((p) => p.moons).find((m) => m.task_id === "T1");
  return { snap, moon, detail: moonDetail(w.g, "T1", ctx) };
}

test("1. pools follow implement then review role order without duplicates", async () => {
  const w = await worldWithMoon("happy", (c) => config(c, { roles: { implement: ["codex", "fake"], review: ["claude", "fake"] } }));
  try { assert.deepEqual(snapshot(w.g, ctx).pools.map((p) => p.provider), ["codex", "fake", "claude"]); } finally { w.cleanup(); }
});

test("2. a provider without a pool is free unless a live exhaustion makes it dry", async () => {
  const w = await worldWithMoon("happy", (c) => config(c, { pool: false }));
  try {
    assert.deepEqual(snapshot(w.g, ctx).pools[0], { provider: "fake", kind: "free", state: "free", reserve_floor: 0, windows: [] });
    const until = exhausted(w), pool = snapshot(w.g, ctx).pools[0];
    assert.deepEqual(pool, { provider: "fake", kind: "free", state: "dry", until, reserve_floor: 0, windows: [] });
  } finally { w.cleanup(); }
});

test("3. a configured pool without fuel events is unknown", async () => {
  const w = await worldWithMoon("happy", (c) => config(c));
  try { assert.deepEqual(snapshot(w.g, ctx).pools[0], { provider: "fake", kind: "window", state: "unknown", reserve_floor: 0.1, windows: [] }); } finally { w.cleanup(); }
});

test("4. current readings expose ok and low pool state and windows", async () => {
  const w = await worldWithMoon("happy", (c) => config(c));
  try {
    const firstTs = iso(), resets_at = reading(w, 0.2, { ts: firstTs });
    let pool = snapshot(w.g, ctx).pools[0];
    assert.equal(pool.state, "ok"); assert.ok(Math.abs(pool.remaining - 0.8) < 1e-9);
    assert.equal(pool.resets_at, resets_at); assert.equal(pool.reading_ts, firstTs);
    assert.deepEqual(pool.windows, [{ window: "5h", used: 0.2, resets_at, ts: firstTs }]);
    const secondTs = iso(1); reading(w, 0.95, { ts: secondTs, resets_at });
    pool = snapshot(w.g, ctx).pools[0]; assert.equal(pool.state, "low"); assert.ok(Math.abs(pool.remaining - 0.05) < 1e-9);
  } finally { w.cleanup(); }
});

test("5. a live exhaustion makes a pool dry while retaining its readings", async () => {
  const w = await worldWithMoon("happy", (c) => config(c));
  try {
    reading(w, 0.2); const until = exhausted(w), pool = snapshot(w.g, ctx).pools[0];
    assert.equal(pool.state, "dry"); assert.equal(pool.until, until); assert.equal(Object.hasOwn(pool, "remaining"), false); assert.equal(pool.windows.length, 1);
  } finally { w.cleanup(); }
});

test("6. a declared refuel exposes only its provider and model map", async () => {
  const w = await worldWithMoon("happy", (c) => { config(c, { refuel: true }); c.providers.fake.pool.refuel.min_wait_minutes = 30; });
  try { assert.deepEqual(snapshot(w.g, ctx).pools.find((p) => p.provider === "fake").refuel, { provider: "probe", models: { terra: "m-cheap" } }); } finally { w.cleanup(); }
});

test("7. an emitted moon waiting on low fuel reports the same hold in both reads", async () => {
  const w = await worldWithMoon("happy", (c) => config(c));
  try {
    const until = reading(w, 0.95), { moon, detail } = views(w), wait = { provider: "fake", reason: "low", until };
    assert.deepEqual(moon.waiting_on_fuel, wait); assert.equal(moon.can_refuel, null);
    assert.deepEqual(detail.moon.waiting_on_fuel, wait); assert.equal(detail.moon.can_refuel, null);
  } finally { w.cleanup(); }
});

test("8. a manual emitted moon reports an available refuel", async () => {
  const w = await worldWithMoon("happy", (c) => config(c, { refuel: true, level: "manual" }));
  try {
    const until = reading(w, 0.95), { moon, detail } = views(w), wait = { provider: "fake", reason: "low", until };
    assert.deepEqual(moon.waiting_on_fuel, wait); assert.deepEqual(moon.can_refuel, { provider: "probe", model: "m-cheap" });
    assert.deepEqual(detail.moon.waiting_on_fuel, wait); assert.deepEqual(detail.moon.can_refuel, { provider: "probe", model: "m-cheap" });
  } finally { w.cleanup(); }
});

test("9. customs ignores low fuel but waits when its provider is dry", async () => {
  const low = await worldWithMoon("happy", (c) => config(c));
  try { await sendDelivery(low.g, { taskId: "T1" }); reading(low, 0.95); const { moon, detail } = views(low); assert.equal(moon.waiting_on_fuel, null); assert.equal(moon.can_refuel, null); assert.equal(detail.moon.waiting_on_fuel, null); assert.equal(detail.moon.can_refuel, null); } finally { low.cleanup(); }
  const dry = await worldWithMoon("happy", (c) => config(c));
  try { await sendDelivery(dry.g, { taskId: "T1" }); const until = exhausted(dry), wait = { provider: "fake", reason: "dry", until }, { moon, detail } = views(dry); assert.deepEqual(moon.waiting_on_fuel, wait); assert.equal(moon.can_refuel, null); assert.deepEqual(detail.moon.waiting_on_fuel, wait); assert.equal(detail.moon.can_refuel, null); } finally { dry.cleanup(); }
});

test("10. moons with nothing to send have null fuel fields while barren moons have neither key", async () => {
  const merged = await worldWithMoon("happy", (c) => config(c));
  try { await sendDelivery(merged.g, { taskId: "T1" }); await sendCustoms(merged.g, { taskId: "T1", reviewScript: "review-approve" }); dockCargo(merged.g, { taskId: "T1" }); exhausted(merged); const { snap, moon, detail } = views(merged); assert.equal(moon.waiting_on_fuel, null); assert.equal(moon.can_refuel, null); assert.equal(detail.moon.waiting_on_fuel, null); assert.equal(detail.moon.can_refuel, null); const barren = snap.systems.flatMap((s) => s.planets).flatMap((p) => p.moons).find((m) => m.body_status === "barren"); assert.equal(Object.hasOwn(barren, "waiting_on_fuel"), false); assert.equal(Object.hasOwn(barren, "can_refuel"), false); } finally { merged.cleanup(); }
  const adrift = await worldWithMoon("crash-midrun", (c) => config(c));
  try { await sendDelivery(adrift.g, { taskId: "T1" }); exhausted(adrift); const { moon, detail } = views(adrift); assert.equal(moon.waiting_on_fuel, null); assert.equal(moon.can_refuel, null); assert.equal(detail.moon.waiting_on_fuel, null); assert.equal(detail.moon.can_refuel, null); } finally { adrift.cleanup(); }
});

test("11. cargo awaiting pickup reports that it waits on dry fuel", async () => {
  const w = await worldWithMoon("wall", (c) => config(c));
  try { await sendDelivery(w.g, { taskId: "T1" }); const event = w.g.db.all("events.latestByKindProvider", { kind: "fuel.exhausted", provider: "fake", limit: 1 }).map(rowToEvent)[0], { moon, detail } = views(w); assert.equal(moon.waiting_on_fuel.reason, "dry"); assert.equal(moon.waiting_on_fuel.until, event.payload.until); assert.deepEqual(detail.moon.waiting_on_fuel, moon.waiting_on_fuel); } finally { w.cleanup(); }
});

test("12. refuelled and plain voyages expose their refuel mark without changing owner", async () => {
  const refuel = await worldWithMoon("happy", (c) => config(c, { refuel: true }));
  try { reading(refuel, 0.95); const launched = await sendDelivery(refuel.g, { taskId: "T1", refuel: true }), { snap, detail } = views(refuel); const a = snap.voyages.find((v) => v.id === launched.voyageId), b = detail.voyages.find((v) => v.id === launched.voyageId); assert.equal(a.refuel_for, "fake"); assert.equal(b.refuel_for, "fake"); assert.equal(a.owner, null); assert.equal(b.owner, null); } finally { refuel.cleanup(); }
  const plain = await worldWithMoon("happy", (c) => config(c));
  try { const launched = await sendDelivery(plain.g, { taskId: "T1" }), { snap, detail } = views(plain); const a = snap.voyages.find((v) => v.id === launched.voyageId), b = detail.voyages.find((v) => v.id === launched.voyageId); assert.equal(a.refuel_for, null); assert.equal(b.refuel_for, null); assert.equal(a.owner, null); assert.equal(b.owner, null); } finally { plain.cleanup(); }
});
