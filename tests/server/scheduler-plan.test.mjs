import { test } from "node:test";
import assert from "node:assert/strict";
import { makeGalaxy, read, writeSpec } from "../helpers.mjs";
import { worldWithMoon } from "../fixtures/world.mjs";
import { createSystem } from "../../dist/server/commands/system.js";
import { assignMoon, assignPlanet } from "../../dist/server/commands/assign.js";
import { sendDelivery } from "../../dist/server/commands/delivery.js";
import { sendCustoms } from "../../dist/server/commands/customs.js";
import { parkMoonOnly, replyMoon } from "../../dist/server/commands/park.js";
import { append, rowToEvent } from "../../dist/db/events.js";
import { loadMoon, moonScope } from "../../dist/server/dispatch.js";
import { effectiveRung, plan, planWithHolds } from "../../dist/server/scheduler/plan.js";

const T = Date.parse("2026-11-17T12:00:00.000Z");
const R = "2026-11-17T13:00:00.000Z";
const U = "2026-11-17T14:00:00.000Z";

const ctx = (rung, extra = {}) => ({ ownPid: process.pid, rung, ...extra });
const action = (name, taskId = "T1", first = false) => ({ action: name, taskId, first });

function patchConfig(config, options = {}) {
  if (options.pool) config.providers.fake.pool = { kind: "window", reserve_floor: 0.1,
    ...(options.refuel ? { refuel: { provider: "probe", models: { terra: "m-cheap" }, min_wait_minutes: options.minWait ?? 0 } } : {}) };
  if (options.probe || options.refuel) config.providers.probe = { adapter: "fake", pool: { kind: "window", reserve_floor: 0.1 } };
  config.roles = { implement: options.probe ? ["fake", "probe"] : ["fake"], review: options.probe ? ["fake", "probe"] : ["fake"] };
  config.routing.security_routed = ["src/auth.ts"];
  config.routing.do_not_touch = [".env"];
  if (options.max !== undefined) config.scheduler.max_concurrent_ships = options.max;
  if (options.providerMax !== undefined) config.scheduler.per_provider_max = { fake: options.providerMax };
  if (options.providerCaps !== undefined) config.scheduler.per_provider_max = options.providerCaps;
  if (options.freighters !== undefined) config.fleet.freighters = options.freighters;
  if (options.customs !== undefined) config.fleet.customs = options.customs;
}

function low(w, provider = "fake") {
  append(w.g.db, { kind: "fuel.reading", provider, ts: new Date(T).toISOString(), payload: {
    window: "window", used: 0.95, resets_at: R, source: "reported",
  } });
}

function dry(w, provider = "fake") {
  append(w.g.db, { kind: "fuel.exhausted", provider, ts: new Date(Date.now() + 60_000).toISOString(), payload: { until: U, voyage_id: "v" } });
}

function spec(taskId, dependsOn = "none", script = "happy") {
  return read("tests/fixtures/specs/good-basic.md")
    .replace("# TASK: thing-add-x", `# TASK: ${taskId}\n<!-- FAKE-SCRIPT: ${script} -->`)
    .replace("- **Depends on**: none", `- **Depends on**: ${dependsOn}`);
}

async function world(moons, options = {}) {
  const w = await makeGalaxy((config) => patchConfig(config, options));
  const { systemId } = createSystem(w.g, { slug: "s", title: "t", brief: "b", seed: 1 });
  const { planetId } = assignPlanet(w.g, {
    systemId, streamId: "P1", mission: "m", territory: ["src/**"], dependsOn: options.planetDependsOn,
  });
  const paths = moons.map((moon) => [moon.taskId, writeSpec(w.dir, moon.taskId, spec(moon.taskId, moon.dependsOn, moon.script))]);
  w.git("add", "-A"); w.git("commit", "-qm", "specs");
  for (const [, path] of paths) assignMoon(w.g, { planetId, specPath: path });
  return { ...w, systemId, planetId };
}

async function withWorld(make, body) {
  const w = await make();
  try { await body(w); } finally { w.cleanup(); }
}

test("effectiveRung maps supported and future levels", () => {
  assert.equal(effectiveRung("manual"), "manual");
  assert.equal(effectiveRung("verdicts"), "verdicts");
  for (const level of ["roundabout", "highways", "autopilot"]) assert.equal(effectiveRung(level), "roundabout");
  assert.equal(effectiveRung("unknown"), "manual");
});

test("manual plans nothing in emitted, holding, and approved states", async () => {
  await withWorld(() => worldWithMoon(), async (w) => assert.deepEqual(plan(w.g, ctx("manual")), []));
  await withWorld(() => worldWithMoon(), async (w) => {
    await sendDelivery(w.g, { taskId: "T1", provider: "fake" });
    assert.deepEqual(plan(w.g, ctx("manual")), []);
    await sendCustoms(w.g, { taskId: "T1", provider: "fake" });
    assert.deepEqual(plan(w.g, ctx("manual")), []);
  });
});

test("the first delivery is sent only at roundabout", async () => {
  await withWorld(() => worldWithMoon(), async (w) => {
    assert.deepEqual(plan(w.g, ctx("verdicts")), []);
    assert.deepEqual(plan(w.g, ctx("roundabout")), [action("send", "T1", true)]);
  });
});

test("customs inspects a holding delivery at verdicts and roundabout", async () => {
  await withWorld(() => worldWithMoon(), async (w) => {
    await sendDelivery(w.g, { taskId: "T1", provider: "fake" });
    for (const rung of ["verdicts", "roundabout"]) assert.deepEqual(plan(w.g, ctx(rung)), [action("inspect")]);
  });
});

test("an approved delivery docks at verdicts and roundabout even when a voyage fills capacity", async () => {
  await withWorld(() => world([{ taskId: "T1" }, { taskId: "T2" }], { max: 1 }), async (w) => {
    await sendDelivery(w.g, { taskId: "T1", provider: "fake" });
    await sendCustoms(w.g, { taskId: "T1", provider: "fake" });
    let started;
    const running = new Promise((resolve) => { started = resolve; });
    w.g.adapters.fake = { ...w.g.adapters.fake, async *dispatch(_job, adapterCtx) {
      started(); await new Promise((resolve) => adapterCtx.signal.addEventListener("abort", resolve, { once: true }));
    } };
    const abort = new AbortController();
    const launch = sendDelivery(w.g, { taskId: "T2", provider: "fake", signal: abort.signal });
    await running;
    for (const rung of ["verdicts", "roundabout"]) assert.deepEqual(plan(w.g, ctx(rung)), [action("dock")]);
    abort.abort(); await launch;
  });
});

test("a FIX verdict plans the next delivery as a later visit", async () => {
  await withWorld(() => worldWithMoon("fix-round"), async (w) => {
    await sendDelivery(w.g, { taskId: "T1", provider: "fake" });
    await sendCustoms(w.g, { taskId: "T1", provider: "fake", reviewScript: "review-fix" });
    for (const rung of ["verdicts", "roundabout"]) assert.deepEqual(plan(w.g, ctx(rung)), [action("send")]);
  });
});

test("replied parked moons distinguish a visited moon from a first visit", async () => {
  await withWorld(() => worldWithMoon(), async (w) => {
    await sendDelivery(w.g, { taskId: "T1", provider: "fake" });
    parkMoonOnly(w.g, { taskId: "T1", reason: "pause", details: "pause" });
    replyMoon(w.g, { taskId: "T1", note: "continue" });
    for (const rung of ["verdicts", "roundabout"]) assert.deepEqual(plan(w.g, ctx(rung)), [action("send")]);
  });
  await withWorld(() => worldWithMoon(), async (w) => {
    parkMoonOnly(w.g, { taskId: "T1", reason: "pause", details: "pause" });
    replyMoon(w.g, { taskId: "T1", note: "continue" });
    assert.deepEqual(plan(w.g, ctx("verdicts")), []);
    assert.deepEqual(plan(w.g, ctx("roundabout")), [action("send", "T1", true)]);
  });
});

test("parked moons without a reply are not planned", async () => {
  for (const reviewScript of [undefined, "review-reject"]) {
    await withWorld(() => worldWithMoon(), async (w) => {
      if (reviewScript) {
        await sendDelivery(w.g, { taskId: "T1", provider: "fake" });
        await sendCustoms(w.g, { taskId: "T1", provider: "fake", reviewScript });
      } else parkMoonOnly(w.g, { taskId: "T1", reason: "pause", details: "pause" });
      assert.deepEqual(plan(w.g, ctx("roundabout")), []);
    });
  }
});

test("a stale voyage is parked at verdicts and roundabout", async () => {
  await withWorld(() => worldWithMoon(), async (w) => {
    let started;
    const running = new Promise((resolve) => { started = resolve; });
    w.g.adapters.fake = { ...w.g.adapters.fake, async *dispatch(_job, adapterCtx) {
      started(); await new Promise((resolve) => adapterCtx.signal.addEventListener("abort", resolve, { once: true }));
    } };
    const abort = new AbortController();
    const launch = sendDelivery(w.g, { taskId: "T1", provider: "fake", signal: abort.signal });
    await running;
    for (const rung of ["verdicts", "roundabout"]) {
      assert.deepEqual(plan(w.g, ctx(rung, { tracks: () => false })), [action("park_stale")]);
    }
    abort.abort(); await launch;
  });
});

test("a pending main-tree question blocks every automatic action", async () => {
  await withWorld(() => worldWithMoon(), async (w) => {
    const moon = loadMoon(w.g, "T1");
    append(w.g.db, { kind: "decision.opened", ...moonScope(w.g, moon), payload: {
      kind: "main_tree_changed", target_kind: "moon", target_id: "T1", reasoning: "changed",
    } });
    assert.deepEqual(plan(w.g, ctx("roundabout")), []);
  });
});

test("moon dependencies block first deliveries, including cycles", async () => {
  await withWorld(() => world([{ taskId: "A" }, { taskId: "B", dependsOn: "A" }]), async (w) => {
    assert.deepEqual(plan(w.g, ctx("roundabout")), [action("send", "A", true)]);
  });
  await withWorld(() => world([{ taskId: "A", dependsOn: "B" }, { taskId: "B", dependsOn: "A" }]), async (w) => {
    assert.deepEqual(plan(w.g, ctx("roundabout")), []);
  });
});

test("a planet dependency blocks only the first delivery", async () => {
  await withWorld(() => world([{ taskId: "T1" }], { planetDependsOn: ["P0"] }), async (w) => {
    assert.deepEqual(plan(w.g, ctx("roundabout")), []);
    await sendDelivery(w.g, { taskId: "T1", provider: "fake" });
    assert.deepEqual(plan(w.g, ctx("roundabout")), [action("inspect")]);
  });
});

test("global and provider capacity limit first delivery ships; fleet size does not", async () => {
  const moons = [{ taskId: "T1" }, { taskId: "T2" }, { taskId: "T3" }];
  for (const [options, expected] of [[{ max: 2 }, 2], [{ providerMax: 1 }, 1], [{ freighters: 2, max: 6 }, 3]]) {
    await withWorld(() => world(moons, options), async (w) => {
      const planned = plan(w.g, ctx("roundabout"));
      assert.equal(planned.length, expected);
      assert.ok(planned.every((item) => item.action === "send" && item.first));
    });
  }
});

test("result order is dock, inspect, later launch, then first launches by assignment", async () => {
  const moons = [
    { taskId: "FIRST1" }, { taskId: "FIX", script: "fix-round" }, { taskId: "INSPECT" },
    { taskId: "DOCK" }, { taskId: "FIRST2" },
  ];
  await withWorld(() => world(moons, { freighters: 5, customs: 2, max: 10 }), async (w) => {
    await sendDelivery(w.g, { taskId: "DOCK", provider: "fake" });
    await sendCustoms(w.g, { taskId: "DOCK", provider: "fake" });
    await sendDelivery(w.g, { taskId: "INSPECT", provider: "fake" });
    await sendDelivery(w.g, { taskId: "FIX", provider: "fake" });
    await sendCustoms(w.g, { taskId: "FIX", provider: "fake", reviewScript: "review-fix" });
    const before = w.g.db.get("events.maxId").id;
    const planned = plan(w.g, ctx("roundabout"));
    const after = w.g.db.get("events.maxId").id;
    assert.deepEqual(planned, [
      action("dock", "DOCK"), action("inspect", "INSPECT"), action("send", "FIX"),
      action("send", "FIRST1", true), action("send", "FIRST2", true),
    ]);
    assert.equal(after, before);
  });
});

test("busy tasks are omitted and planning writes no events", async () => {
  await withWorld(() => worldWithMoon(), async (w) => {
    const before = w.g.db.get("events.maxId").id;
    assert.deepEqual(plan(w.g, ctx("roundabout", { busy: new Set(["T1"]) })), []);
    assert.equal(w.g.db.get("events.maxId").id, before);
  });
});

test("plan is planWithHolds(...).actions", async () => {
  await withWorld(() => world([{ taskId: "T1" }]), async (w) => {
    const planned = planWithHolds(w.g, ctx("roundabout"));
    assert.deepEqual(planned, { actions: [{ action: "send", taskId: "T1", first: true }], holds: [] });
    assert.deepEqual(plan(w.g, ctx("roundabout")), planned.actions);
  });
});

test("a low pool holds the first delivery at roundabout", async () => {
  await withWorld(() => world([{ taskId: "T1" }], { pool: true }), async (w) => {
    w.g.now = () => T; low(w);
    assert.deepEqual(planWithHolds(w.g, ctx("roundabout")), { actions: [], holds: [
      { taskId: "T1", role: "implement", provider: "fake", reason: "low", until: R },
    ] });
  });
});

test("a low pool does not hold customs", async () => {
  await withWorld(() => world([{ taskId: "T1" }], { pool: true }), async (w) => {
    w.g.now = () => T; await sendDelivery(w.g, { taskId: "T1", provider: "fake" }); low(w);
    for (const rung of ["verdicts", "roundabout"]) {
      assert.deepEqual(planWithHolds(w.g, ctx(rung)), { actions: [{ action: "inspect", taskId: "T1", first: false }], holds: [] });
    }
  });
});

test("a dry pool holds customs too", async () => {
  await withWorld(() => world([{ taskId: "T1" }], { pool: true }), async (w) => {
    w.g.now = () => T; await sendDelivery(w.g, { taskId: "T1", provider: "fake" }); dry(w);
    assert.deepEqual(planWithHolds(w.g, ctx("verdicts")), { actions: [], holds: [
      { taskId: "T1", role: "review", provider: "fake", reason: "dry", until: U },
    ] });
  });
});

test("a dry pool holds a later-visit delivery at verdicts", async () => {
  await withWorld(() => world([{ taskId: "T1", script: "fix-round" }], { pool: true }), async (w) => {
    w.g.now = () => T;
    await sendDelivery(w.g, { taskId: "T1", provider: "fake" });
    await sendCustoms(w.g, { taskId: "T1", provider: "fake", reviewScript: "review-fix" });
    dry(w);
    assert.deepEqual(planWithHolds(w.g, ctx("verdicts")), { actions: [], holds: [
      { taskId: "T1", role: "implement", provider: "fake", reason: "dry", until: U },
    ] });
  });
});

test("a low first provider reroutes a delivery", async () => {
  await withWorld(() => world([{ taskId: "T1" }], { pool: true, probe: true }), async (w) => {
    w.g.now = () => T; low(w);
    assert.deepEqual(planWithHolds(w.g, ctx("roundabout")), { actions: [
      { action: "send", taskId: "T1", first: true, provider: "probe" },
    ], holds: [] });
  });
});

test("a low first provider refuels a delivery when the wait is worthwhile", async () => {
  await withWorld(() => world([{ taskId: "T1" }], { pool: true, refuel: true }), async (w) => {
    w.g.now = () => T; low(w);
    assert.deepEqual(planWithHolds(w.g, ctx("roundabout")), { actions: [
      { action: "send", taskId: "T1", first: true, provider: "probe", model: "m-cheap", refuel: true },
    ], holds: [] });
  });
  await withWorld(() => world([{ taskId: "T1" }], { pool: true, refuel: true, minWait: 90 }), async (w) => {
    w.g.now = () => T; low(w);
    assert.deepEqual(planWithHolds(w.g, ctx("roundabout")), { actions: [], holds: [
      { taskId: "T1", role: "implement", provider: "fake", reason: "low", until: R },
    ] });
  });
});

test("capacity holds across reroutes", async () => {
  const moons = [{ taskId: "T1" }, { taskId: "T2" }];
  await withWorld(() => world(moons, { pool: true, probe: true, freighters: 2, max: 4, providerCaps: { probe: 1 } }), async (w) => {
    w.g.now = () => T; low(w);
    assert.deepEqual(planWithHolds(w.g, ctx("roundabout")), {
      actions: [{ action: "send", taskId: "T1", first: true, provider: "probe" }],
      holds: [{ taskId: "T2", role: "implement", provider: "fake", reason: "low", until: R }],
    });
  });
  await withWorld(() => world(moons, { pool: true, probe: true, freighters: 2, max: 1 }), async (w) => {
    w.g.now = () => T;
    assert.deepEqual(planWithHolds(w.g, ctx("roundabout")), {
      actions: [{ action: "send", taskId: "T1", first: true }], holds: [],
    });
  });
});

test("two deliveries on one fleet are both planned in one call, whatever the fleet size", async () => {
  const moons = [{ taskId: "T1" }, { taskId: "T2" }];
  await withWorld(() => world(moons, { freighters: 2, max: 4 }), async (w) => {
    assert.deepEqual(planWithHolds(w.g, ctx("roundabout")).actions, [action("send", "T1", true), action("send", "T2", true)]);
  });
  await withWorld(() => world(moons, { freighters: 1, max: 4 }), async (w) => {
    assert.deepEqual(planWithHolds(w.g, ctx("roundabout")), { actions: [action("send", "T1", true), action("send", "T2", true)], holds: [] });
    assert.equal(w.g.db.all("ships.all").length, 0, "planning commissions no ship");
  });
});

test("docking and parking a stale voyage ignore fuel", async () => {
  await withWorld(() => world([{ taskId: "T1" }], { pool: true }), async (w) => {
    w.g.now = () => T;
    await sendDelivery(w.g, { taskId: "T1", provider: "fake" });
    await sendCustoms(w.g, { taskId: "T1", provider: "fake" });
    dry(w);
    assert.deepEqual(planWithHolds(w.g, ctx("verdicts")), { actions: [action("dock")], holds: [] });
  });
  await withWorld(() => world([{ taskId: "T1" }], { pool: true }), async (w) => {
    w.g.now = () => T;
    let started;
    const running = new Promise((resolve) => { started = resolve; });
    w.g.adapters.fake = { ...w.g.adapters.fake, async *dispatch(_job, adapterCtx) {
      started(); await new Promise((resolve) => adapterCtx.signal.addEventListener("abort", resolve, { once: true }));
    } };
    const abort = new AbortController();
    const launch = sendDelivery(w.g, { taskId: "T1", provider: "fake", signal: abort.signal });
    await running; dry(w);
    assert.deepEqual(planWithHolds(w.g, ctx("verdicts", { tracks: () => false })), { actions: [action("park_stale")], holds: [] });
    abort.abort(); await launch;
  });
});

test("cargo awaiting pickup is planned once the pool is back", async () => {
  await withWorld(() => world([{ taskId: "T1", script: "wall" }], { pool: true }), async (w) => {
    w.g.now = () => T;
    assert.equal((await sendDelivery(w.g, { taskId: "T1", provider: "fake" })).moonStatus, "awaiting_pickup");
    const until = rowToEvent(w.g.db.all("events.latestByKindProvider", { kind: "fuel.exhausted", provider: "fake", limit: 1 })[0]).payload.until;
    for (const rung of ["verdicts", "roundabout"]) {
      assert.deepEqual(planWithHolds(w.g, ctx(rung)), { actions: [], holds: [
        { taskId: "T1", role: "implement", provider: "fake", reason: "dry", until },
      ] });
    }
    assert.deepEqual(planWithHolds(w.g, ctx("manual")), { actions: [], holds: [] });
    w.g.now = () => Date.now() + 10 * 60_000;
    for (const rung of ["verdicts", "roundabout"]) {
      assert.deepEqual(planWithHolds(w.g, ctx(rung)), { actions: [{ action: "send", taskId: "T1", first: false }], holds: [] });
    }
    assert.deepEqual(planWithHolds(w.g, ctx("manual")), { actions: [], holds: [] });
  });
});

test("a busy task produces neither an action nor a hold", async () => {
  await withWorld(() => world([{ taskId: "T1" }], { pool: true }), async (w) => {
    w.g.now = () => T; low(w);
    assert.deepEqual(planWithHolds(w.g, ctx("roundabout", { busy: new Set(["T1"]) })), { actions: [], holds: [] });
  });
});

test("planWithHolds writes nothing", async () => {
  await withWorld(() => world([{ taskId: "T1" }], { pool: true }), async (w) => {
    w.g.now = () => T;
    const beforeAction = w.g.db.get("events.maxId").id;
    assert.equal(planWithHolds(w.g, ctx("roundabout")).actions.length, 1);
    assert.equal(w.g.db.get("events.maxId").id, beforeAction);
    low(w);
    const beforeHold = w.g.db.get("events.maxId").id;
    assert.equal(planWithHolds(w.g, ctx("roundabout")).holds.length, 1);
    assert.equal(w.g.db.get("events.maxId").id, beforeHold);
  });
});
