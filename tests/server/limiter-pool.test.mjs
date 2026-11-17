import { test } from "node:test";
import assert from "node:assert/strict";
import { makeGalaxy } from "../helpers.mjs";
import { append, rowToEvent } from "../../dist/db/events.js";
import { poolReadings, poolState, recordReading } from "../../dist/server/limiter/pool.js";

const T = Date.parse("2026-11-17T12:00:00.000Z");
const iso = (offset) => new Date(T + offset).toISOString();
async function world(pool = { kind: "window", reserve_floor: 0.1 }) {
  const w = await makeGalaxy((c) => { c.roles = { implement: ["fake"], review: ["fake"] }; c.providers.fake.pool = pool; });
  w.g.now = () => T;
  return w;
}
const reading = (w, used, extra = {}) => append(w.g.db, { kind: "fuel.reading", provider: "fake", ts: extra.ts ?? iso(0), payload: { window: extra.window ?? "five-hour", used, source: "reported", ...(extra.resets_at === null ? {} : { resets_at: extra.resets_at ?? iso(60_000) }), ...(extra.model_family ? { model_family: extra.model_family } : {}) } });

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
