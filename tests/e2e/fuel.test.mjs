import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { append } from "../../dist/db/events.js";
import { dumpProjections, rebuild } from "../../dist/db/rebuild.js";
import { startServer } from "../../dist/server/http/server.js";
import { fuelPatch, writeSpecs } from "../fixtures/world.mjs";
import { rawRequest, readFeed, startWorld } from "../http/helpers.mjs";

const FAST = { server: { pollMs: 20, schedulerTickMs: 100 } };
const iso = (ms = 0) => new Date(Date.now() + ms).toISOString();

async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() >= end) throw new Error(`timed out waiting for: ${fn}`);
    await delay(20);
  }
}

async function post(x, name, body) {
  const response = await x.api(`/api/commands/${name}`, { method: "POST", body });
  assert.ok(response.status === 200 || response.status === 202, `${name}: ${response.status} ${response.text}`);
  return response.json.result;
}

async function snapshot(x) {
  const response = await x.api("/api/snapshot");
  assert.equal(response.status, 200);
  return response.json;
}

const moons = (snap) => snap.systems.flatMap((system) => system.planets).flatMap((planet) => planet.moons);
const findMoon = (snap, taskId) => moons(snap).find((moon) => moon.task_id === taskId);

async function detail(x, taskId = "T1") {
  const response = await x.api(`/api/moons/${taskId}`);
  assert.equal(response.status, 200);
  return response.json;
}

function events(feed, kind, taskId = "T1") {
  return feed.events.filter((event) => event.kind === kind && (taskId === null || event.task_id === taskId));
}

function reading(x, provider, used, resetsAt = iso(3_600_000)) {
  append(x.w.g.db, { kind: "fuel.reading", provider, payload: { window: "5h", used, resets_at: resetsAt, source: "reported" } });
  return resetsAt;
}

function exhausted(x, provider, until, voyageId = "prior") {
  append(x.w.g.db, { kind: "fuel.exhausted", provider, payload: { until, voyage_id: voyageId } });
}

function movePast(x, until, extra = 1000) {
  const offset = Math.max(0, Date.parse(until) - Date.now() + extra);
  x.w.g.now = () => Date.now() + offset;
}

function steerReviews(x, scriptsByTask, implementByRound = {}) {
  const real = x.w.g.adapters.fake;
  const seen = new Map();
  x.w.g.adapters.fake = {
    ...real,
    dispatch(job, ctx) {
      const taskId = path.basename(job.specPath, ".md");
      const implementScript = job.role === "implement" ? implementByRound[`${taskId}:${job.round}`] : undefined;
      if (implementScript) return real.dispatch({ ...job, prompt: `FAKE-SCRIPT: ${implementScript}\n${job.prompt}` }, ctx);
      if (job.role === "review") {
        const index = seen.get(taskId) ?? 0;
        const script = scriptsByTask[taskId]?.[index];
        if (script) {
          seen.set(taskId, index + 1);
          return real.dispatch({ ...job, prompt: `FAKE-SCRIPT: ${script}\n${job.prompt}` }, ctx);
        }
      }
      return real.dispatch(job, ctx);
    },
  };
}

async function assign(x, specPath) {
  return post(x, "moon.assign", { planetId: x.w.planetId, specPath });
}

async function setRoundabout(x) { await post(x, "config.automation", { level: "roundabout" }); }

async function finish(x, server = x.srv) {
  await server.close();
  const before = dumpProjections(x.w.g.db);
  rebuild(x.w.g.db);
  assert.equal(dumpProjections(x.w.g.db), before, "rebuild byte-equal");
}

async function scenario(script, patch, body) {
  const x = await startWorld(script, patch ?? fuelPatch(), FAST);
  const feed = readFeed(x.srv, { since: 0 });
  let server = x.srv;
  try {
    await body(x, feed, (replacement) => { server = replacement; });
  } finally {
    feed.close();
    try { await finish(x, server); } finally { await x.close(); }
  }
}

test("1. A low pool holds, a recovered pool sends.", async () => scenario("happy", fuelPatch(), async (x, feed) => {
  const resetsAt = reading(x, "fake", 0.95);
  await setRoundabout(x);
  await feed.waitFor((all) => all.some((event) => event.kind === "limiter.held" && event.task_id === "T1"));
  await delay(400);
  assert.equal(events(feed, "voyage.launched").length, 0);
  assert.equal(events(feed, "limiter.held").length, 1);
  let snap = await snapshot(x), moon = findMoon(snap, "T1");
  assert.deepEqual(moon.waiting_on_fuel, { provider: "fake", reason: "low", until: resetsAt });
  assert.equal(snap.pools.find((pool) => pool.provider === "fake").state, "low");
  reading(x, "fake", 0.2, resetsAt);
  snap = await until(async () => { const value = await snapshot(x); return findMoon(value, "T1")?.status === "merged" ? value : null; });
  assert.equal(findMoon(snap, "T1").waiting_on_fuel, null);
  assert.ok(events(feed, "voyage.launched").length >= 1);
}));

test("2. The wall, then pickup.", async () => scenario("wall", fuelPatch(), async (x, feed) => {
  await setRoundabout(x);
  const first = await until(async () => { const value = await snapshot(x); return findMoon(value, "T1")?.status === "awaiting_pickup" ? value : null; });
  await feed.waitFor((all) => all.some((event) => event.kind === "fuel.exhausted" && event.task_id === "T1"));
  const dry = events(feed, "fuel.exhausted")[0];
  assert.equal(events(feed, "fuel.exhausted").length, 1);
  assert.equal(first.voyages.find((voyage) => voyage.task_id === "T1").status, "out_of_fuel");
  assert.equal(first.decisions.filter((decision) => decision.target_id === "T1").length, 0);
  assert.equal(events(feed, "moon.adrift").length + events(feed, "voyage.adrift").length, 0);
  assert.ok(first.fleet.every((ship) => ship.status === "idle"));
  assert.equal(first.pools.find((pool) => pool.provider === "fake").state, "dry");
  assert.equal(findMoon(first, "T1").waiting_on_fuel.reason, "dry");
  movePast(x, dry.payload.until);
  const done = await until(async () => { const value = await snapshot(x); return findMoon(value, "T1")?.status === "merged" ? value : null; });
  assert.equal(events(feed, "voyage.launched").filter((event) => event.payload.role === "implement").length, 2);
  assert.equal(findMoon(done, "T1").round, 2);
}));

test("3. A second hit needs a person.", async () => scenario("wall-twice", fuelPatch(), async (x, feed) => {
  await setRoundabout(x);
  await feed.waitFor((all) => all.filter((event) => event.kind === "fuel.exhausted" && event.task_id === "T1").length === 1);
  movePast(x, events(feed, "fuel.exhausted")[0].payload.until);
  const parked = await until(async () => { const value = await snapshot(x); return findMoon(value, "T1")?.status === "adrift" ? value : null; });
  await feed.waitFor((all) => all.filter((event) => event.kind === "fuel.exhausted" && event.task_id === "T1").length === 2);
  assert.equal(findMoon(parked, "T1").park_reason, "rate_limited");
  assert.equal(parked.decisions.filter((decision) => decision.target_id === "T1").length, 1);
  const launched = events(feed, "voyage.launched").length;
  movePast(x, events(feed, "fuel.exhausted")[1].payload.until);
  await delay(400);
  assert.equal(events(feed, "voyage.launched").length, launched);
  assert.equal(events(feed, "moon.adrift").some((event) => event.payload.reason === "scheduler_refused"), false);
}));

test("4. Customs hits the wall.", async () => scenario("happy", fuelPatch(), async (x, feed) => {
  steerReviews(x, { T1: ["review-wall"] });
  await setRoundabout(x);
  const dry = await until(async () => { const value = await snapshot(x); const voyage = value.voyages.find((v) => v.task_id === "T1" && v.role === "review" && v.status === "out_of_fuel"); return voyage ? value : null; });
  await feed.waitFor((all) => all.some((event) => event.kind === "fuel.exhausted" && event.task_id === "T1"));
  assert.equal(findMoon(dry, "T1").status, "audited");
  assert.ok(dry.fleet.filter((ship) => ship.class === "customs").every((ship) => ship.status === "idle"));
  assert.equal(dry.decisions.filter((decision) => decision.target_id === "T1").length, 0);
  movePast(x, events(feed, "fuel.exhausted")[0].payload.until);
  const done = await until(async () => { const value = await snapshot(x); return findMoon(value, "T1")?.status === "merged" ? value : null; });
  assert.equal(findMoon(done, "T1").round, 1);
  assert.equal(done.voyages.filter((v) => v.task_id === "T1" && v.role === "review").length, 2);
}));

test("5. Refuel.", async () => scenario("wall-then-spare", fuelPatch({ refuel: { min_wait_minutes: 0 } }), async (x, feed) => {
  steerReviews(x, { T1: ["review-fix"] });
  await setRoundabout(x);
  await feed.waitFor((all) => all.some((event) => event.kind === "limiter.refuelled" && event.task_id === "T1"));
  const refuelled = events(feed, "limiter.refuelled");
  assert.equal(refuelled.length, 1);
  assert.deepEqual({ from: refuelled[0].payload.from, to: refuelled[0].payload.to, model: refuelled[0].payload.model }, { from: "fake", to: "spare", model: "m-cheap" });
  const spareLaunch = events(feed, "voyage.launched").find((event) => event.payload.provider === "spare");
  assert.deepEqual({ provider: spareLaunch.payload.provider, model: spareLaunch.payload.model, refuel_for: spareLaunch.payload.refuel_for }, { provider: "spare", model: "m-cheap", refuel_for: "fake" });
  const exhaustedEvent = events(feed, "fuel.exhausted").find((event) => event.provider === "fake");
  movePast(x, exhaustedEvent.payload.until);
  const done = await until(async () => { const value = await snapshot(x); return findMoon(value, "T1")?.status === "merged" ? value : null; }, 20000);
  const own = done.voyages.filter((voyage) => voyage.task_id === "T1");
  assert.ok(events(feed, "voyage.event").some((event) => event.payload.event?.data?.text === "fake: model m-cheap"));
  assert.equal(own.find((voyage) => voyage.id === spareLaunch.voyage_id)?.refuel_for, "fake");
  assert.ok(own.filter((voyage) => voyage.id !== spareLaunch.voyage_id).every((voyage) => voyage.refuel_for === null));
  const round3 = events(feed, "voyage.launched").find((event) => event.payload.role === "implement" && event.payload.round === 3);
  assert.equal(round3.payload.provider, "fake");
  assert.equal(round3.payload.model, undefined);
  assert.equal(round3.payload.refuel_for, undefined);
}));

test("6. Not worth refuelling.", async () => scenario("wall", fuelPatch({ refuel: { min_wait_minutes: 30 } }), async (x, feed) => {
  await setRoundabout(x);
  const waiting = await until(async () => { const value = await snapshot(x); const moon = findMoon(value, "T1"); if (moon?.status === "adrift") throw new Error(`unexpected park: ${JSON.stringify({ moon, decisions: value.decisions, voyages: value.voyages })}`); return moon?.status === "awaiting_pickup" ? value : null; });
  await delay(400);
  assert.equal(events(feed, "limiter.refuelled").length, 0);
  assert.equal(events(feed, "voyage.launched").some((event) => event.payload.provider === "spare"), false);
  assert.equal(findMoon(waiting, "T1").can_refuel, null);
  await feed.waitFor((all) => all.some((event) => event.kind === "fuel.exhausted" && event.task_id === "T1"));
  movePast(x, events(feed, "fuel.exhausted")[0].payload.until);
  const done = await until(async () => { const value = await snapshot(x); return findMoon(value, "T1")?.status === "merged" ? value : null; });
  assert.ok(done.voyages.filter((v) => v.task_id === "T1").every((v) => v.provider === "fake"));
}));

test("7. The refuel pool is low.", async () => scenario("wall-then-spare", fuelPatch({ refuel: { min_wait_minutes: 0 } }), async (x, feed) => {
  reading(x, "spare", 0.9);
  await setRoundabout(x);
  const waiting = await until(async () => { const value = await snapshot(x); const moon = findMoon(value, "T1"); if (moon?.status === "adrift" || moon?.status === "merged") throw new Error(`unexpected terminal state: ${JSON.stringify({ moon, decisions: value.decisions, voyages: value.voyages, pools: value.pools })}`); return moon?.status === "awaiting_pickup" ? value : null; });
  await delay(400);
  assert.equal(events(feed, "limiter.refuelled").length, 0);
  assert.equal(events(feed, "voyage.launched").some((event) => event.payload.provider === "spare"), false);
  assert.equal(findMoon(waiting, "T1").waiting_on_fuel.reason, "dry");
  assert.equal(findMoon(waiting, "T1").can_refuel, null);
}));

test("9. A wall hit is not a fix round.", async () => scenario("wall", fuelPatch({}, (c) => { c.automation.max_fix_rounds = 2; }), async (x, feed) => {
  steerReviews(x, { T1: ["review-fix", "review-approve"] }, { "T1:3": "happy" });
  await setRoundabout(x);
  await feed.waitFor((all) => all.some((event) => event.kind === "fuel.exhausted" && event.task_id === "T1"));
  movePast(x, events(feed, "fuel.exhausted")[0].payload.until);
  let last;
  const done = await until(async () => { const value = last = await snapshot(x); const moon = findMoon(value, "T1"); if (moon?.status === "adrift") throw new Error(`unexpected park: ${JSON.stringify({ moon, decisions: value.decisions, voyages: value.voyages })}`); return moon?.status === "merged" ? value : null; }, 20000).catch((error) => { throw new Error(`${error.message}; last=${JSON.stringify({ moon: findMoon(last, "T1"), decisions: last.decisions, voyages: last.voyages })}`); });
  assert.equal(findMoon(done, "T1").status, "merged");
  assert.equal(events(feed, "moon.adrift").some((event) => event.payload.reason === "max_fix_rounds"), false);
}));

test("10. Restart while dry.", async () => scenario("happy", fuelPatch(), async (x, feed, replaceServer) => {
  const untilAt = iso(1500);
  exhausted(x, "fake", untilAt);
  await setRoundabout(x);
  await x.srv.close();
  const restarted = await startServer(x.w.g, { port: 0, webRoot: x.webRoot, pollMs: 20, schedulerTickMs: 100 });
  replaceServer(restarted);
  x.api = (requestPath, { method = "GET", body, headers = {} } = {}) => rawRequest(restarted.port, {
    method, path: requestPath,
    headers: { cookie: `nexus_token=${restarted.token}`, origin: restarted.url, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  while (Date.now() < Date.parse(untilAt)) {
    assert.equal(events(feed, "voyage.launched").length, 0);
    await delay(50);
  }
  const done = await until(async () => { const value = await snapshot(x); return findMoon(value, "T1")?.status === "merged" ? value : null; });
  assert.equal(findMoon(done, "T1").status, "merged");
}));

test("11. No pool block.", async () => scenario("wall", fuelPatch({}, (c) => { delete c.providers.fake.pool; }), async (x, feed) => {
  await setRoundabout(x);
  const waiting = await until(async () => { const value = await snapshot(x); return findMoon(value, "T1")?.status === "awaiting_pickup" ? value : null; });
  const pool = waiting.pools.find((entry) => entry.provider === "fake");
  assert.equal(pool.state, "dry");
  assert.equal(pool.kind, "free");
  await feed.waitFor((all) => all.some((event) => event.kind === "fuel.exhausted" && event.task_id === "T1"));
  const launches = events(feed, "voyage.launched").filter((event) => event.payload.role === "implement").length;
  await delay(400);
  assert.equal(events(feed, "voyage.launched").filter((event) => event.payload.role === "implement").length, launches);
  movePast(x, events(feed, "fuel.exhausted")[0].payload.until);
  const done = await until(async () => { const value = await snapshot(x); return findMoon(value, "T1")?.status === "merged" ? value : null; });
  assert.equal(findMoon(done, "T1").status, "merged");
}));

test("12. The third hit.", async () => scenario("wall-twice", fuelPatch({ refuel: { min_wait_minutes: 0 } }), async (x, feed) => {
  await setRoundabout(x);
  await feed.waitFor((all) => all.filter((event) => event.kind === "fuel.exhausted" && event.task_id === "T1").length === 2, 15000);
  const firstTwo = events(feed, "fuel.exhausted");
  assert.deepEqual(firstTwo.map((event) => event.provider), ["fake", "spare"]);
  movePast(x, firstTwo.map((event) => event.payload.until).sort().at(-1));
  const parked = await until(async () => { const value = await snapshot(x); return findMoon(value, "T1")?.status === "adrift" ? value : null; });
  await feed.waitFor((all) => all.filter((event) => event.kind === "fuel.exhausted" && event.task_id === "T1").length === 3);
  assert.deepEqual(events(feed, "fuel.exhausted").map((event) => event.provider), ["fake", "spare", "fake"]);
  assert.equal(findMoon(parked, "T1").park_reason, "rate_limited");
  assert.equal(parked.decisions.filter((decision) => decision.target_id === "T1").length, 1);
}));

test("13. Customs ships come back.", async () => scenario("happy", fuelPatch(), async (x, feed) => {
  const paths = writeSpecs(x.w, [{ id: "B", scripts: ["happy"] }, { id: "C", scripts: ["happy"] }]);
  await assign(x, paths[0]);
  await assign(x, paths[1]);
  steerReviews(x, { T1: ["review-wall"], B: ["review-wall"], C: ["review-wall"] });
  await setRoundabout(x);
  for (let count = 1; count <= 3; count++) {
    await feed.waitFor((all) => all.filter((event) => event.kind === "fuel.exhausted").length >= count, 20000);
    const snap = await snapshot(x);
    assert.ok(snap.fleet.filter((ship) => ship.class === "customs").every((ship) => ship.status === "idle"));
    movePast(x, events(feed, "fuel.exhausted", null)[count - 1].payload.until);
  }
  const done = await until(async () => { const value = await snapshot(x); return ["T1", "B", "C"].every((id) => findMoon(value, id)?.status === "merged") ? value : null; }, 30000);
  assert.equal(events(feed, "moon.adrift", null).length, 0);
  assert.ok(done.fleet.filter((ship) => ship.class === "customs").every((ship) => ship.status === "idle"));
}));

test("14. Contraband in the cargo.", async () => scenario("wall", fuelPatch(), async (x, feed) => {
  await setRoundabout(x);
  await until(async () => findMoon(await snapshot(x), "T1")?.status === "awaiting_pickup");
  await feed.waitFor((all) => all.some((event) => event.kind === "fuel.exhausted" && event.task_id === "T1"));
  const worktree = path.join(x.w.dir, ".nexus", "worktrees", "T1");
  fs.writeFileSync(path.join(worktree, "contraband.txt"), "not in src\n");
  movePast(x, events(feed, "fuel.exhausted")[0].payload.until);
  const parked = await until(async () => { const value = await snapshot(x); return findMoon(value, "T1")?.status === "adrift" ? value : null; });
  const moon = findMoon(parked, "T1"), decisions = parked.decisions.filter((decision) => decision.target_id === "T1");
  assert.equal(moon.park_reason, "carryover_violations");
  assert.equal(decisions.length, 1);
  assert.match(decisions[0].reasoning, /^contraband in the cargo awaiting pickup/);
  assert.equal(events(feed, "moon.adrift").some((event) => event.payload.reason === "scheduler_refused"), false);
  const launched = events(feed, "voyage.launched").length;
  await delay(400);
  assert.equal(events(feed, "voyage.launched").length, launched);
  assert.equal(findMoon(await snapshot(x), "T1").waiting_on_fuel, null);
}));

test("focus: two ships at the wall.", async () => scenario("wall", fuelPatch({}, (c) => { c.scheduler.max_concurrent_ships = 2; }), async (x, feed) => {
  const [pathB] = writeSpecs(x.w, [{ id: "B", scripts: ["wall"] }]);
  await assign(x, pathB);
  await setRoundabout(x);
  await until(async () => { const value = await snapshot(x); return ["T1", "B"].every((id) => findMoon(value, id)?.status === "awaiting_pickup"); });
  await feed.waitFor((all) => all.filter((event) => event.kind === "fuel.exhausted").length === 2);
  movePast(x, events(feed, "fuel.exhausted", null).map((event) => event.payload.until).sort().at(-1));
  const done = await until(async () => { const value = await snapshot(x); return ["T1", "B"].every((id) => findMoon(value, id)?.status === "merged") ? value : null; }, 20000);
  assert.ok(["T1", "B"].every((id) => findMoon(done, id).status === "merged"));
  assert.equal(events(feed, "moon.adrift", null).length, 0);
}));

test("done-when: three moons, nobody clicks.", async () => scenario("happy", fuelPatch({ refuel: { min_wait_minutes: 0 } }), async (x, feed) => {
  const paths = writeSpecs(x.w, [{ id: "C", scripts: ["wall-then-spare"] }, { id: "B", scripts: ["wall"] }]);
  await assign(x, paths[0]);
  await assign(x, paths[1]);
  await setRoundabout(x);
  const end = Date.now() + 30000;
  let done, idleSince = null;
  while (Date.now() < end) {
    const snap = await snapshot(x);
    if (["T1", "B", "C"].every((id) => findMoon(snap, id)?.status === "merged")) { done = snap; break; }
    const waiting = ["T1", "B", "C"].map((id) => findMoon(snap, id)).filter((moon) => moon?.waiting_on_fuel);
    if (snap.fleet.every((ship) => ship.status === "idle") && waiting.length && waiting.every((moon) => moon.can_refuel === null)) {
      idleSince ??= Date.now();
      if (Date.now() - idleSince >= 200) {
        movePast(x, waiting.map((moon) => moon.waiting_on_fuel.until).sort()[0]);
        idleSince = null;
      }
    } else idleSince = null;
    await delay(50);
  }
  assert.ok(done, `all three moons merged unattended: ${JSON.stringify({ moons: (await snapshot(x)).systems.flatMap((system) => system.planets).flatMap((planet) => planet.moons).filter((moon) => ["T1", "B", "C"].includes(moon.task_id)).map(({ task_id, status, round, waiting_on_fuel, park_reason }) => ({ task_id, status, round, waiting_on_fuel, park_reason })), events: feed.events.filter((event) => ["voyage.launched", "fuel.exhausted", "limiter.refuelled", "moon.adrift"].includes(event.kind)).map((event) => ({ kind: event.kind, task: event.task_id, provider: event.provider, payload: event.payload })) })}`);
  assert.ok(events(feed, "limiter.refuelled", null).length >= 1);
  assert.equal(events(feed, "moon.adrift", null).length, 0);
}));
