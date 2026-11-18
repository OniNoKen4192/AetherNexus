import { test } from "node:test"; import assert from "node:assert/strict";
import { worldWithMoon } from "../fixtures/world.mjs";
import { append, rowToEvent } from "../../dist/db/events.js";
import { rebuild, dumpProjections } from "../../dist/db/rebuild.js";
import { launchMoon } from "../../dist/server/commands/launch.js";
import { loadMoon, moonScope, parkVoyage, runVoyage } from "../../dist/server/dispatch.js";

const now = () => new Date().toISOString();
const done = () => ({ kind: "done", ts: now(), data: { report: { status: "IMPLEMENTED", raw: "STATUS: IMPLEMENTED" } } });
const wallError = (extra = {}) => ({ kind: "error", ts: now(), data: { classification: "rate_limited", message: "usage limit reached", ...extra } });
const fuel = (data) => ({ kind: "fuel", ts: now(), data });
/** An adapter whose stream is the given async generator. */
const adapterOf = (gen, classify = () => "unknown") => ({ id: "fake", roles: ["implement", "review"], classify, dispatch: gen });
const untilAborted = (signal) => new Promise((res) => (signal.aborted ? res() : signal.addEventListener("abort", res, { once: true })));

const moonEvents = (w, kind) => w.g.db.all("events.byMoon", { moon_id: w.moonId }).map(rowToEvent).filter((e) => e.kind === kind);
function gate(w) {
  const moon = loadMoon(w.g, "T1");
  append(w.g.db, { kind: "moon.gated", ...moonScope(w.g, moon), payload: { base_sha: w.g.git.headSha(), state_path: "x", round: 1 } });
  return moon;
}
/** runVoyage on a freshly gated moon, straight at the dispatcher (no audit afterwards). */
function fly(w, extra = {}) {
  const moon = gate(w);
  return runVoyage(w.g, { role: "implement", taskId: "T1", provider: "fake", worktree: w.dir, touch: ["src/**"], job: { role: "implement", specPath: moon.spec_path, specText: "", prompt: "", round: 1 }, ...extra });
}
function finish(w) {
  const before = dumpProjections(w.g.db); rebuild(w.g.db); assert.equal(dumpProjections(w.g.db), before, "rebuild leaves the projections byte-equal");
  w.cleanup();
}

test("a fuel event is stored once as fuel.reading with the voyage's provider", async () => {
  const w = await worldWithMoon("fuel-ok");
  const r = await launchMoon(w.g, { taskId: "T1", provider: "fake" });
  assert.equal(r.moonStatus, "audited");
  const readings = moonEvents(w, "fuel.reading");
  assert.equal(readings.length, 1);
  assert.equal(readings[0].provider, "fake"); assert.equal(readings[0].voyage_id, r.voyageId); assert.equal(readings[0].task_id, "T1");
  const { resets_at, ...rest } = readings[0].payload;
  assert.deepEqual(rest, { window: "5h", used: 0.2, source: "reported" });
  assert.ok(Date.parse(resets_at) > Date.now() + 50_000);
  finish(w);
});

test("an identical reading later in the same voyage adds none, and an invalid one is not stored", async () => {
  const w = await worldWithMoon("happy");
  const reading = { window: "5h", used: 0.4, resets_at: new Date(Date.now() + 3_600_000).toISOString() };
  w.g.adapters.fake = adapterOf(async function* () {
    yield fuel(reading); yield fuel({ ...reading }); yield fuel({ window: "weekly", used: 7 }); yield fuel({ window: "weekly", used: Number.NaN }); yield fuel({ used: 0.5 }); yield done();
  });
  const out = await fly(w);
  assert.ok(out.done); assert.equal(out.events, 6);
  assert.deepEqual(moonEvents(w, "fuel.reading").map((e) => e.payload), [{ ...reading, source: "reported" }]);
  finish(w);
});

test("a reading that cannot be stored never breaks the voyage", async () => {
  const w = await worldWithMoon("happy");
  w.g.adapters.fake = adapterOf(async function* () { yield fuel({ window: "5h", used: 0.4 }); yield done(); });
  w.g.now = () => { throw new Error("no clock"); };
  const out = await fly(w);
  assert.ok(out.done); assert.equal(out.parkReason, undefined);
  assert.equal(w.g.db.get("voyages.byId", { id: out.voyageId }).status, "holding");
  assert.equal(moonEvents(w, "fuel.reading").length, 0);
  w.cleanup();
});

test("input.model reaches the adapter and the launch record", async () => {
  const w = await worldWithMoon("happy"); let job;
  w.g.adapters.fake = adapterOf(async function* (j) { job = j; yield done(); });
  const out = await fly(w, { model: "m-cheap" });
  assert.equal(job.model, "m-cheap");
  assert.equal(moonEvents(w, "voyage.launched")[0].payload.model, "m-cheap");
  assert.equal(w.g.db.get("voyages.byId", { id: out.voyageId }).model, "m-cheap");
  finish(w);
});

test("without input.model the tier's model is recorded but not handed to the adapter", async () => {
  const w = await worldWithMoon("happy"); let job;
  const tier = loadMoon(w.g, "T1").tier; assert.ok(tier, "the fixture spec carries a model hint");
  w.g.config.providers.fake.models = { [tier]: "tier-model" };
  w.g.adapters.fake = adapterOf(async function* (j) { job = j; yield done(); });
  await fly(w);
  assert.equal("model" in job, false);
  const launched = moonEvents(w, "voyage.launched")[0].payload;
  assert.equal(launched.model, "tier-model"); assert.equal("refuel_for" in launched, false);
  finish(w);
});

test("refuelFor is recorded on voyage.launched", async () => {
  const w = await worldWithMoon("happy");
  w.g.adapters.fake = adapterOf(async function* () { yield done(); });
  await fly(w, { model: "m-cheap", refuelFor: "codex" });
  assert.equal(moonEvents(w, "voyage.launched")[0].payload.refuel_for, "codex");
  finish(w);
});

test("a rate_limited ending leaves cargo awaiting pickup, not a park", async () => {
  const w = await worldWithMoon("wall");
  const r = await launchMoon(w.g, { taskId: "T1", provider: "fake" });
  assert.equal(r.moonStatus, "awaiting_pickup"); assert.equal(r.audit, null);
  const moon = loadMoon(w.g, "T1"); assert.equal(moon.status, "awaiting_pickup"); assert.equal(moon.park_reason, null);
  const voyage = w.g.db.get("voyages.byId", { id: r.voyageId }); assert.equal(voyage.status, "out_of_fuel");
  assert.equal(w.g.db.get("ships.byId", { id: voyage.ship_id }).status, "idle");
  assert.ok(w.g.db.all("ships.all").every((s) => s.status === "idle"));
  assert.equal(w.g.db.all("decisions.pending").length, 0);
  const exhausted = moonEvents(w, "fuel.exhausted");
  assert.equal(exhausted.length, 1); assert.equal(exhausted[0].provider, "fake"); assert.equal(exhausted[0].payload.voyage_id, r.voyageId);
  assert.ok(Date.parse(exhausted[0].payload.until) > Date.now() + 50_000, "a reset 400 ms ahead is held for at least a minute");
  assert.equal(moonEvents(w, "voyage.adrift").length, 0);
  finish(w);
});

test("the error's reset time and model family reach fuel.exhausted, and the outcome says out_of_fuel", async () => {
  const w = await worldWithMoon("happy");
  const resets_at = new Date(Date.now() + 2 * 3_600_000).toISOString();
  w.g.adapters.fake = adapterOf(async function* () { yield wallError({ resets_at, model_family: "opus" }); });
  const out = await fly(w);
  assert.equal(out.parkReason, "out_of_fuel"); assert.equal(out.done, undefined);
  assert.deepEqual(moonEvents(w, "fuel.exhausted").map((e) => e.payload), [{ until: resets_at, voyage_id: out.voyageId, model_family: "opus" }]);
  assert.deepEqual(moonEvents(w, "voyage.out_of_fuel").map((e) => e.payload), [{ reason: "out_of_fuel", details: "usage limit reached" }]);
  finish(w);
});

test("a second wall hit in a row on the same provider parks as rate_limited", async () => {
  const w = await worldWithMoon("happy");
  w.g.adapters.fake = adapterOf(async function* () { yield wallError(); });
  const first = await fly(w); assert.equal(first.parkReason, "out_of_fuel");
  const second = await fly(w);
  assert.equal(second.parkReason, "rate_limited");
  const moon = loadMoon(w.g, "T1"); assert.equal(moon.status, "adrift"); assert.equal(moon.park_reason, "rate_limited");
  assert.equal(w.g.db.get("voyages.byId", { id: second.voyageId }).status, "adrift");
  assert.equal(w.g.db.all("decisions.pending").length, 1);
  assert.equal(moonEvents(w, "fuel.exhausted").length, 2);
  finish(w);
});

test("a thrown rate-limit error ends the same way", async () => {
  const w = await worldWithMoon("happy");
  // eslint-disable-next-line require-yield
  w.g.adapters.fake = adapterOf(async function* () { throw new Error("429 too many requests"); }, () => "rate_limited");
  const out = await fly(w);
  assert.equal(out.parkReason, "out_of_fuel"); assert.equal(out.threw, "429 too many requests");
  assert.equal(loadMoon(w.g, "T1").status, "awaiting_pickup");
  assert.equal(w.g.db.get("voyages.byId", { id: out.voyageId }).status, "out_of_fuel");
  assert.equal(w.g.db.all("decisions.pending").length, 0);
  assert.deepEqual(moonEvents(w, "voyage.out_of_fuel").map((e) => e.payload.details), ["429 too many requests"]);
  finish(w);
});

test("timeout and interrupt still park as before, even after a rate_limited error", async () => {
  for (const cause of ["timeout", "interrupted"]) {
    const w = await worldWithMoon("happy");
    w.g.adapters.fake = adapterOf(async function* (_job, ctx) { yield wallError(); await untilAborted(ctx.signal); });
    const ac = new AbortController(); if (cause === "interrupted") setTimeout(() => ac.abort(), 20);
    const out = await fly(w, cause === "timeout" ? { timeoutMs: 30 } : { signal: ac.signal });
    assert.equal(out.parkReason, cause);
    const moon = loadMoon(w.g, "T1"); assert.equal(moon.status, "adrift", cause); assert.equal(moon.park_reason, cause);
    assert.equal(w.g.db.get("voyages.byId", { id: out.voyageId }).status, "adrift");
    assert.equal(w.g.db.all("decisions.pending").length, 1);
    assert.equal(moonEvents(w, "fuel.exhausted").length, 0, "an aborted voyage says nothing about the pool");
    finish(w);
  }
});

test("a voyage someone else parked is left alone", async () => {
  const w = await worldWithMoon("happy"); let voyageId;
  w.g.adapters.fake = adapterOf(async function* () {
    const v = w.g.db.get("voyages.byId", { id: voyageId });
    parkVoyage(w.g, { taskId: "T1", voyageId, shipId: v.ship_id, reason: "presumed_dead" });
    yield wallError();
  });
  const out = await fly(w, { onLaunched: (id) => { voyageId = id; } });
  assert.equal(out.parkReason, "presumed_dead");
  assert.equal(loadMoon(w.g, "T1").park_reason, "presumed_dead");
  assert.equal(w.g.db.get("voyages.byId", { id: out.voyageId }).status, "adrift");
  assert.equal(moonEvents(w, "fuel.exhausted").length, 0); assert.equal(moonEvents(w, "voyage.out_of_fuel").length, 0);
  assert.equal(w.g.db.all("decisions.pending").length, 1);
  finish(w);
});

test("other failures still park: a backend failure is not a wall hit", async () => {
  const w = await worldWithMoon("crash-midrun");
  const r = await launchMoon(w.g, { taskId: "T1", provider: "fake" });
  assert.equal(r.moonStatus, "adrift"); assert.equal(loadMoon(w.g, "T1").park_reason, "backend_failure");
  assert.equal(moonEvents(w, "fuel.exhausted").length, 0);
  finish(w);
});
