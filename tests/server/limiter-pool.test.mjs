import { test } from "node:test";
import assert from "node:assert/strict";
import { makeGalaxy } from "../helpers.mjs";
import { idleShip, worldWithMoon } from "../fixtures/world.mjs";
import { append, rowToEvent } from "../../dist/db/events.js";
import { loadMoon, moonScope } from "../../dist/server/dispatch.js";
import { poolReadings, poolState, recordReading } from "../../dist/server/limiter/pool.js";

const T = Date.parse("2026-11-17T12:00:00.000Z");
const iso = (offset) => new Date(T + offset).toISOString();
async function world(pool = { kind: "window", reserve_floor: 0.1 }) {
  const w = await makeGalaxy((c) => { c.roles = { implement: ["fake"], review: ["fake"] }; c.providers.fake.pool = pool; });
  w.g.now = () => T;
  return w;
}
const reading = (w, used, extra = {}) => append(w.g.db, { kind: "fuel.reading", provider: "fake", ts: extra.ts ?? iso(0), payload: { window: extra.window ?? "five-hour", used, source: "reported", ...(extra.resets_at === null ? {} : { resets_at: extra.resets_at ?? iso(60_000) }), ...(extra.model_family ? { model_family: extra.model_family } : {}) } });
async function voyageWorld() {
  const w = await worldWithMoon("happy", (c) => {
    c.providers.fake.pool = { kind: "window", reserve_floor: 0.1 };
    c.providers.probe = { adapter: "fake", pool: { kind: "window", reserve_floor: 0.1 } };
    c.roles = { implement: ["fake", "probe"], review: ["fake", "probe"] };
    c.fleet.freighters = 2;
    c.scheduler.per_provider_max = {};
  });
  w.g.now = () => T + 30_000;
  return w;
}
function voyage(w, provider, launchedTs, returnedTs, model) {
  const scope = moonScope(w.g, loadMoon(w.g, "T1"));
  append(w.g.db, { kind: "moon.gated", ...scope, payload: { base_sha: "0".repeat(40), state_path: ".nexus/state/T1.json", round: 1 } });
  const ship = idleShip(w.g.db, provider);
  const voyageId = `${ship.id}/T1/implement/1`;
  append(w.g.db, { kind: "voyage.launched", ...scope, ts: launchedTs, voyage_id: voyageId, ship_id: ship.id, provider, payload: { role: "implement", round: 1, provider, ship_id: ship.id, worktree: "w", ...(model === undefined ? {} : { model }) } });
  if (returnedTs !== undefined) append(w.g.db, { kind: "voyage.returned", ...scope, ts: returnedTs, voyage_id: voyageId, payload: { role: "implement", report: {} } });
  return voyageId;
}

test("pool state distinguishes unknown and free providers", async () => {
  const w = await world();
  try {
    assert.deepEqual(poolState(w.g, "fake"), { state: "unknown" });
    delete w.g.config.providers.fake.pool;
    assert.deepEqual(poolState(w.g, "fake"), { state: "free" });
    w.g.config.providers.fake.pool = { kind: "free" };
    assert.deepEqual(poolState(w.g, "fake"), { state: "free" });
  } finally { w.cleanup(); }
});

test("readings choose the tightest live window and newer readings supersede it", async () => {
  const w = await world();
  try {
    reading(w, 0.3, { window: "daily" }); reading(w, 0.8, { window: "weekly" });
    assert.ok(Math.abs(poolState(w.g, "fake").remaining - 0.2) < 1e-9);
    reading(w, 0.1, { window: "weekly" });
    assert.ok(Math.abs(poolState(w.g, "fake").remaining - 0.7) < 1e-9);
    reading(w, 0.95, { window: "daily" });
    const state = poolState(w.g, "fake");
    assert.equal(state.state, "low"); assert.ok(Math.abs(state.remaining - 0.05) < 1e-9); assert.equal(state.window, "daily");
    reading(w, 0.9, { window: "daily" }); assert.equal(poolState(w.g, "fake").state, "ok");
  } finally { w.cleanup(); }
});

test("expired, stale, family-mismatched, and invalid readings do not constrain a model", async () => {
  const w = await world({ kind: "window", reserve_floor: 0.25 });
  try {
    reading(w, 0.8, { window: "expired", resets_at: iso(-1) });
    reading(w, 0.99, { window: "opus", model_family: "OpUs" });
    assert.equal(poolState(w.g, "fake", "claude-haiku-5-5").state, "unknown");
    assert.equal(poolState(w.g, "fake", "claude-opus-5-5").state, "low");
    assert.equal(poolState(w.g, "fake").state, "low");
    for (const value of [NaN, 7, -1, "x"]) reading(w, value, { window: `bad-${String(value)}` });
    assert.equal(poolReadings(w.g, "fake").filter((r) => r.window.startsWith("bad-")).length, 0);
    const stale = await world();
    try { reading(stale, 0.5, { resets_at: null, ts: iso(-23 * 60 * 60_000) }); assert.equal(poolState(stale.g, "fake").state, "ok"); stale.g.now = () => T + 2 * 60 * 60_000; assert.equal(poolState(stale.g, "fake").state, "unknown"); } finally { stale.cleanup(); }
  } finally { w.cleanup(); }
});

test("live exhaustion outranks free and respects time and model family", async () => {
  const w = await world();
  try {
    append(w.g.db, { kind: "fuel.exhausted", provider: "fake", ts: iso(0), payload: { until: iso(60_000), voyage_id: "v", model_family: "opus" } });
    delete w.g.config.providers.fake.pool;
    assert.equal(poolState(w.g, "fake", "claude-opus-5-5").state, "dry");
    assert.equal(poolState(w.g, "fake", "claude-haiku-5-5").state, "free");
    assert.equal(poolState(w.g, "fake").state, "dry");
    w.g.now = () => T + 60_001; assert.equal(poolState(w.g, "fake").state, "free");
  } finally { w.cleanup(); }
});

test("recordReading deduplicates close readings and writes a reported envelope event", async () => {
  const w = await world();
  try {
    const base = { window: "five-hour", used: 0.2, resets_at: iso(60_000) };
    assert.equal(recordReading(w.g, { task_id: "T1" }, "fake", base), true);
    assert.equal(recordReading(w.g, {}, "fake", base), false);
    assert.equal(recordReading(w.g, {}, "fake", { ...base, used: 0.205 }), false);
    assert.equal(recordReading(w.g, {}, "fake", { ...base, used: 0.22 }), true);
    assert.equal(recordReading(w.g, {}, "fake", { ...base, resets_at: iso(120_000) }), true);
    assert.equal(recordReading(w.g, {}, "fake", { ...base, window: "daily" }), true);
    const event = rowToEvent(w.g.db.all("events.latestByKindProvider", { kind: "fuel.reading", provider: "fake", limit: 1 })[0]);
    assert.equal(event.provider, "fake"); assert.equal(event.payload.source, "reported");
  } finally { w.cleanup(); }
});

test("c2: an ok reading reports remaining, window, resets_at and reading_ts", async () => {
  const w = await world();
  try {
    reading(w, 0.2, { window: "five-hour", resets_at: "2026-11-17T12:01:00.000Z", ts: "2026-11-17T12:00:00.000Z" });
    assert.deepEqual(poolState(w.g, "fake"), { state: "ok", remaining: 0.8, window: "five-hour", resets_at: "2026-11-17T12:01:00.000Z", reading_ts: "2026-11-17T12:00:00.000Z" });
    reading(w, 0.95, { window: "five-hour", resets_at: "2026-11-17T12:01:00.000Z", ts: "2026-11-17T12:00:00.000Z" });
    const state = poolState(w.g, "fake");
    assert.equal(state.state, "low");
    assert.equal(state.window, "five-hour");
    assert.equal(state.resets_at, "2026-11-17T12:01:00.000Z");
    assert.equal(state.reading_ts, "2026-11-17T12:00:00.000Z");
    assert.ok(Math.abs(state.remaining - 0.05) < 1e-9);
  } finally { w.cleanup(); }
});

test("c2: a reading exactly at the reserve floor is ok", async () => {
  const w = await world();
  try {
    for (const [used, floor, over] of [[0.9, 0.1, 0.91], [0.8, 0.2, 0.81], [0.95, 0.05, 0.96], [0.7, 0.3, 0.71], [0.93, 0.07, 0.94], [0.67, 0.33, 0.68], [0.68, 0.32, 0.69], [0.45, 0.55, 0.46]]) {
      w.g.config.providers.fake.pool.reserve_floor = floor;
      reading(w, used);
      assert.equal(poolState(w.g, "fake").state, "ok");
      reading(w, over);
      assert.equal(poolState(w.g, "fake").state, "low");
    }
    delete w.g.config.providers.fake.pool.reserve_floor;
    reading(w, 1);
    assert.equal(poolState(w.g, "fake").state, "ok");
  } finally { w.cleanup(); }
});

test("c5: dry carries the until of the exhaustion", async () => {
  const w = await world();
  try {
    append(w.g.db, { kind: "fuel.exhausted", provider: "fake", ts: "2026-11-17T12:00:00.000Z", payload: { until: "2026-11-17T13:00:00.000Z", voyage_id: "v" } });
    assert.deepEqual(poolState(w.g, "fake"), { state: "dry", until: "2026-11-17T13:00:00.000Z" });
    w.g.now = () => Date.parse("2026-11-17T13:00:00.001Z");
    assert.deepEqual(poolState(w.g, "fake"), { state: "unknown" });
  } finally { w.cleanup(); }
});

test("c5: an exhaustion event without a usable until is skipped", async () => {
  const w = await world();
  const unusable = await world();
  try {
    append(w.g.db, { kind: "fuel.exhausted", provider: "fake", ts: iso(0), payload: { until: "2026-11-17T13:00:00.000Z", voyage_id: "v1" } });
    append(w.g.db, { kind: "fuel.exhausted", provider: "fake", ts: iso(1), payload: { until: "not a date", voyage_id: "v2" } });
    append(w.g.db, { kind: "fuel.exhausted", provider: "fake", ts: iso(2), payload: { voyage_id: "v3" } });
    assert.deepEqual(poolState(w.g, "fake"), { state: "dry", until: "2026-11-17T13:00:00.000Z" });
    append(unusable.g.db, { kind: "fuel.exhausted", provider: "fake", ts: iso(1), payload: { until: "not a date", voyage_id: "v2" } });
    append(unusable.g.db, { kind: "fuel.exhausted", provider: "fake", ts: iso(2), payload: { voyage_id: "v3" } });
    assert.deepEqual(poolState(unusable.g, "fake"), { state: "unknown" });
  } finally { w.cleanup(); unusable.cleanup(); }
});

test("c5: a newer expired exhaustion for one family does not hide a live one for another", async () => {
  const a = await world(), b = await world(), c = await world();
  try {
    append(a.g.db, { kind: "fuel.exhausted", provider: "fake", ts: "2026-11-17T09:00:00.000Z", payload: { model_family: "opus", until: "2026-11-18T12:00:00.000Z", voyage_id: "a1" } });
    append(a.g.db, { kind: "fuel.exhausted", provider: "fake", ts: "2026-11-17T10:00:00.000Z", payload: { model_family: "sonnet", until: "2026-11-17T11:00:00.000Z", voyage_id: "a2" } });
    assert.deepEqual(poolState(a.g, "fake"), { state: "dry", until: "2026-11-18T12:00:00.000Z" });
    assert.deepEqual(poolState(a.g, "fake", "claude-opus-5-5"), { state: "dry", until: "2026-11-18T12:00:00.000Z" });
    assert.deepEqual(poolState(a.g, "fake", "claude-sonnet-5-5"), { state: "unknown" });
    append(b.g.db, { kind: "fuel.exhausted", provider: "fake", ts: "2026-11-17T09:00:00.000Z", payload: { model_family: "opus", until: "2026-11-18T12:00:00.000Z", voyage_id: "b1" } });
    append(b.g.db, { kind: "fuel.exhausted", provider: "fake", ts: "2026-11-17T10:00:00.000Z", payload: { model_family: "opus", until: "2026-11-17T11:00:00.000Z", voyage_id: "b2" } });
    assert.deepEqual(poolState(b.g, "fake"), { state: "dry", until: "2026-11-18T12:00:00.000Z" });
    append(c.g.db, { kind: "fuel.exhausted", provider: "fake", ts: "2026-11-17T09:00:00.000Z", payload: { model_family: "opus", until: "2026-11-18T12:00:00.000Z", voyage_id: "c1" } });
    append(c.g.db, { kind: "fuel.exhausted", provider: "fake", ts: "2026-11-17T10:00:00.000Z", payload: { model_family: "sonnet", until: "2026-11-17T13:00:00.000Z", voyage_id: "c2" } });
    assert.deepEqual(poolState(c.g, "fake"), { state: "dry", until: "2026-11-18T12:00:00.000Z" });
    assert.deepEqual(poolState(c.g, "fake", "claude-sonnet-5-5"), { state: "dry", until: "2026-11-17T13:00:00.000Z" });
  } finally { a.cleanup(); b.cleanup(); c.cleanup(); }
});

test("a newer wall hit with a shorter reset does not shorten a live longer hold", async () => {
  const w = await world();
  try {
    append(w.g.db, { kind: "fuel.exhausted", provider: "fake", ts: iso(0), payload: { until: iso(3_600_000), voyage_id: "v1" } });
    append(w.g.db, { kind: "fuel.exhausted", provider: "fake", ts: iso(1_000), payload: { until: iso(600_000), voyage_id: "v2" } });
    assert.deepEqual(poolState(w.g, "fake"), { state: "dry", until: iso(3_600_000) });
    w.g.now = () => T + 600_001;
    assert.deepEqual(poolState(w.g, "fake"), { state: "dry", until: iso(3_600_000) });
  } finally { w.cleanup(); }
});

test("a hold cleared by a voyage stays cleared when a newer wall hit sets a shorter one", async () => {
  const w = await voyageWorld();
  try {
    append(w.g.db, { kind: "fuel.exhausted", provider: "fake", ts: iso(0), payload: { until: iso(3_600_000), voyage_id: "v1" } });
    voyage(w, "fake", iso(5_000), iso(10_000));
    append(w.g.db, { kind: "fuel.exhausted", provider: "fake", ts: iso(20_000), payload: { until: iso(600_000), voyage_id: "v2" } });
    assert.deepEqual(poolState(w.g, "fake"), { state: "dry", until: iso(600_000) });
  } finally { w.cleanup(); }
});

test("c6: a voyage returned after the exhaustion clears it", async () => {
  const w = await voyageWorld();
  try {
    append(w.g.db, { kind: "fuel.exhausted", provider: "fake", ts: iso(0), payload: { until: iso(3_600_000), voyage_id: "v" } });
    const voyageId = voyage(w, "fake", iso(5_000));
    assert.equal(poolState(w.g, "fake").state, "dry");
    append(w.g.db, { kind: "voyage.returned", ...moonScope(w.g, loadMoon(w.g, "T1")), ts: iso(10_000), voyage_id: voyageId, payload: { role: "implement", report: {} } });
    assert.deepEqual(poolState(w.g, "fake"), { state: "unknown" });
  } finally { w.cleanup(); }
});

test("c6: a voyage returned before the exhaustion does not clear it", async () => {
  const w = await voyageWorld();
  try {
    voyage(w, "fake", "2026-11-17T11:59:40.000Z", "2026-11-17T11:59:50.000Z");
    append(w.g.db, { kind: "fuel.exhausted", provider: "fake", ts: iso(0), payload: { until: iso(3_600_000), voyage_id: "v" } });
    assert.deepEqual(poolState(w.g, "fake"), { state: "dry", until: "2026-11-17T13:00:00.000Z" });
  } finally { w.cleanup(); }
});

test("c6: a voyage launched before the exhaustion does not clear it when it returns", async () => {
  const w = await voyageWorld();
  try {
    // A sibling already in flight when another ship hit the wall says nothing about the pool being back.
    const voyageId = voyage(w, "fake", "2026-11-17T11:59:55.000Z");
    append(w.g.db, { kind: "fuel.exhausted", provider: "fake", ts: iso(0), payload: { until: iso(3_600_000), voyage_id: "v" } });
    append(w.g.db, { kind: "voyage.returned", ...moonScope(w.g, loadMoon(w.g, "T1")), ts: iso(10_000), voyage_id: voyageId, payload: { role: "implement", report: {} } });
    assert.deepEqual(poolState(w.g, "fake"), { state: "dry", until: "2026-11-17T13:00:00.000Z" });
  } finally { w.cleanup(); }
});

test("c6: a voyage returned on another provider does not clear it", async () => {
  const w = await voyageWorld();
  try {
    append(w.g.db, { kind: "fuel.exhausted", provider: "fake", ts: iso(0), payload: { until: iso(3_600_000), voyage_id: "v" } });
    voyage(w, "probe", iso(5_000), iso(10_000));
    assert.deepEqual(poolState(w.g, "fake"), { state: "dry", until: "2026-11-17T13:00:00.000Z" });
    assert.deepEqual(poolState(w.g, "probe"), { state: "unknown" });
  } finally { w.cleanup(); }
});

test("c6: a family exhaustion is cleared only by a voyage of that family", async () => {
  const a = await voyageWorld(), b = await voyageWorld();
  try {
    append(a.g.db, { kind: "fuel.exhausted", provider: "fake", ts: iso(0), payload: { model_family: "opus", until: iso(3_600_000), voyage_id: "v" } });
    voyage(a, "fake", iso(5_000), iso(10_000), "claude-haiku-5-5");
    assert.equal(poolState(a.g, "fake").state, "dry");
    assert.equal(poolState(a.g, "fake", "claude-opus-5-5").state, "dry");
    append(b.g.db, { kind: "fuel.exhausted", provider: "fake", ts: iso(0), payload: { model_family: "opus", until: iso(3_600_000), voyage_id: "v" } });
    voyage(b, "fake", iso(5_000), iso(10_000), "claude-opus-5-5");
    assert.equal(poolState(b.g, "fake").state, "unknown");
    assert.equal(poolState(b.g, "fake", "claude-opus-5-5").state, "unknown");
  } finally { a.cleanup(); b.cleanup(); }
});

test("c8: invalid readings alone leave the pool unknown", async () => {
  const w = await world();
  try {
    for (const used of [NaN, 7, -1, "x"]) reading(w, used, { window: `bad-${String(used)}` });
    assert.deepEqual(poolState(w.g, "fake"), { state: "unknown" });
    assert.deepEqual(poolReadings(w.g, "fake"), []);
  } finally { w.cleanup(); }
});

test("c9: a changed resets_at alone appends", async () => {
  const w = await world();
  try {
    assert.equal(recordReading(w.g, {}, "fake", { window: "five-hour", used: 0.2, resets_at: "2026-11-17T12:01:00.000Z" }), true);
    assert.equal(recordReading(w.g, {}, "fake", { window: "five-hour", used: 0.2, resets_at: "2026-11-17T12:02:00.000Z" }), true);
    assert.equal(recordReading(w.g, {}, "fake", { window: "five-hour", used: 0.2, resets_at: "2026-11-17T12:02:00.000Z" }), false);
    assert.equal(recordReading(w.g, {}, "fake", { window: "five-hour", used: 0.2 }), true);
  } finally { w.cleanup(); }
});

test("c9: another family appends and a duplicate appends nothing", async () => {
  const w = await world();
  try {
    const data = { window: "five-hour", used: 0.2, resets_at: "2026-11-17T12:01:00.000Z" };
    const before = w.g.db.get("events.maxId").id;
    assert.equal(recordReading(w.g, { task_id: "T1" }, "fake", data), true);
    assert.equal(w.g.db.get("events.maxId").id, before + 1);
    const event = rowToEvent(w.g.db.all("events.latestByKindProvider", { kind: "fuel.reading", provider: "fake", limit: 1 })[0]);
    assert.equal(event.kind, "fuel.reading");
    assert.equal(event.provider, "fake");
    assert.equal(event.task_id, "T1");
    assert.equal(event.ts, "2026-11-17T12:00:00.000Z");
    assert.deepEqual(event.payload, { window: "five-hour", used: 0.2, resets_at: "2026-11-17T12:01:00.000Z", source: "reported" });
    assert.equal(recordReading(w.g, { task_id: "T1" }, "fake", data), false);
    assert.equal(w.g.db.get("events.maxId").id, before + 1);
    assert.equal(recordReading(w.g, { task_id: "T1" }, "fake", { ...data, model_family: "opus" }), true);
    assert.equal(recordReading(w.g, { task_id: "T1" }, "fake", { ...data, model_family: "opus" }), false);
  } finally { w.cleanup(); }
});
