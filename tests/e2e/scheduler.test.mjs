import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { dumpProjections, rebuild } from "../../dist/db/rebuild.js";
import { parkMoonOnly } from "../../dist/server/commands/park.js";
import { startServer } from "../../dist/server/http/server.js";
import { writeSpecs } from "../fixtures/world.mjs";
import { rawRequest, readFeed, startWorld } from "../http/helpers.mjs";

const FAST = { server: { pollMs: 20, schedulerTickMs: 200 } };
const ONE_SHIP = (c) => {
  c.roles = { implement: ["fake"], review: ["fake"] };
  c.routing.security_routed = ["src/auth.ts"];
  c.routing.do_not_touch = [".env"];
  c.scheduler = { ...(c.scheduler ?? {}), max_concurrent_ships: 1 };
};

async function until(fn, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${fn}`);
    await delay(10);
  }
}

const post = async (x, name, body) => {
  const response = await x.api(`/api/commands/${name}`, { method: "POST", body });
  assert.ok(response.status === 200 || response.status === 202, `${name}: ${response.status} ${response.text}`);
  return response;
};

async function snapshot(x) {
  const response = await x.api("/api/snapshot");
  assert.equal(response.status, 200);
  return response.json;
}

const findMoon = (snap, taskId) => snap.systems
  .flatMap((system) => system.planets)
  .flatMap((planet) => planet.moons)
  .find((moon) => moon.task_id === taskId);

async function moonDetail(x, taskId) {
  const response = await x.api(`/api/moons/${taskId}`);
  assert.equal(response.status, 200);
  return response.json;
}

async function assign(x, planetId, specPath) {
  return (await post(x, "moon.assign", { planetId, specPath })).json.result;
}

async function finish(x, server = x.srv) {
  await server.close();
  const before = dumpProjections(x.w.g.db);
  rebuild(x.w.g.db);
  assert.equal(dumpProjections(x.w.g.db), before, "rebuild byte-equal");
}

test("roundabout settles a three-moon planet unattended", async () => {
  const x = await startWorld("happy", undefined, FAST);
  const feed = readFeed(x.srv, { since: 0 });
  try {
    const [bPath, cPath] = writeSpecs(x.w, [
      { id: "B", deps: ["T1"], scripts: ["happy"] },
      { id: "C", scripts: ["happy"] },
    ]);
    await assign(x, x.w.planetId, bPath);
    await assign(x, x.w.planetId, cPath);

    let fixed = false;
    const real = x.w.g.adapters.fake;
    x.w.g.adapters.fake = {
      ...real,
      dispatch(job, ctx) {
        if (!fixed && job.role === "review" && job.specPath.endsWith("T1.md")) {
          fixed = true;
          return real.dispatch({ ...job, prompt: `FAKE-SCRIPT: review-fix\n${job.prompt}` }, ctx);
        }
        return real.dispatch(job, ctx);
      },
    };

    await post(x, "config.automation", { level: "roundabout" });
    await until(async () => {
      const snap = await snapshot(x);
      return ["T1", "B", "C"].every((id) => findMoon(snap, id)?.status === "merged");
    }, 20000);
    await feed.waitFor((events) => events.some((event) => event.kind === "voyage.docked" && event.task_id === "B"));

    const aDock = feed.events.find((event) => event.kind === "voyage.docked" && event.task_id === "T1");
    const bLaunch = feed.events.find((event) => event.kind === "voyage.launched" && event.task_id === "B" && event.payload.role === "implement");
    assert.ok(bLaunch.id > aDock.id, "B's implement freighter is sent only after A's freighter docks");
    const a = await moonDetail(x, "T1");
    assert.deepEqual(a.voyages.filter((voyage) => voyage.role === "implement").map((voyage) => voyage.round), [1, 2]);
    await finish(x);
  } finally { feed.close(); await x.close(); }
});

test("a REJECT holds only its own moon", async () => {
  const x = await startWorld("happy", undefined, FAST);
  try {
    const [bPath, cPath] = writeSpecs(x.w, [
      { id: "B", deps: ["T1"], scripts: ["happy"] },
      { id: "C", scripts: ["happy", "review-reject"] },
    ]);
    await assign(x, x.w.planetId, bPath);
    await assign(x, x.w.planetId, cPath);
    await post(x, "config.automation", { level: "roundabout" });
    const done = await until(async () => {
      const snap = await snapshot(x);
      return findMoon(snap, "T1")?.status === "merged"
        && findMoon(snap, "B")?.status === "merged"
        && findMoon(snap, "C")?.status === "quarantined" ? snap : null;
    }, 20000);
    assert.deepEqual(done.decisions.filter((decision) => decision.target_id === "C").map((decision) => decision.kind), ["reject"]);
    await finish(x);
  } finally { await x.close(); }
});

test("verdicts sends no first freighter", async () => {
  const x = await startWorld("happy", undefined, FAST);
  const feed = readFeed(x.srv, { since: 0 });
  try {
    await post(x, "config.automation", { level: "verdicts" });
    await delay(300);
    assert.equal(feed.events.some((event) => event.kind === "voyage.launched"), false);
    assert.deepEqual((await moonDetail(x, "T1")).voyages, []);
    await post(x, "moon.launch", { taskId: "T1" });
    await until(async () => findMoon(await snapshot(x), "T1")?.status === "merged");
    await finish(x);
  } finally { feed.close(); await x.close(); }
});

test("lowering the rung mid-run starts nothing new", async () => {
  const x = await startWorld("slow", undefined, FAST);
  const feed = readFeed(x.srv, { since: 0 });
  try {
    const [bPath] = writeSpecs(x.w, [{ id: "B", deps: ["T1"], scripts: ["happy"] }]);
    await assign(x, x.w.planetId, bPath);
    await post(x, "config.automation", { level: "roundabout" });
    await until(async () => findMoon(await snapshot(x), "T1")?.status === "implementing");
    await post(x, "config.automation", { level: "manual" });
    await until(async () => findMoon(await snapshot(x), "T1")?.status === "audited");
    await delay(300);
    const detail = await moonDetail(x, "T1");
    assert.equal(detail.voyages.find((voyage) => voyage.role === "implement")?.status, "holding");
    // Nothing but the rung holds A: no question is pending, and customs could inspect if anyone asked.
    assert.deepEqual(detail.decisions, []);
    assert.deepEqual(detail.actions, ["inspect"]);
    assert.deepEqual((await moonDetail(x, "B")).voyages, []);
    assert.equal(feed.events.some((event) => event.kind === "voyage.launched" && event.task_id === "B"), false);
    assert.equal(findMoon(await snapshot(x), "T1").status, "audited");
    await finish(x);
  } finally { feed.close(); await x.close(); }
});

test("a restart resumes from the log", async () => {
  const x = await startWorld("slow", ONE_SHIP, FAST);
  let restarted;
  try {
    const [cPath] = writeSpecs(x.w, [{ id: "C", scripts: ["happy"] }]);
    await assign(x, x.w.planetId, cPath);
    await post(x, "config.automation", { level: "roundabout" });
    await until(async () => findMoon(await snapshot(x), "T1")?.status === "implementing");
    await x.srv.close();

    restarted = await startServer(x.w.g, { port: 0, webRoot: x.webRoot, pollMs: 20, schedulerTickMs: 200 });
    x.api = (path, { method = "GET", body, headers = {} } = {}) => rawRequest(restarted.port, {
      method,
      path,
      headers: { cookie: `nexus_token=${restarted.token}`, origin: restarted.url, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const done = await until(async () => {
      const snap = await snapshot(x);
      return findMoon(snap, "C")?.status === "merged" && findMoon(snap, "T1")?.status === "adrift" ? snap : null;
    }, 20000);
    assert.equal(done.decisions.filter((decision) => decision.target_id === "T1").length, 1);
    const a = await moonDetail(x, "T1");
    assert.deepEqual(a.voyages.filter((voyage) => voyage.role === "implement").map((voyage) => voyage.round), [1]);
    const c = await moonDetail(x, "C");
    const cLaunches = c.events.filter((event) => event.kind === "voyage.launched" && event.payload.role === "implement");
    assert.equal(cLaunches.length, 1);
    assert.ok(cLaunches[0].id > a.events.find((event) => event.kind === "moon.adrift").id);
    await finish(x, restarted);
  } finally { if (restarted) await restarted.close(); await x.close(); }
});

test("a planet with dependencies gets no first freighter", async () => {
  const x = await startWorld("happy", undefined, FAST);
  const feed = readFeed(x.srv, { since: 0 });
  try {
    const [dPath] = writeSpecs(x.w, [{ id: "D", scripts: ["happy"] }]);
    const planet = await post(x, "planet.assign", {
      systemId: x.w.systemId,
      streamId: "P2",
      mission: "dependent planet",
      territory: ["src/**"],
      dependsOn: ["P1"],
    });
    await assign(x, planet.json.result.planetId, dPath);
    await post(x, "config.automation", { level: "roundabout" });
    await until(async () => findMoon(await snapshot(x), "T1")?.status === "merged");
    await delay(300);
    assert.deepEqual((await moonDetail(x, "D")).voyages, []);
    assert.equal(feed.events.some((event) => event.kind === "voyage.launched" && event.task_id === "D"), false);
    assert.deepEqual(findMoon(await snapshot(x), "D").waiting_on_planets, ["P1"]);
    await post(x, "moon.launch", { taskId: "D" });
    await until(async () => findMoon(await snapshot(x), "D")?.status === "merged");
    await finish(x);
  } finally { feed.close(); await x.close(); }
});

test("a reply to a never-visited adrift moon", async () => {
  const x = await startWorld("happy", undefined, FAST);
  const feed = readFeed(x.srv, { since: 0 });
  try {
    parkMoonOnly(x.w.g, { taskId: "T1", reason: "test_hold", details: "held for the test" });
    await post(x, "config.automation", { level: "verdicts" });
    await post(x, "moon.reply", { taskId: "T1", note: "continue" });
    await delay(300);
    const detail = await moonDetail(x, "T1");
    assert.deepEqual(detail.voyages, []);
    assert.equal(detail.moon.status, "adrift");
    assert.equal(feed.events.some((event) => event.kind === "voyage.launched" && event.task_id === "T1"), false);
    await post(x, "config.automation", { level: "roundabout" });
    await until(async () => findMoon(await snapshot(x), "T1")?.status === "merged");
    await feed.waitFor((events) => events.some((event) => event.kind === "voyage.launched" && event.task_id === "T1"));
    assert.equal(feed.events.some((event) => event.kind === "voyage.launched" && event.task_id === "T1"), true);
    await finish(x);
  } finally { feed.close(); await x.close(); }
});
