import { test } from "node:test";
import assert from "node:assert/strict";
import { makeGalaxy, read, writeSpec } from "../helpers.mjs";
import { worldWithMoon } from "../fixtures/world.mjs";
import { createSystem } from "../../dist/server/commands/system.js";
import { assignMoon, assignPlanet } from "../../dist/server/commands/assign.js";
import { launchMoon } from "../../dist/server/commands/launch.js";
import { inspectMoon } from "../../dist/server/commands/review.js";
import { parkMoonOnly, replyMoon } from "../../dist/server/commands/park.js";
import { append } from "../../dist/db/events.js";
import { loadMoon, moonScope } from "../../dist/server/dispatch.js";
import { effectiveRung, plan } from "../../dist/server/scheduler/plan.js";

const ctx = (rung, extra = {}) => ({ ownPid: process.pid, rung, ...extra });
const action = (name, taskId = "T1", first = false) => ({ action: name, taskId, first });

function patchConfig(config, options = {}) {
  config.roles = { implement: ["fake"], review: ["fake"] };
  config.routing.security_routed = ["src/auth.ts"];
  config.routing.do_not_touch = [".env"];
  if (options.max !== undefined) config.scheduler.max_concurrent_ships = options.max;
  if (options.providerMax !== undefined) config.scheduler.per_provider_max = { fake: options.providerMax };
  if (options.freighters !== undefined) config.fleet.freighters = options.freighters;
  if (options.customs !== undefined) config.fleet.customs = options.customs;
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
    await launchMoon(w.g, { taskId: "T1", provider: "fake" });
    assert.deepEqual(plan(w.g, ctx("manual")), []);
    await inspectMoon(w.g, { taskId: "T1", provider: "fake" });
    assert.deepEqual(plan(w.g, ctx("manual")), []);
  });
});

test("the first freighter is sent only at roundabout", async () => {
  await withWorld(() => worldWithMoon(), async (w) => {
    assert.deepEqual(plan(w.g, ctx("verdicts")), []);
    assert.deepEqual(plan(w.g, ctx("roundabout")), [action("launch", "T1", true)]);
  });
});

test("customs inspects a holding freighter at verdicts and roundabout", async () => {
  await withWorld(() => worldWithMoon(), async (w) => {
    await launchMoon(w.g, { taskId: "T1", provider: "fake" });
    for (const rung of ["verdicts", "roundabout"]) assert.deepEqual(plan(w.g, ctx(rung)), [action("inspect")]);
  });
});

test("an approved freighter docks at verdicts and roundabout even when a voyage fills capacity", async () => {
  await withWorld(() => world([{ taskId: "T1" }, { taskId: "T2" }], { max: 1 }), async (w) => {
    await launchMoon(w.g, { taskId: "T1", provider: "fake" });
    await inspectMoon(w.g, { taskId: "T1", provider: "fake" });
    let started;
    const running = new Promise((resolve) => { started = resolve; });
    w.g.adapters.fake = { ...w.g.adapters.fake, async *dispatch(_job, adapterCtx) {
      started(); await new Promise((resolve) => adapterCtx.signal.addEventListener("abort", resolve, { once: true }));
    } };
    const abort = new AbortController();
    const launch = launchMoon(w.g, { taskId: "T2", provider: "fake", signal: abort.signal });
    await running;
    for (const rung of ["verdicts", "roundabout"]) assert.deepEqual(plan(w.g, ctx(rung)), [action("dock")]);
    abort.abort(); await launch;
  });
});

test("a FIX verdict plans the next freighter as a later visit", async () => {
  await withWorld(() => worldWithMoon("fix-round"), async (w) => {
    await launchMoon(w.g, { taskId: "T1", provider: "fake" });
    await inspectMoon(w.g, { taskId: "T1", provider: "fake", reviewScript: "review-fix" });
    for (const rung of ["verdicts", "roundabout"]) assert.deepEqual(plan(w.g, ctx(rung)), [action("launch")]);
  });
});

test("replied parked moons distinguish a visited moon from a first visit", async () => {
  await withWorld(() => worldWithMoon(), async (w) => {
    await launchMoon(w.g, { taskId: "T1", provider: "fake" });
    parkMoonOnly(w.g, { taskId: "T1", reason: "pause", details: "pause" });
    replyMoon(w.g, { taskId: "T1", note: "continue" });
    for (const rung of ["verdicts", "roundabout"]) assert.deepEqual(plan(w.g, ctx(rung)), [action("launch")]);
  });
  await withWorld(() => worldWithMoon(), async (w) => {
    parkMoonOnly(w.g, { taskId: "T1", reason: "pause", details: "pause" });
    replyMoon(w.g, { taskId: "T1", note: "continue" });
    assert.deepEqual(plan(w.g, ctx("verdicts")), []);
    assert.deepEqual(plan(w.g, ctx("roundabout")), [action("launch", "T1", true)]);
  });
});

test("parked moons without a reply are not planned", async () => {
  for (const reviewScript of [undefined, "review-reject"]) {
    await withWorld(() => worldWithMoon(), async (w) => {
      if (reviewScript) {
        await launchMoon(w.g, { taskId: "T1", provider: "fake" });
        await inspectMoon(w.g, { taskId: "T1", provider: "fake", reviewScript });
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
    const launch = launchMoon(w.g, { taskId: "T1", provider: "fake", signal: abort.signal });
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

test("moon dependencies block first freighters, including cycles", async () => {
  await withWorld(() => world([{ taskId: "A" }, { taskId: "B", dependsOn: "A" }]), async (w) => {
    assert.deepEqual(plan(w.g, ctx("roundabout")), [action("launch", "A", true)]);
  });
  await withWorld(() => world([{ taskId: "A", dependsOn: "B" }, { taskId: "B", dependsOn: "A" }]), async (w) => {
    assert.deepEqual(plan(w.g, ctx("roundabout")), []);
  });
});

test("a planet dependency blocks only the first freighter", async () => {
  await withWorld(() => world([{ taskId: "T1" }], { planetDependsOn: ["P0"] }), async (w) => {
    assert.deepEqual(plan(w.g, ctx("roundabout")), []);
    await launchMoon(w.g, { taskId: "T1", provider: "fake" });
    assert.deepEqual(plan(w.g, ctx("roundabout")), [action("inspect")]);
  });
});

test("global, provider, and idle-freighter capacity limit first freighters", async () => {
  const moons = [{ taskId: "T1" }, { taskId: "T2" }, { taskId: "T3" }];
  for (const [options, expected] of [[{ max: 2 }, 2], [{ providerMax: 1 }, 1], [{ freighters: 2, max: 6 }, 2]]) {
    await withWorld(() => world(moons, options), async (w) => {
      const planned = plan(w.g, ctx("roundabout"));
      assert.equal(planned.length, expected);
      assert.ok(planned.every((item) => item.action === "launch" && item.first));
    });
  }
});

test("result order is dock, inspect, later launch, then first launches by assignment", async () => {
  const moons = [
    { taskId: "FIRST1" }, { taskId: "FIX", script: "fix-round" }, { taskId: "INSPECT" },
    { taskId: "DOCK" }, { taskId: "FIRST2" },
  ];
  await withWorld(() => world(moons, { freighters: 5, customs: 2, max: 10 }), async (w) => {
    await launchMoon(w.g, { taskId: "DOCK", provider: "fake" });
    await inspectMoon(w.g, { taskId: "DOCK", provider: "fake" });
    await launchMoon(w.g, { taskId: "INSPECT", provider: "fake" });
    await launchMoon(w.g, { taskId: "FIX", provider: "fake" });
    await inspectMoon(w.g, { taskId: "FIX", provider: "fake", reviewScript: "review-fix" });
    const before = w.g.db.get("events.maxId").id;
    const planned = plan(w.g, ctx("roundabout"));
    const after = w.g.db.get("events.maxId").id;
    assert.deepEqual(planned, [
      action("dock", "DOCK"), action("inspect", "INSPECT"), action("launch", "FIX"),
      action("launch", "FIRST1", true), action("launch", "FIRST2", true),
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
