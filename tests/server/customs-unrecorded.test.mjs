// A customs voyage's return and its verdict are two writes. A process that dies between them leaves the moon `reviewing`
// with the verdict only in the voyage's report. That verdict is recorded from the report, without another flight.
// Every galaxy here pins its roles to fake providers.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { worldWithMoon, idleShip } from "../fixtures/world.mjs";
import { repoRoot } from "../helpers.mjs";
import { runCommand } from "../../dist/server/http/commands.js";
import { append, rowToEvent } from "../../dist/db/events.js";
import { rebuild, dumpProjections } from "../../dist/db/rebuild.js";
import { sendDelivery } from "../../dist/server/commands/delivery.js";
import { sendCustoms, recordVerdict } from "../../dist/server/commands/customs.js";
import { availableActions, moonDetail } from "../../dist/server/commands/query.js";
import { loadMoon, moonScope } from "../../dist/server/dispatch.js";
import { planWithHolds } from "../../dist/server/scheduler/plan.js";

const iso = (ms = 0) => new Date(Date.now() + ms).toISOString();
const pin = (extra) => (c) => { c.roles = { implement: ["fake"], review: ["fake"] }; extra?.(c); };
const ctx = { ownPid: process.pid };
const log = (g) => g.db.raw.prepare("SELECT * FROM events ORDER BY id").all().map(rowToEvent);
const voyage = (g, id) => g.db.get("voyages.byId", { id });
function stable(g) { const before = dumpProjections(g.db); rebuild(g.db); assert.equal(dumpProjections(g.db), before); }

/** T1 delivered and audited, then a customs voyage that returned with `report` and no verdict after it: what the crash leaves. */
async function returnedWithoutVerdict(w, report) {
  const delivery = await sendDelivery(w.g, { taskId: "T1" });
  const scope = moonScope(w.g, loadMoon(w.g, "T1"));
  const ship = idleShip(w.g.db, "fake", "customs");
  const voyageId = `${ship.id}/T1/review/1`;
  append(w.g.db, { kind: "voyage.launched", ...scope, voyage_id: voyageId, ship_id: ship.id, provider: "fake", payload: { role: "review", round: 1, provider: "fake", ship_id: ship.id, worktree: "w", owner_pid: 2147483646 } });
  append(w.g.db, { kind: "voyage.returned", ...scope, voyage_id: voyageId, ship_id: ship.id, payload: { role: "review", report } });
  append(w.g.db, { kind: "ship.released", ...scope, voyage_id: voyageId, ship_id: ship.id, payload: { voyage_id: voyageId, outcome: "docked" } });
  assert.deepEqual([loadMoon(w.g, "T1").status, voyage(w.g, voyageId).status], ["reviewing", "docked"]);
  return { deliveryId: delivery.voyageId, voyageId };
}

test("APPROVE left unrecorded: recording the verdict is offered and done without another flight; the moon can dock", async () => {
  const w = await worldWithMoon("happy", pin());
  try {
    const { deliveryId, voyageId } = await returnedWithoutVerdict(w, { verdict: "APPROVE", reasoning: "ok" });
    assert.deepEqual(availableActions(w.g, "T1", ctx), ["record_verdict"]);
    const launches = log(w.g).filter((e) => e.kind === "voyage.launched").length;
    await assert.rejects(sendCustoms(w.g, { taskId: "T1" }), /its verdict is waiting to be recorded; run 'nexus verdict record'/);
    const r = recordVerdict(w.g, { taskId: "T1" });
    assert.deepEqual([r.voyageId, r.verdict.verdict, r.moonStatus], [voyageId, "APPROVE", "reviewing"]);
    assert.equal(log(w.g).filter((e) => e.kind === "voyage.launched").length, launches, "no second customs voyage");
    const issued = log(w.g).filter((e) => e.kind === "verdict.issued");
    assert.equal(issued.length, 1); assert.equal(issued[0].voyage_id, voyageId);
    assert.equal(log(w.g).find((e) => e.id === issued[0].id + 1).kind, "voyage.cleared", "the verdict and what it does to the delivery are one step");
    assert.equal(voyage(w.g, deliveryId).status, "cleared");
    assert.deepEqual(availableActions(w.g, "T1", ctx), ["dock"]);
    await assert.rejects(sendCustoms(w.g, { taskId: "T1" }), /only an 'audited' moon/);
    assert.throws(() => recordVerdict(w.g, { taskId: "T1" }), /no customs verdict is waiting to be recorded/);
    assert.equal(log(w.g).filter((e) => e.kind === "verdict.issued").length, 1);
    stable(w.g);
  } finally { w.cleanup(); }
});

test("FIX left unrecorded: the delivery is superseded, its ship freed, the spec amended, and the next delivery can be sent", async () => {
  const w = await worldWithMoon("fix-round", pin());
  try {
    const { deliveryId } = await returnedWithoutVerdict(w, { verdict: "FIX", reasoning: "thing is 1", delta_spec: "Set thing = 2 in src/lib/thing.js" });
    const r = recordVerdict(w.g, { taskId: "T1" });
    assert.deepEqual([r.verdict.verdict, r.moonStatus], ["FIX", "audited"]);
    assert.equal(voyage(w.g, deliveryId).status, "superseded");
    assert.equal(w.g.db.get("ships.byId", { id: voyage(w.g, deliveryId).ship_id }).status, "idle");
    assert.match(fs.readFileSync(path.join(w.dir, ".nexus", "specs", "T1.md"), "utf8"), /^ {4}Set thing = 2 in src\/lib\/thing\.js/m);
    assert.equal(log(w.g).filter((e) => e.kind === "moon.amended").length, 1);
    assert.deepEqual(availableActions(w.g, "T1", ctx), ["send"]);
    stable(w.g);
  } finally { w.cleanup(); }
});

test("REJECT left unrecorded: the moon is quarantined and the decision is opened", async () => {
  const w = await worldWithMoon("happy", pin());
  try {
    const { deliveryId } = await returnedWithoutVerdict(w, { verdict: "REJECT", reasoning: "wrong task" });
    const r = recordVerdict(w.g, { taskId: "T1" });
    assert.equal(r.moonStatus, "quarantined");
    assert.equal(voyage(w.g, deliveryId).status, "quarantined");
    assert.deepEqual(w.g.db.all("decisions.pending").map((d) => d.kind), ["reject"]);
    stable(w.g);
  } finally { w.cleanup(); }
});

test("recording a stored verdict needs no ship: a dry pool does not hold it, and the scheduler does it at verdicts", async () => {
  const w = await worldWithMoon("happy", pin((c) => { c.providers.fake.pool = { kind: "window", reserve_floor: 0.1 }; }));
  try {
    await returnedWithoutVerdict(w, { verdict: "APPROVE", reasoning: "ok" });
    append(w.g.db, { kind: "fuel.exhausted", provider: "fake", payload: { until: iso(3_600_000), voyage_id: "prior" } });
    assert.equal(moonDetail(w.g, "T1", ctx).moon.waiting_on_fuel, null);
    assert.deepEqual(planWithHolds(w.g, { ...ctx, rung: "verdicts" }), { actions: [{ action: "record_verdict", taskId: "T1", first: false }], holds: [] });
    assert.deepEqual(planWithHolds(w.g, { ...ctx, rung: "manual" }), { actions: [], holds: [] });
    assert.equal(recordVerdict(w.g, { taskId: "T1" }).verdict.verdict, "APPROVE");
  } finally { w.cleanup(); }
});

test("a FIX at the round cap and its park are one step: a write that fails in the middle leaves no verdict, and recording it later needs no flight", async () => {
  const w = await worldWithMoon("fix-round", pin((c) => { c.automation = { level: "manual", max_fix_rounds: 1 }; }));
  try {
    await sendDelivery(w.g, { taskId: "T1" });
    // The process dies while the park is being written: the first park event never lands.
    const restore = dieAt(w, "voyage.adrift");
    await assert.rejects(sendCustoms(w.g, { taskId: "T1", reviewScript: "review-fix" }), /the process died here/);
    restore();
    assert.equal(log(w.g).filter((e) => e.kind === "verdict.issued").length, 0, "no verdict without its park");
    assert.equal(loadMoon(w.g, "T1").status, "reviewing");
    assert.deepEqual(availableActions(w.g, "T1", ctx), ["record_verdict"]);
    const launches = log(w.g).filter((e) => e.kind === "voyage.launched").length;
    const r = recordVerdict(w.g, { taskId: "T1" });
    assert.deepEqual([r.verdict.verdict, r.moonStatus, loadMoon(w.g, "T1").park_reason], ["FIX", "adrift", "max_fix_rounds"]);
    assert.equal(log(w.g).filter((e) => e.kind === "voyage.launched").length, launches, "customs does not fly again");
    const issued = log(w.g).find((e) => e.kind === "verdict.issued");
    assert.deepEqual(log(w.g).filter((e) => e.id > issued.id && e.id <= issued.id + 4).map((e) => e.kind), ["voyage.adrift", "ship.adrift", "moon.adrift", "decision.opened"]);
    assert.equal(w.g.db.all("decisions.pending").length, 1);
    stable(w.g);
  } finally { w.cleanup(); }
});

test("the Bridge command `verdict.record` and `nexus verdict record` record the stored verdict", async () => {
  const w = await worldWithMoon("happy", pin());
  try {
    await returnedWithoutVerdict(w, { verdict: "APPROVE", reasoning: "ok" });
    const answer = await runCommand(w.g, {}, "verdict.record", { taskId: "T1" });
    assert.deepEqual([answer.status, answer.body.result.verdict.verdict, answer.body.result.moonStatus], [200, "APPROVE", "reviewing"]);
    await assert.rejects(runCommand(w.g, {}, "verdict.record", { taskId: "T1", provider: "fake" }), /unexpected field 'provider'/);
  } finally { w.cleanup(); }

  const c = await worldWithMoon("happy", pin());
  try {
    const { voyageId } = await returnedWithoutVerdict(c, { verdict: "APPROVE", reasoning: "ok" });
    const cli = (...args) => execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(repoRoot, "dist", "cli", "main.js"), ...args], { cwd: c.dir, encoding: "utf8" });
    assert.equal(cli("verdict", "record", "T1").trim(), `recorded verdict APPROVE from voyage ${voyageId}: moon reviewing`);
    assert.throws(() => cli("verdict", "record", "T1"), /no customs verdict is waiting to be recorded/);
  } finally { c.cleanup(); }
});

/** The next write of an event of this kind throws, as if the process died there. Returns the function that puts the real write back. */
function dieAt(w, kind) {
  const run = w.g.db.run.bind(w.g.db); let failed = false;
  w.g.db.run = (name, params) => {
    if (name === "events.insert" && params.kind === kind && !failed) { failed = true; throw new Error("the process died here"); }
    return run(name, params);
  };
  return () => { w.g.db.run = run; };
}
const customsEntries = (file) => (fs.readFileSync(file, "utf8").match(/^### A\d+ .* customs: /gm) ?? []).length;

for (const [kind, where] of [["tree.written", "before the spec was amended"], ["moon.amended", "after the spec was amended, before that was logged"]]) {
  test(`a FIX recorded by a process that died ${where}: the next delivery amends the spec once and carries it`, async () => {
    const w = await worldWithMoon("fix-round", pin());
    try {
      const specPath = path.join(w.dir, ".nexus", "specs", "T1.md");
      await sendDelivery(w.g, { taskId: "T1" });
      const restore = dieAt(w, kind);
      await assert.rejects(sendCustoms(w.g, { taskId: "T1", reviewScript: "review-fix" }), /the process died here/);
      restore();
      assert.equal(loadMoon(w.g, "T1").status, "audited");
      assert.equal(log(w.g).filter((e) => e.kind === "moon.amended").length, 0);
      assert.equal(customsEntries(specPath), kind === "tree.written" ? 0 : 1);

      const jobs = []; const real = w.g.adapters.fake;
      w.g.adapters.fake = { ...real, dispatch: (job, c) => { jobs.push(job); return real.dispatch(job, c); } };
      assert.equal((await sendDelivery(w.g, { taskId: "T1" })).moonStatus, "audited");
      assert.equal(customsEntries(specPath), 1, "amended once, not twice");
      assert.match(fs.readFileSync(specPath, "utf8"), /^ {4}Set thing = 2 in src\/lib\/thing\.js/m);
      assert.equal(fs.readFileSync(path.join(w.dir, ".nexus", "worktrees", "T1", ".nexus", "specs", "T1.md"), "utf8"), fs.readFileSync(specPath, "utf8"));
      assert.match(jobs[0].specText, /^### A1 .* customs: /m, "the delivery flies with the amended spec");
      const amended = log(w.g).filter((e) => e.kind === "moon.amended");
      assert.equal(amended.length, 1);
      assert.equal(amended[0].payload.for_verdict, log(w.g).find((e) => e.kind === "verdict.issued").id);
      // nothing more is owed: customs approves round 2 and no further amendment is written
      assert.equal((await sendCustoms(w.g, { taskId: "T1" })).verdict.verdict, "APPROVE");
      assert.equal(customsEntries(specPath), 1);
      stable(w.g);
    } finally { w.cleanup(); }
  });
}

test("a reviewing moon whose customs voyage is still out, or whose verdict is recorded, is not offered a verdict to record", async () => {
  const w = await worldWithMoon("happy", pin());
  try {
    await sendDelivery(w.g, { taskId: "T1" });
    await sendCustoms(w.g, { taskId: "T1" });
    assert.deepEqual(availableActions(w.g, "T1", ctx), ["dock"]);
  } finally { w.cleanup(); }
});
