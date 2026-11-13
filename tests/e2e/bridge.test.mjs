import assert from "node:assert/strict";
import { test } from "node:test";
import { rebuild, dumpProjections } from "../../dist/db/rebuild.js";
import { read, writeSpec } from "../helpers.mjs";
import { readFeed, startWorld } from "../http/helpers.mjs";

test("REJECT handled entirely over HTTP while a second moon is in flight", async () => {
  const x = await startWorld("happy", undefined, { server: { pollMs: 20 } });
  let feed;
  let releaseE2 = () => {};
  try {
    const spec = (script) => read("tests/fixtures/specs/good-basic.md")
      .replace("# TASK: thing-add-x", `# TASK: thing-add-x\n<!-- FAKE-SCRIPT: ${script} -->`);
    const e1Path = writeSpec(x.w.dir, "E1", spec("happy"));
    const e2Path = writeSpec(x.w.dir, "E2", spec("slow"));
    x.w.git("add", "-A");
    x.w.git("commit", "-qm", "E1 and E2 specs");

    const firstSnapshot = await x.api("/api/snapshot");
    assert.equal(firstSnapshot.status, 200);
    assert.deepEqual(
      firstSnapshot.json.specs.filter((entry) => entry.taskId === "E1" || entry.taskId === "E2")
        .map(({ taskId, error }) => ({ taskId, error })),
      [{ taskId: "E1", error: null }, { taskId: "E2", error: null }],
    );
    feed = readFeed(x.srv, { since: firstSnapshot.json.cursor });
    assert.equal(await feed.status, 200);

    let rejectedE1 = false;
    const real = x.w.g.adapters.fake;
    const e2Gate = new Promise((resolve) => { releaseE2 = resolve; });
    const holdE2 = async function* (job, ctx) {
      for await (const event of real.dispatch(job, ctx)) {
        if (event.kind === "done") await e2Gate;
        yield event;
      }
    };
    x.w.g.adapters.fake = {
      ...real,
      dispatch(job, ctx) {
        if (!rejectedE1 && job.role === "review" && job.specPath === e1Path) {
          rejectedE1 = true;
          return real.dispatch({ ...job, prompt: `FAKE-SCRIPT: review-reject\n${job.prompt}` }, ctx);
        }
        if (job.role === "implement" && job.specPath === e2Path) return holdE2(job, ctx);
        return real.dispatch(job, ctx);
      },
    };

    const created = await x.api("/api/commands/system.create", {
      method: "POST", body: { slug: "bridge", title: "Bridge", brief: "HTTP bridge lifecycle" },
    });
    assert.equal(created.status, 200);
    const systemId = created.json.result.systemId;
    const assignedPlanet = await x.api("/api/commands/planet.assign", {
      method: "POST", body: { systemId, streamId: "bridge", mission: "Exercise the HTTP bridge", territory: ["src/**"] },
    });
    assert.equal(assignedPlanet.status, 200);
    const planetId = assignedPlanet.json.result.planetId;
    const assignedE1 = await x.api("/api/commands/moon.assign", {
      method: "POST", body: { planetId, specPath: e1Path },
    });
    assert.equal(assignedE1.status, 200);
    const assignedE2 = await x.api("/api/commands/moon.assign", {
      method: "POST", body: { planetId, specPath: e2Path },
    });
    assert.equal(assignedE2.status, 200);

    const assignedSnapshot = await x.api("/api/snapshot");
    assert.equal(assignedSnapshot.status, 200);
    assert.equal(assignedSnapshot.json.specs.some((entry) => entry.taskId === "E1" || entry.taskId === "E2"), false);
    const bridgeSystem = assignedSnapshot.json.systems.find((system) => system.id === systemId);
    const bridgePlanet = bridgeSystem.planets.find((planet) => planet.id === planetId);
    assert.deepEqual(bridgePlanet.moons.filter((moon) => moon.task_id === "E1" || moon.task_id === "E2").map((moon) => moon.task_id), ["E1", "E2"]);

    const e2Launch = await x.api("/api/commands/moon.launch", { method: "POST", body: { taskId: "E2" } });
    assert.equal(e2Launch.status, 202);
    const e1Launch = await x.api("/api/commands/moon.launch", { method: "POST", body: { taskId: "E1" } });
    assert.equal(e1Launch.status, 202);
    const e2InFlight = await x.api("/api/moons/E2");
    assert.equal(e2InFlight.status, 200);
    assert.equal(e2InFlight.json.voyages.some((voyage) => voyage.owner === "server"), true);
    releaseE2();

    await feed.waitFor((events) => events.some((event) => event.kind === "voyage.audited" && event.task_id === "E1"));
    let e1 = await x.api("/api/moons/E1");
    assert.deepEqual(e1.json.actions, ["inspect"]);
    const firstInspect = await x.api("/api/commands/voyage.inspect", { method: "POST", body: { taskId: "E1" } });
    assert.equal(firstInspect.status, 202);

    await feed.waitFor((events) => events.some((event) => event.kind === "verdict.issued" && event.task_id === "E1"));
    const rejectedSnapshot = await x.api("/api/snapshot");
    assert.deepEqual(rejectedSnapshot.json.decisions.map(({ kind, target_id }) => ({ kind, target_id })), [{ kind: "reject", target_id: "E1" }]);
    e1 = await x.api("/api/moons/E1");
    assert.deepEqual(e1.json.actions, ["reply", "drop"]);
    assert.deepEqual(e1.json.verdicts.map((verdict) => verdict.verdict), ["REJECT"]);

    const reply = await x.api("/api/commands/moon.reply", {
      method: "POST", body: { taskId: "E1", note: "it is fine, re-run" },
    });
    assert.equal(reply.status, 200);
    e1 = await x.api("/api/moons/E1");
    assert.deepEqual(e1.json.actions, ["reply", "drop", "launch"]);

    const repliedSnapshot = await x.api("/api/snapshot");
    assert.equal(repliedSnapshot.json.decisions.some((decision) => decision.kind === "main_tree_changed" && (decision.target_id === "E2" || decision.target_id === "T1")), false);

    const secondLaunch = await x.api("/api/commands/moon.launch", { method: "POST", body: { taskId: "E1" } });
    assert.equal(secondLaunch.status, 202);
    await feed.waitFor((events) => events.filter((event) => event.kind === "voyage.audited" && event.task_id === "E1").length === 2);
    const secondInspect = await x.api("/api/commands/voyage.inspect", { method: "POST", body: { taskId: "E1" } });
    assert.equal(secondInspect.status, 202);
    await feed.waitFor((events) => events.filter((event) => event.kind === "verdict.issued" && event.task_id === "E1").length === 2);
    e1 = await x.api("/api/moons/E1");
    assert.deepEqual(e1.json.actions, ["dock"]);

    const dock = await x.api("/api/commands/voyage.dock", { method: "POST", body: { taskId: "E1" } });
    assert.equal(dock.status, 200);
    assert.equal(dock.json.result.moonStatus, "merged");
    const duplicateDock = await x.api("/api/commands/voyage.dock", { method: "POST", body: { taskId: "E1" } });
    assert.equal(duplicateDock.status, 409);

    await feed.waitFor((events) => events.some((event) => event.kind === "voyage.audited" && event.task_id === "E2"));
    const e2 = await x.api("/api/moons/E2");
    assert.equal(e2.json.moon.status, "audited");
    assert.deepEqual(e2.json.actions, ["inspect"]);

    const finalSnapshot = await x.api("/api/snapshot");
    await feed.waitFor((events) => events.at(-1)?.id >= finalSnapshot.json.cursor);
    const expectedIds = Array.from(
      { length: finalSnapshot.json.cursor - firstSnapshot.json.cursor },
      (_, index) => firstSnapshot.json.cursor + index + 1,
    );
    assert.deepEqual(feed.events.map((event) => event.id), expectedIds);

    feed.close();
    await x.srv.close();
    const before = dumpProjections(x.w.g.db);
    rebuild(x.w.g.db);
    assert.equal(dumpProjections(x.w.g.db), before, "rebuild byte-equal");
    assert.equal(x.w.git("status", "--porcelain"), ` M ${e1Path}`);
    assert.deepEqual(x.w.g.db.all("voyages.inFlight"), []);
  } finally {
    releaseE2();
    feed?.close();
    await x.close();
  }
});
