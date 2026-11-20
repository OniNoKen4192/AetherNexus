import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { BUILTIN } from "../../dist/core/catalogue/builtin.js";
import { append, rowToEvent } from "../../dist/db/events.js";
import { dumpProjections, rebuild } from "../../dist/db/rebuild.js";
import { assignMoon, assignPlanet } from "../../dist/server/commands/assign.js";
import { initGalaxy } from "../../dist/server/commands/init.js";
import { createSystem } from "../../dist/server/commands/system.js";
import { openGalaxy } from "../../dist/server/galaxy.js";
import { startServer } from "../../dist/server/http/server.js";
import { shipsPatch, writeSpecs } from "../fixtures/world.mjs";
import { makeRepo, read, repoRoot, writeSpec } from "../helpers.mjs";
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

function events(x, kind, taskId = null) {
  return x.w.g.db.all("events.since", { id: 0 }).map(rowToEvent)
    .filter((event) => event.kind === kind && (taskId === null || event.task_id === taskId));
}

function reading(x, provider, used, resetsAt = iso(3_600_000)) {
  append(x.w.g.db, { kind: "fuel.reading", provider, payload: { window: "5h", used, resets_at: resetsAt, source: "reported" } });
  return resetsAt;
}

function exhausted(x, provider, until, voyageId = "prior") {
  append(x.w.g.db, { kind: "fuel.exhausted", provider, payload: { until, voyage_id: voyageId } });
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
  const x = await startWorld(script, patch, FAST);
  const feed = readFeed(x.srv, { since: 0 });
  let bodyError;
  const cleanupErrors = [];
  try { await body(x, feed); } catch (error) { bodyError = error; }
  try { feed.close(); } catch (error) { cleanupErrors.push(error); }
  try { await finish(x); } catch (error) { cleanupErrors.push(error); }
  try { await x.close(); } catch (error) { cleanupErrors.push(error); }
  const cleanupError = cleanupErrors.length > 1 ? new AggregateError(cleanupErrors, "scenario cleanup failed") : cleanupErrors[0];
  if (bodyError) { if (cleanupError) bodyError.cause = cleanupError; throw bodyError; }
  if (cleanupError) throw cleanupError;
}

const formationsFor = (weight) => BUILTIN.formations.filter((formation) => formation.job === "delivery" && (!formation.weights?.length || formation.weights.includes(weight))).map((formation) => formation.id);
const cargoFor = (weight) => BUILTIN.cargo.filter((cargo) => !cargo.weights?.length || cargo.weights.includes(weight)).map((cargo) => cargo.id);

test("1. Delivery ships take their weight and faction from the provider.", async () => scenario("happy", shipsPatch(), async (x) => {
  const paths = writeSpecs(x.w, [
    { id: "L", tier: "luna", scripts: ["happy"] },
    { id: "S", tier: "sol", scripts: ["happy"] },
  ]);
  await assign(x, paths[0]);
  await assign(x, paths[1]);
  await setRoundabout(x);
  await until(async () => { const snap = await snapshot(x); return ["T1", "L", "S"].every((id) => findMoon(snap, id)?.status === "merged"); });

  const commissioned = events(x, "ship.commissioned").filter((event) => event.payload.ship.job === "delivery");
  assert.equal(commissioned.length, 3);
  const expected = new Map([["L", "light"], ["T1", "standard"], ["S", "heavy"]]);
  const log = x.w.g.db.all("events.since", { id: 0 }).map(rowToEvent);
  for (const event of commissioned) {
    const launch = log.find((candidate) => candidate.id === event.id + 1);
    assert.equal(launch?.kind, "voyage.launched");
    assert.equal(launch.payload.ship_id, event.payload.ship.id);
    const weight = expected.get(launch.task_id);
    assert.deepEqual([event.payload.ship.fleet, event.payload.ship.faction, event.payload.ship.weight], ["fake", "tinkers", weight]);
    assert.ok(formationsFor(weight).includes(event.payload.ship.formation.id));
    assert.ok(cargoFor(weight).includes(launch.payload.cargo.id));
  }
}));

test("2. Open deliveries are not capped by fleet size.", async () => scenario("happy", shipsPatch({}, (c) => {
  c.scheduler.max_concurrent_ships = 3;
  c.providers.inspector = { adapter: "fake", pool: { kind: "window", reserve_floor: 0.1 } };
  c.roles.review = ["inspector"];
}), async (x) => {
  const independent = ["T1", "B", "C", "D", "E", "F", "G"];
  const paths = writeSpecs(x.w, [
    ...independent.slice(1).map((id) => ({ id, scripts: ["happy"] })),
    { id: "H", deps: ["T1"], scripts: ["happy"] },
  ]);
  for (const specPath of paths) await assign(x, specPath);
  exhausted(x, "inspector", iso(3_600_000));
  await setRoundabout(x);
  await until(() => events(x, "voyage.returned").filter((event) => event.payload.role === "implement").length === 7);

  const deliveryShips = x.w.g.db.all("ships.all").filter((ship) => ship.job === "delivery");
  assert.equal(deliveryShips.length, 7);
  assert.equal(new Set(deliveryShips.map((ship) => ship.name)).size, 7);
  assert.ok(deliveryShips.every((ship) => ship.status === "assigned"));
  assert.deepEqual(new Set(events(x, "voyage.launched").filter((event) => event.payload.role === "implement").map((event) => event.task_id)), new Set(independent));
  assert.equal(events(x, "voyage.launched", "H").filter((event) => event.payload.role === "implement").length, 0);
  assert.notEqual(findMoon(await snapshot(x), "T1").status, "merged");
  assert.equal(events(x, "moon.adrift").length, 0);
  assert.equal(x.w.g.db.all("ships.all").filter((ship) => ship.job === "customs").length, 0);

  let inFlight = 0;
  for (const event of x.w.g.db.all("events.since", { id: 0 }).map(rowToEvent)) {
    if (event.kind === "voyage.launched") inFlight++;
    if (event.kind === "voyage.returned") inFlight--;
    assert.ok(inFlight <= 3, `no more than three voyages in flight (saw ${inFlight})`);
  }
}));

test("3. A delivery ship is reused after its cargo docks.", async () => scenario("happy", shipsPatch(), async (x) => {
  const [specPath] = writeSpecs(x.w, [{ id: "B", deps: ["T1"], tier: "terra", scripts: ["happy"] }]);
  await assign(x, specPath);
  await setRoundabout(x);
  await until(async () => { const snap = await snapshot(x); return ["T1", "B"].every((id) => findMoon(snap, id)?.status === "merged"); });
  const launches = events(x, "voyage.launched").filter((event) => event.payload.role === "implement");
  assert.deepEqual(launches.map((event) => event.task_id), ["T1", "B"]);
  assert.equal(launches[0].payload.ship_id, launches[1].payload.ship_id);
  const deliveryShips = x.w.g.db.all("ships.all").filter((ship) => ship.job === "delivery");
  assert.equal(deliveryShips.length, 1);
  assert.equal(deliveryShips[0].voyage_count, 2);
}));

test("4. A held delivery is refuelled on the spare provider.", async () => scenario("happy", shipsPatch({ refuel: { min_wait_minutes: 0 } }), async (x) => {
  reading(x, "fake", 0.95);
  await setRoundabout(x);
  const launch = await until(() => events(x, "voyage.launched", "T1").find((event) => event.payload.role === "implement"));
  const voyage = x.w.g.db.get("voyages.byId", { id: launch.voyage_id });
  const ship = x.w.g.db.all("ships.all").find((entry) => entry.id === voyage.ship_id);
  assert.deepEqual([voyage.provider, voyage.model], ["spare", "m-cheap"]);
  assert.deepEqual([ship.fleet, ship.faction, ship.weight], ["spare", "outriders", "light"]);
  assert.equal(launch.payload.refuel_for, "fake");
}));

const ownerCatalogue = {
  formations: [
    { id: "carrier-group", name: "Carrier group", job: "delivery", weights: ["standard"], vessels: [{ hull: "carrier", count: 1, role: "lead" }] },
    { id: "freighter-convoy", name: "Freighter convoy", job: "delivery", weights: ["standard"], vessels: [{ hull: "freighter", count: 1, role: "lead" }] },
    { id: "heavy-freighter-with-military-escort", name: "Heavy freighter", job: "delivery", weights: ["standard"], vessels: [{ hull: "heavy-freighter", count: 1, role: "lead" }] },
    { id: "tinkers-heavy", name: "Tinkers heavy formation", job: "delivery", weights: ["heavy"], factions: ["tinkers"], vessels: [{ hull: "tinker-carrier", count: 1, role: "lead" }] },
  ],
};

async function catalogueScenario(provider, body) {
  const w = makeRepo();
  let g, srv, webRoot;
  try {
    const patch = shipsPatch({}, (c) => {
      c.roles = { implement: [provider], review: [provider] };
      if (provider === "spare") c.providers.spare.weights = { sol: "heavy" };
    });
    initGalaxy(w.dir, { patchConfig: patch });
    w.write(".nexus/catalogue.json", `${JSON.stringify(ownerCatalogue, null, 2)}\n`);
    w.git("add", "-A");
    w.git("commit", "-qm", "nexus and catalogue");
    g = openGalaxy(w.dir, { scriptsDir: path.join(repoRoot, "tests", "fixtures", "scripts") });
    const { systemId } = createSystem(g, { slug: "s", title: "t", brief: "b", seed: 1 });
    const { planetId } = assignPlanet(g, { systemId, streamId: "P1", mission: "m", territory: ["src/**"] });
    const text = read("tests/fixtures/specs/good-basic.md")
      .replace("# TASK: thing-add-x", "# TASK: thing-add-x\n<!-- FAKE-SCRIPT: happy -->")
      .replace("**Model hint**: terra", "**Model hint**: sol");
    const specPath = writeSpec(w.dir, "T1", text);
    w.git("add", "-A");
    w.git("commit", "-qm", "spec");
    assignMoon(g, { planetId, specPath });
    webRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-web-"));
    srv = await startServer(g, { port: 0, webRoot, ...FAST.server });
    const origin = `http://127.0.0.1:${srv.port}`;
    const x = { w: { ...w, g, planetId }, srv, api: (requestPath, { method = "GET", requestBody, body = requestBody, headers = {} } = {}) => rawRequest(srv.port, {
      method, path: requestPath,
      headers: { cookie: `nexus_token=${srv.token}`, origin, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }) };
    await body(x);
    await finish(x);
    srv = null;
  } finally {
    if (srv) await srv.close();
    g?.close();
    if (webRoot) fs.rmSync(webRoot, { recursive: true, force: true });
    w.cleanup();
  }
}

test("5. The owner's catalogue shapes delivery ships by faction.", async () => {
  await catalogueScenario("fake", async (x) => {
    await setRoundabout(x);
    await until(async () => findMoon(await snapshot(x), "T1")?.status === "merged");
    const ship = x.w.g.db.all("ships.all").find((entry) => entry.job === "delivery");
    assert.equal(JSON.parse(ship.formation).id, "tinkers-heavy");
  });
  await catalogueScenario("spare", async (x) => {
    await setRoundabout(x);
    await until(async () => findMoon(await snapshot(x), "T1")?.status === "merged");
    const ship = x.w.g.db.all("ships.all").find((entry) => entry.job === "delivery");
    assert.equal(JSON.parse(ship.formation).id, "plain");
    assert.notEqual(JSON.parse(ship.formation).id, "tinkers-heavy");
  });
});
