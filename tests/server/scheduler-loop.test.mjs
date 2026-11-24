import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { append, rowToEvent } from "../../dist/db/events.js";
import { assignMoon } from "../../dist/server/commands/assign.js";
import { setAutomationLevel } from "../../dist/server/commands/config.js";
import { repliedSincePark } from "../../dist/server/commands/delivery.js";
import { replyMoon } from "../../dist/server/commands/park.js";
import { read, writeSpec } from "../helpers.mjs";
import { startWorld } from "../http/helpers.mjs";

const FAST = { server: { pollMs: 20, schedulerTickMs: 200 } };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${fn}`);
    await sleep(10);
  }
}

const moon = (x, taskId = "T1") => x.w.g.db.get("moons.byTask", { task_id: taskId });
const log = (x) => x.w.g.db.all("events.since", { id: 0 }).map(rowToEvent);
const acted = (x, taskId = "T1") => log(x).filter((e) => e.kind === "scheduler.acted" && e.payload.task_id === taskId).map((e) => e.payload.action);
const post = (x, name, body) => x.api(`/api/commands/${name}`, { method: "POST", body });
const pending = (x, taskId = "T1") => x.w.g.db.all("decisions.pendingByTarget", { target_id: taskId });
const configPath = (x) => path.join(x.w.dir, ".nexus", "config.json");
const specText = (script) => read("tests/fixtures/specs/good-basic.md").replace("# TASK: thing-add-x", `# TASK: thing-add-x\n<!-- FAKE-SCRIPT: ${script} -->`);

test("manual: nothing is ever written by the scheduler", async () => {
  const x = await startWorld("happy", undefined, FAST);
  try {
    await sleep(300);
    assert.deepEqual(log(x).filter((e) => e.kind === "scheduler.acted"), []);
    assert.equal(moon(x).status, "emitted");
  } finally { await x.close(); }
});

test("verdicts: after a human sends a delivery the moon is settled unattended", async () => {
  const x = await startWorld("happy", undefined, FAST);
  try {
    setAutomationLevel(x.w.g, { level: "verdicts" });
    await sleep(300);
    assert.deepEqual(acted(x), [], "no first delivery is sent at verdicts");
    assert.equal((await post(x, "delivery.send", { taskId: "T1" })).status, 202);
    await until(() => moon(x).status === "merged");
    assert.deepEqual(acted(x), ["inspect", "dock"]);
    for (const e of log(x).filter((e) => e.kind === "scheduler.acted")) assert.equal(e.payload.rung, "verdicts");
  } finally { await x.close(); }
});

test("roundabout: a delivery is sent to a ready moon", async () => {
  const x = await startWorld("happy", undefined, FAST);
  try {
    assert.equal((await post(x, "config.automation", { level: "roundabout" })).status, 200);
    await until(() => moon(x).status === "merged");
    assert.deepEqual(acted(x), ["send", "inspect", "dock"]);
    assert.deepEqual(pending(x), []);
  } finally { await x.close(); }
});

test("caps: never more than max_concurrent_ships in flight", async () => {
  const patch = (c) => {
    c.roles = { implement: ["fake"], review: ["fake"] }; c.routing.security_routed = ["src/auth.ts"]; c.routing.do_not_touch = [".env"];
    c.scheduler = { ...(c.scheduler ?? {}), max_concurrent_ships: 1 };
  };
  const x = await startWorld("slow", patch, FAST);
  try {
    const paths = ["T2", "T3"].map((id) => writeSpec(x.w.dir, id, specText("slow")));
    x.w.git("add", "-A"); x.w.git("commit", "-qm", "more specs");
    for (const specPath of paths) assignMoon(x.w.g, { planetId: x.w.planetId, specPath });
    setAutomationLevel(x.w.g, { level: "roundabout" });
    let most = 0;
    const ids = ["T1", "T2", "T3"];
    const resting = new Set(["merged", "adrift", "quarantined"]);
    await until(() => {
      most = Math.max(most, x.w.g.db.all("voyages.inFlight").length);
      return ids.every((id) => resting.has(moon(x, id).status));
    }, 60000);
    assert.equal(most, 1);
    assert.deepEqual(ids.map((id) => moon(x, id).status), ["merged", "merged", "merged"]);
  } finally { await x.close(); }
});

/** A moon whose spec body was edited after assign: every delivery is refused before launch. */
async function refusedWorld() {
  const x = await startWorld("happy", undefined, FAST);
  fs.appendFileSync(path.join(x.w.dir, ".nexus", "specs", "T1.md"), "\nAn edit to the body after assign.\n");
  setAutomationLevel(x.w.g, { level: "roundabout" });
  await until(() => moon(x).status === "adrift");
  return x;
}

test("a refusal twice in a row parks the moon and stops", async () => {
  const x = await refusedWorld();
  try {
    assert.equal(moon(x).park_reason, "scheduler_refused");
    assert.deepEqual(acted(x), ["send", "send"]);
    const decisions = pending(x);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].kind, "adrift");
    assert.match(decisions[0].reasoning, /spec body changed/);
    await sleep(300);
    assert.deepEqual(acted(x), ["send", "send"]);
    assert.equal(pending(x).length, 1);
    assert.deepEqual(log(x).filter((e) => e.kind === "voyage.launched"), []);
  } finally { await x.close(); }
});

test("a replied-to adrift moon that is refused twice is re-parked", async () => {
  const x = await refusedWorld();
  try {
    const first = pending(x)[0].id;
    replyMoon(x.w.g, { taskId: "T1", note: "try again" });
    await until(() => acted(x).length === 4 && pending(x).length === 1);
    assert.notEqual(pending(x)[0].id, first);
    assert.match(pending(x)[0].reasoning, /spec body changed/);
    assert.equal(moon(x).status, "adrift");
    assert.equal(repliedSincePark(x.w.g, moon(x).assignment_id), false);
    await sleep(300);
    assert.equal(acted(x).length, 4);
    assert.equal(pending(x).length, 1);
  } finally { await x.close(); }
});

test("a click racing the scheduler is not a failure", async () => {
  const x = await startWorld("happy", undefined, FAST);
  let release = () => {};
  try {
    const real = x.w.g.adapters.fake;
    const gate = new Promise((resolve) => { release = resolve; });
    x.w.g.adapters.fake = {
      ...real,
      dispatch(job, ctx) {
        if (job.role !== "review") return real.dispatch(job, ctx);
        return (async function* () {
          for await (const event of real.dispatch(job, ctx)) {
            if (event.kind === "done") await gate;
            yield event;
          }
        })();
      },
    };
    setAutomationLevel(x.w.g, { level: "verdicts" });
    assert.equal((await post(x, "delivery.send", { taskId: "T1" })).status, 202);
    await until(() => moon(x).status === "reviewing");
    release();
    await until(async () => { await post(x, "cargo.dock", { taskId: "T1" }); return moon(x).status === "merged"; });
    await sleep(300);
    assert.equal(moon(x).status, "merged");
    assert.equal(log(x).filter((e) => e.kind === "voyage.docked").length, 1);
    assert.deepEqual(log(x).filter((e) => e.kind === "moon.adrift"), []);
    assert.deepEqual(pending(x), []);
  } finally { release(); await x.close(); }
});

test("a rung change from another process is picked up", async () => {
  const x = await startWorld("happy", undefined, FAST);
  try {
    setAutomationLevel(x.w.g, { level: "verdicts" });
    const file = JSON.parse(fs.readFileSync(configPath(x), "utf8"));
    file.automation = { ...file.automation, level: "manual" };
    fs.writeFileSync(configPath(x), JSON.stringify(file, null, 2) + "\n");
    append(x.w.g.db, { kind: "config.changed", payload: { key: "automation.level", from: "verdicts", to: "manual", pid: 0 } });
    await until(() => x.w.g.config.automation.level === "manual");
    assert.equal((await post(x, "delivery.send", { taskId: "T1" })).status, 202);
    await until(() => moon(x).status === "audited");
    await sleep(300);
    assert.deepEqual(log(x).filter((e) => e.kind === "scheduler.acted"), []);
    assert.equal(moon(x).status, "audited");
  } finally { await x.close(); }
});

test("an unreadable config after a foreign change keeps the old one and shows a notice", async () => {
  const x = await startWorld("happy", undefined, FAST);
  try {
    setAutomationLevel(x.w.g, { level: "verdicts" });
    fs.writeFileSync(configPath(x), "{ not json");
    append(x.w.g.db, { kind: "config.changed", payload: { key: "automation.level", from: "verdicts", to: "manual", pid: 0 } });
    const snap = await until(async () => {
      const res = await x.api("/api/snapshot");
      return res.json.failures.some((f) => /could not be reloaded/.test(f.message)) ? res.json : null;
    });
    const notice = snap.failures.find((f) => /could not be reloaded/.test(f.message));
    assert.equal(notice.taskId, "config");
    assert.equal(notice.voyageId, null);
    assert.equal(snap.rung, "verdicts");
    assert.equal((await post(x, "delivery.send", { taskId: "T1" })).status, 202);
    await until(() => moon(x).status === "merged");
  } finally { await x.close(); }
});

test("snapshot reports ready_to_send", async () => {
  const x = await startWorld("happy", undefined, FAST);
  try {
    const before = await x.api("/api/snapshot");
    assert.equal(before.json.rung, "manual");
    assert.equal(before.json.ready_to_send, 1);
    setAutomationLevel(x.w.g, { level: "verdicts" });
    assert.equal((await post(x, "delivery.send", { taskId: "T1" })).status, 202);
    await until(() => moon(x).status === "merged");
    assert.equal((await x.api("/api/snapshot")).json.ready_to_send, 0);
  } finally { await x.close(); }
});

test("stop waits for the pass and leaves voyages alone", async () => {
  const x = await startWorld("slow", undefined, FAST);
  try {
    setAutomationLevel(x.w.g, { level: "roundabout" });
    await until(() => moon(x).status === "implementing");
    await x.srv.close();
    const events = log(x);
    assert.deepEqual(events.filter((e) => e.kind === "voyage.adrift").map((e) => e.payload.reason), ["interrupted"]);
    assert.deepEqual(events.filter((e) => e.kind === "moon.adrift" && String(e.payload.reason).startsWith("scheduler_")), []);
    assert.deepEqual(acted(x), ["send"]);
    const count = events.length;
    await sleep(300);
    assert.equal(log(x).length, count, "a stopped scheduler writes nothing");
  } finally { await x.close(); }
});

// ---- fuel holds (v1 slice 2) ----

/** One provider with a fuel pool, so a low or dry pool cannot be routed around. */
const pooled = (c) => { c.roles = { implement: ["fake"], review: ["fake"] }; c.providers.fake.pool = { kind: "window", reserve_floor: 0.1 }; };
const ahead = (ms) => new Date(Date.now() + ms).toISOString();
const reading = (x, used, resets_at) => append(x.w.g.db, { kind: "fuel.reading", provider: "fake", payload: { window: "window", used, resets_at, source: "reported" } });
const exhausted = (x, until) => append(x.w.g.db, { kind: "fuel.exhausted", provider: "fake", payload: { until, voyage_id: "v" } });
const held = (x, taskId = "T1") => log(x).filter((e) => e.kind === "limiter.held" && e.task_id === taskId);

test("a held delivery writes limiter.held once, not on every pass", async () => {
  const x = await startWorld("happy", pooled, FAST);
  try {
    const resets = ahead(3_600_000);
    reading(x, 0.95, resets);
    setAutomationLevel(x.w.g, { level: "roundabout" });
    await until(() => held(x).length === 1);
    await sleep(700); // three ticks, and every event wakes a pass as well
    const events = held(x);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].payload, { task_id: "T1", role: "implement", provider: "fake", reason: "low", until: resets });
    assert.equal(events[0].moon_id, moon(x).id, "scoped to the moon");
    assert.deepEqual(acted(x), []);
    assert.equal(moon(x).status, "emitted");
  } finally { await x.close(); }
});

test("a hold whose reason or until changes is written again", async () => {
  const x = await startWorld("happy", pooled, FAST);
  try {
    const resets = ahead(3_600_000), until2 = ahead(7_200_000);
    reading(x, 0.95, resets);
    setAutomationLevel(x.w.g, { level: "roundabout" });
    await until(() => held(x).length === 1);
    exhausted(x, until2);
    await until(() => held(x).length === 2);
    await sleep(500);
    assert.deepEqual(held(x).map((e) => [e.payload.reason, e.payload.until]), [["low", resets], ["dry", until2]]);
  } finally { await x.close(); }
});

test("a hold is written again after the moon was visited in between", async () => {
  const x = await startWorld("crash-midrun", pooled, FAST);
  try {
    const resets = ahead(3_600_000);
    reading(x, 0.95, resets);
    setAutomationLevel(x.w.g, { level: "roundabout" });
    await until(() => held(x).length === 1);
    reading(x, 0.1, resets); // the pool is back: the delivery is sent, and its ship breaks down mid-run
    await until(() => moon(x).status === "adrift");
    reading(x, 0.95, resets);
    replyMoon(x.w.g, { taskId: "T1", note: "try again" });
    await until(() => held(x).length === 2);
    await sleep(500);
    const events = held(x);
    assert.equal(events.length, 2);
    assert.deepEqual(events[1].payload, events[0].payload, "the same hold, written again because a delivery flew in between");
    assert.deepEqual(acted(x), ["send"]);
  } finally { await x.close(); }
});

test("a pool that refills is acted on by the tick with no event", async () => {
  const x = await startWorld("happy", pooled, { server: { pollMs: 20, schedulerTickMs: 100 } });
  try {
    exhausted(x, ahead(600));
    setAutomationLevel(x.w.g, { level: "roundabout" });
    await until(() => held(x).length === 1);
    assert.deepEqual(acted(x), [], "held while the pool is dry");
    await until(() => moon(x).status === "merged");
    assert.deepEqual(acted(x), ["send", "inspect", "dock"]);
    assert.equal(held(x).length, 1);
  } finally { await x.close(); }
});

test("holds never count as failures", async () => {
  const x = await startWorld("happy", pooled, { server: { pollMs: 20, schedulerTickMs: 50 } });
  try {
    reading(x, 0.95, ahead(3_600_000));
    setAutomationLevel(x.w.g, { level: "roundabout" });
    await until(() => held(x).length === 1);
    await sleep(600); // a dozen passes
    assert.equal(moon(x).status, "emitted");
    assert.deepEqual(log(x).filter((e) => e.kind === "moon.adrift"), []);
    assert.deepEqual(pending(x), []);
    assert.deepEqual(acted(x), []);
    assert.equal(held(x).length, 1);
  } finally { await x.close(); }
});
