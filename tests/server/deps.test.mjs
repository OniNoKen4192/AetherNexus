import { test } from "node:test";
import assert from "node:assert/strict";
import { makeGalaxy, read, writeSpec } from "../helpers.mjs";
import { createSystem } from "../../dist/server/commands/system.js";
import { assignMoon, assignPlanet } from "../../dist/server/commands/assign.js";
import { dependencyState } from "../../dist/server/commands/deps.js";
import { sendDelivery } from "../../dist/server/commands/delivery.js";
import { sendCustoms } from "../../dist/server/commands/customs.js";
import { dockCargo } from "../../dist/server/commands/dock.js";
import { moonDetail, snapshot } from "../../dist/server/commands/query.js";

const ctx = { ownPid: process.pid, failures: [] };

function spec(taskId, dependsOn = "none", script = "happy") {
  return read("tests/fixtures/specs/good-basic.md")
    .replace("# TASK: thing-add-x", `# TASK: ${taskId}\n<!-- FAKE-SCRIPT: ${script} -->`)
    .replace("- **Depends on**: none", `- **Depends on**: ${dependsOn}`);
}

async function world(planets) {
  const w = await makeGalaxy();
  const { systemId } = createSystem(w.g, { slug: "s", title: "t", brief: "b", seed: 1 });
  const assigned = {};
  for (const p of planets) {
    const { planetId } = assignPlanet(w.g, {
      systemId, streamId: p.streamId, mission: "m", territory: ["src/**"], dependsOn: p.dependsOn,
    });
    for (const m of p.moons) {
      const specPath = writeSpec(w.dir, m.taskId, spec(m.taskId, m.dependsOn, m.script));
      assigned[m.taskId] = { planetId, specPath };
    }
  }
  w.git("add", "-A");
  w.git("commit", "-qm", "specs");
  for (const [taskId, m] of Object.entries(assigned)) {
    const result = assignMoon(w.g, { planetId: m.planetId, specPath: m.specPath });
    assigned[taskId].moonId = result.moonId;
  }
  return { ...w, systemId, assigned };
}

function snapshotMoon(g, taskId) {
  for (const system of snapshot(g, ctx).systems) {
    for (const planet of system.planets) {
      const moon = planet.moons.find((candidate) => candidate.task_id === taskId);
      if (moon) return moon;
    }
  }
  assert.fail(`snapshot has no moon for ${taskId}`);
}

async function settle(g, taskId) {
  await sendDelivery(g, { taskId, provider: "fake" });
  await sendCustoms(g, { taskId, provider: "fake" });
  assert.equal(dockCargo(g, { taskId }).moonStatus, "merged");
}

test("a moon with no dependencies is not waiting", async () => {
  const w = await world([{ streamId: "P1", moons: [{ taskId: "T1" }] }]);
  try {
    assert.deepEqual(dependencyState(w.g, "T1"), { visited: false, waitingOn: [], waitingOnPlanets: [] });
  } finally { w.cleanup(); }
});

test("a moon waits for an unsettled dependency on the same planet", async () => {
  const w = await world([{ streamId: "P1", moons: [{ taskId: "A" }, { taskId: "B", dependsOn: "A" }] }]);
  try {
    assert.deepEqual(dependencyState(w.g, "B").waitingOn, ["A"]);
  } finally { w.cleanup(); }
});

test("an unassigned dependency is reported by dependency reads", async () => {
  const w = await world([{ streamId: "P1", moons: [{ taskId: "B", dependsOn: "NOPE" }] }]);
  try {
    assert.deepEqual(dependencyState(w.g, "B").waitingOn, ["NOPE"]);
    assert.deepEqual(snapshotMoon(w.g, "B").waiting_on, ["NOPE"]);
    assert.deepEqual(moonDetail(w.g, "B", ctx).moon.waiting_on, ["NOPE"]);
  } finally { w.cleanup(); }
});

test("a dependency settled on the same planet is no longer waiting", async () => {
  const w = await world([{ streamId: "P1", moons: [{ taskId: "A" }, { taskId: "B", dependsOn: "A" }] }]);
  try {
    await settle(w.g, "A");
    assert.deepEqual(dependencyState(w.g, "B").waitingOn, []);
  } finally { w.cleanup(); }
});

test("a dependency settled on another planet is still waiting", async () => {
  const w = await world([
    { streamId: "P1", moons: [{ taskId: "A" }] },
    { streamId: "P2", moons: [{ taskId: "B", dependsOn: "A" }] },
  ]);
  try {
    await settle(w.g, "A");
    assert.deepEqual(dependencyState(w.g, "B").waitingOn, ["A"]);
  } finally { w.cleanup(); }
});

test("a first freighter is not sent while a dependency is unsettled", async () => {
  const w = await world([{ streamId: "P1", moons: [{ taskId: "A" }, { taskId: "B", dependsOn: "A" }] }]);
  try {
    await assert.rejects(sendDelivery(w.g, { taskId: "B" }), /is waiting on A/);
    const moon = w.g.db.get("moons.byTask", { task_id: "B" });
    assert.equal(moon.status, "emitted");
    assert.equal(w.g.db.all("events.byAssignment", { assignment_id: moon.assignment_id }).some((e) => e.kind === "voyage.launched"), false);
  } finally { w.cleanup(); }
});

test("a visited moon is not re-checked before its next freighter is sent", async () => {
  const w = await world([{ streamId: "P1", moons: [{ taskId: "T1", script: "fix-round" }] }]);
  try {
    await sendDelivery(w.g, { taskId: "T1", provider: "fake" });
    await sendCustoms(w.g, { taskId: "T1", provider: "fake", reviewScript: "review-fix" });
    w.g.db.raw.prepare("UPDATE moons SET depends_on = ? WHERE task_id = ?").run('["NOPE"]', "T1");
    assert.deepEqual(dependencyState(w.g, "T1"), { visited: true, waitingOn: ["NOPE"], waitingOnPlanets: [] });
    await assert.doesNotReject(sendDelivery(w.g, { taskId: "T1", provider: "fake" }));
    assert.deepEqual(snapshotMoon(w.g, "T1").waiting_on, []);
  } finally { w.cleanup(); }
});

test("planet dependencies are reported but do not block a freighter", async () => {
  const w = await world([{ streamId: "P1", dependsOn: ["P0"], moons: [{ taskId: "T1" }] }]);
  try {
    assert.deepEqual(dependencyState(w.g, "T1").waitingOnPlanets, ["P0"]);
    assert.deepEqual(snapshotMoon(w.g, "T1").waiting_on_planets, ["P0"]);
    await assert.doesNotReject(sendDelivery(w.g, { taskId: "T1", provider: "fake" }));
  } finally { w.cleanup(); }
});
