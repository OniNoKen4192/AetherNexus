import { test } from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs"; import path from "node:path";
import { worldWithMoon, worldWithTwoMoons } from "../fixtures/world.mjs";
import { launchMoon } from "../../dist/server/commands/launch.js"; import { inspectMoon } from "../../dist/server/commands/review.js"; import { dockMoon } from "../../dist/server/commands/dock.js";
import { replyMoon, dropMoon } from "../../dist/server/commands/park.js";
import { answerDecision, pendingTreeDecision } from "../../dist/server/commands/decision.js";
import { loadMoon, parkVoyage, recordTreeWrite } from "../../dist/server/dispatch.js"; import { rebuild, dumpProjections } from "../../dist/db/rebuild.js";

const doneImpl = () => ({ kind: "done", ts: new Date().toISOString(), data: { report: { status: "IMPLEMENTED", raw: "STATUS: IMPLEMENTED" } } });
/** A stub adapter: `body(job, ctx)` runs inside dispatch; it yields done unless it returns false. */
const stub = (body) => ({ id: "fake", roles: ["implement", "review"], classify: () => "unknown", fuel: async () => ({ source: "unknown" }),
  async *dispatch(job, ctx) { if ((await body(job, ctx)) !== false) yield doneImpl(); } });
/** The scripted fake adapter, with `cb` run first on every dispatch of `role`. */
function hook(w, role, cb) {
  const real = w.g.adapters.fake;
  w.g.adapters.fake = { ...real, dispatch: (job, ctx) => { if (job.role === role) cb(); return real.dispatch(job, ctx); } };
}
const stray = (w, name = "stray.txt") => fs.writeFileSync(path.join(w.dir, name), "x\n");
const settle = (w) => { const before = dumpProjections(w.g.db); rebuild(w.g.db); assert.equal(dumpProjections(w.g.db), before, "rebuild is byte-equal"); w.cleanup(); };

test("a foreign change opens the question and the voyage carries on", async () => {
  const w = await worldWithMoon("happy");
  w.g.adapters.fake = stub(() => stray(w));
  const r = await launchMoon(w.g, { taskId: "T1" });
  assert.equal(r.moonStatus, "audited"); assert.equal(r.audit.verdict, "clean");
  const d = w.g.db.all("decisions.pending"); assert.equal(d.length, 1); assert.equal(d[0].kind, "main_tree_changed");
  const why = JSON.parse(d[0].reasoning); assert.deepEqual(why.appeared, ["stray.txt"]); assert.deepEqual(why.vanished, []); assert.equal(why.voyage_id, r.voyageId);
  assert.equal(w.g.db.get("voyages.byId", { id: r.voyageId }).status, "holding");
  settle(w);
});

test("while the question is pending, inspect, dock, launch and reply refuse; drop is allowed", async () => {
  // The voyage ends without a result: the moon is parked and the question is pending alongside the park decision.
  const w = await worldWithMoon("happy"); w.g.adapters.fake = stub(() => { stray(w); return false; });
  assert.equal((await launchMoon(w.g, { taskId: "T1" })).moonStatus, "adrift"); const id = pendingTreeDecision(w.g, "T1").id;
  const re = new RegExp(`unanswered main-tree question \\(decision ${id}\\)`);
  await assert.rejects(inspectMoon(w.g, { taskId: "T1" }), re);
  assert.throws(() => dockMoon(w.g, { taskId: "T1" }), re);
  await assert.rejects(launchMoon(w.g, { taskId: "T1" }), re);
  assert.throws(() => replyMoon(w.g, { taskId: "T1", note: "n" }), re);
  assert.equal(w.g.db.all("decisions.pending").length, 2, "refusals changed nothing");
  dropMoon(w.g, { taskId: "T1" });
  const row = w.g.db.get("decisions.byId", { id }); assert.equal(row.status, "resolved"); assert.equal(row.outcome, "drop");
  assert.equal(w.g.db.all("decisions.pending").length, 0);
  settle(w);
});

test("an audited moon with a pending question refuses all four, and drop refuses by moon state as before", async () => {
  const w = await worldWithMoon("happy"); w.g.adapters.fake = stub(() => stray(w));
  await launchMoon(w.g, { taskId: "T1" }); const id = pendingTreeDecision(w.g, "T1").id;
  const re = new RegExp(`unanswered main-tree question \\(decision ${id}\\)`);
  await assert.rejects(inspectMoon(w.g, { taskId: "T1" }), re);
  assert.throws(() => dockMoon(w.g, { taskId: "T1" }), re);
  await assert.rejects(launchMoon(w.g, { taskId: "T1" }), re);
  assert.throws(() => replyMoon(w.g, { taskId: "T1", note: "n" }), re);
  assert.throws(() => dropMoon(w.g, { taskId: "T1" }), /only an adrift or quarantined moon/);
  settle(w);
});

test("'mine' resolves and unblocks: inspect then dock merge", async () => {
  const w = await worldWithMoon("happy"); const real = w.g.adapters.fake; w.g.adapters.fake = stub(() => stray(w));
  await launchMoon(w.g, { taskId: "T1" }); const id = pendingTreeDecision(w.g, "T1").id; w.g.adapters.fake = real;
  assert.deepEqual(answerDecision(w.g, { decisionId: id, answer: "mine" }), { moonStatus: "audited", parked: false });
  assert.equal(w.g.db.get("decisions.byId", { id }).outcome, "mine");
  assert.equal((await inspectMoon(w.g, { taskId: "T1" })).moonStatus, "reviewing");
  assert.equal(dockMoon(w.g, { taskId: "T1" }).moonStatus, "merged");
  settle(w);
});

test("'not_mine' on a holding freighter parks as main_tree_modified", async () => {
  const w = await worldWithMoon("happy"); w.g.adapters.fake = stub(() => stray(w));
  const r = await launchMoon(w.g, { taskId: "T1" }); const d = pendingTreeDecision(w.g, "T1");
  assert.deepEqual(answerDecision(w.g, { decisionId: d.id, answer: "not_mine" }), { moonStatus: "adrift", parked: true });
  const v = w.g.db.get("voyages.byId", { id: r.voyageId });
  assert.equal(v.status, "adrift"); assert.equal(loadMoon(w.g, "T1").park_reason, "main_tree_modified");
  const pending = w.g.db.all("decisions.pending"); assert.equal(pending.length, 1); assert.equal(pending[0].kind, "adrift");
  assert.match(JSON.parse(v.report).adrift.details, /stray\.txt/);
  assert.equal(w.g.db.get("ships.byId", { id: v.ship_id }).status, "adrift");
  const kinds = w.g.db.all("events.byTask", { task_id: "T1" }).map((e) => e.kind); assert.ok(kinds.lastIndexOf("decision.resolved") > kinds.lastIndexOf("moon.adrift"), "the park is logged before the resolve");
  settle(w);
});

test("'not_mine' after an APPROVE (question raised by the review voyage) parks the cleared freighter", async () => {
  const w = await worldWithMoon("happy"); await launchMoon(w.g, { taskId: "T1" });
  hook(w, "review", () => stray(w));
  const r = await inspectMoon(w.g, { taskId: "T1" }); assert.equal(r.moonStatus, "reviewing");
  const d = pendingTreeDecision(w.g, "T1"); assert.ok(d);
  const impl = w.g.db.get("voyages.latestByAssignmentRole", { assignment_id: loadMoon(w.g, "T1").assignment_id, role: "implement" }); assert.equal(impl.status, "cleared");
  assert.deepEqual(answerDecision(w.g, { decisionId: d.id, answer: "not_mine" }), { moonStatus: "adrift", parked: true });
  assert.equal(w.g.db.get("voyages.byId", { id: impl.id }).status, "adrift"); assert.equal(loadMoon(w.g, "T1").park_reason, "main_tree_modified");
  settle(w);
});

test("'not_mine' after a REJECT resolves only", async () => {
  const w = await worldWithMoon("happy"); await launchMoon(w.g, { taskId: "T1" });
  hook(w, "review", () => stray(w));
  assert.equal((await inspectMoon(w.g, { taskId: "T1", reviewScript: "review-reject" })).moonStatus, "quarantined");
  const d = pendingTreeDecision(w.g, "T1");
  assert.deepEqual(answerDecision(w.g, { decisionId: d.id, answer: "not_mine" }), { moonStatus: "quarantined", parked: false });
  assert.equal(loadMoon(w.g, "T1").status, "quarantined");
  assert.deepEqual(w.g.db.all("decisions.pending").map((x) => x.kind), ["reject"]);
  settle(w);
});

test("'not_mine' after a FIX parks the moon directly", async () => {
  const w = await worldWithMoon("happy"); await launchMoon(w.g, { taskId: "T1" });
  hook(w, "review", () => stray(w));
  assert.equal((await inspectMoon(w.g, { taskId: "T1", reviewScript: "review-fix" })).moonStatus, "audited");
  const d = pendingTreeDecision(w.g, "T1");
  assert.deepEqual(answerDecision(w.g, { decisionId: d.id, answer: "not_mine" }), { moonStatus: "adrift", parked: true });
  assert.equal(loadMoon(w.g, "T1").park_reason, "main_tree_modified");
  assert.ok(!w.g.db.all("voyages.byTask", { task_id: "T1" }).some((v) => v.status === "adrift"), "no voyage went adrift");
  assert.deepEqual(w.g.db.all("decisions.pending").map((x) => x.kind), ["adrift"]);
  settle(w);
});

test("a reply to another moon during a voyage does not raise the question", async () => {
  const w = await worldWithTwoMoons("happy", "happy");
  await launchMoon(w.g, { taskId: "T2" });
  assert.equal((await inspectMoon(w.g, { taskId: "T2", reviewScript: "review-reject" })).moonStatus, "quarantined");
  w.g.adapters.fake = stub(() => { replyMoon(w.g, { taskId: "T2", note: "try again" }); });
  const r = await launchMoon(w.g, { taskId: "T1" });
  assert.equal(r.moonStatus, "audited");
  assert.equal(w.g.db.all("decisions.pending").filter((d) => d.kind === "main_tree_changed").length, 0);
  assert.match(w.git("status", "--porcelain"), /T2\.md/, "the reply did change the spec in the main tree");
  settle(w);
});

test("a commit on the working branch during a voyage raises the question", async () => {
  const w = await worldWithMoon("happy");
  w.g.adapters.fake = stub(() => { fs.writeFileSync(path.join(w.dir, "README.md"), "# changed\n"); w.git("commit", "-qam", "human commit"); });
  assert.equal((await launchMoon(w.g, { taskId: "T1" })).moonStatus, "audited");
  const why = JSON.parse(pendingTreeDecision(w.g, "T1").reasoning); assert.notEqual(why.head_before, why.head_after);
  settle(w);
});

test("answering twice refuses; so does a missing decision", async () => {
  const w = await worldWithMoon("happy"); w.g.adapters.fake = stub(() => stray(w));
  await launchMoon(w.g, { taskId: "T1" }); const d = pendingTreeDecision(w.g, "T1");
  answerDecision(w.g, { decisionId: d.id, answer: "mine" });
  assert.throws(() => answerDecision(w.g, { decisionId: d.id, answer: "mine" }), /only a pending decision/);
  assert.throws(() => answerDecision(w.g, { decisionId: 9999, answer: "mine" }), /no decision 9999/);
  settle(w);
});

test("a decision that is not a main-tree question cannot be answered", async () => {
  const w = await worldWithMoon("scope-violation"); await launchMoon(w.g, { taskId: "T1" });
  const d = w.g.db.all("decisions.pending")[0]; assert.notEqual(d.kind, "main_tree_changed");
  assert.throws(() => answerDecision(w.g, { decisionId: d.id, answer: "mine" }), new RegExp(`decision ${d.id} is a '${d.kind}' decision — use reply or drop`));
  settle(w);
});

test("a crash between the park and the resolve heals: the second answer only resolves", async () => {
  const w = await worldWithMoon("happy"); w.g.adapters.fake = stub(() => stray(w));
  const r = await launchMoon(w.g, { taskId: "T1" }); const d = pendingTreeDecision(w.g, "T1");
  // The state a crash leaves: the park sequence ran, the final decision.resolved did not.
  const v = w.g.db.get("voyages.byId", { id: r.voyageId });
  parkVoyage(w.g, { taskId: "T1", voyageId: v.id, shipId: v.ship_id, reason: "main_tree_modified", details: d.reasoning });
  assert.equal(loadMoon(w.g, "T1").status, "adrift"); assert.ok(pendingTreeDecision(w.g, "T1"), "question still pending");
  assert.deepEqual(answerDecision(w.g, { decisionId: d.id, answer: "not_mine" }), { moonStatus: "adrift", parked: false });
  assert.equal(w.g.db.get("decisions.byId", { id: d.id }).outcome, "not_mine");
  assert.deepEqual(w.g.db.all("decisions.pending").map((x) => x.kind), ["adrift"], "parked once");
  assert.equal(w.g.db.all("events.byTask", { task_id: "T1" }).filter((e) => e.kind === "moon.adrift").length, 1);
  settle(w);
});

test("an exempt path and a stray in one voyage: only the stray is asked about; an earlier tree.written exempts nothing", async () => {
  const w = await worldWithMoon("happy");
  recordTreeWrite(w.g, ["stray.txt"]); // before the voyage launches: no exemption
  w.g.adapters.fake = stub(() => { recordTreeWrite(w.g, ["exempt.txt"]); fs.writeFileSync(path.join(w.dir, "exempt.txt"), "x\n"); stray(w); });
  assert.equal((await launchMoon(w.g, { taskId: "T1" })).moonStatus, "audited");
  assert.deepEqual(JSON.parse(pendingTreeDecision(w.g, "T1").reasoning).appeared, ["stray.txt"]);
  settle(w);
});

test("a FIX verdict on one moon during a voyage on another raises no question on the other", async () => {
  const w = await worldWithTwoMoons("happy", "happy");
  const real = w.g.adapters.fake;
  await launchMoon(w.g, { taskId: "T2" });
  const flying = stub(async () => {
    w.g.adapters.fake = real;
    assert.equal((await inspectMoon(w.g, { taskId: "T2", reviewScript: "review-fix" })).moonStatus, "audited");
    w.g.adapters.fake = flying;
  });
  w.g.adapters.fake = flying;
  assert.equal((await launchMoon(w.g, { taskId: "T1" })).moonStatus, "audited");
  assert.equal(w.g.db.all("decisions.pending").filter((x) => x.kind === "main_tree_changed").length, 0);
  assert.match(w.git("status", "--porcelain"), /T2\.md/, "the FIX amendment did change the spec in the main tree");
  settle(w);
});

test("the system's own write that puts a file back as committed during a voyage raises no question", async () => {
  const { setAutomationLevel } = await import("../../dist/server/commands/config.js");
  const w = await worldWithMoon("happy");
  setAutomationLevel(w.g, { level: "roundabout" }); // before the voyage: .nexus/config.json now differs from the commit
  assert.match(w.git("status", "--porcelain"), /\.nexus\/config\.json/);
  w.g.adapters.fake = stub(() => { setAutomationLevel(w.g, { level: "manual" }); });
  assert.equal((await launchMoon(w.g, { taskId: "T1" })).moonStatus, "audited");
  assert.doesNotMatch(w.git("status", "--porcelain"), /\.nexus\/config\.json/, "the file is back as committed");
  assert.deepEqual(w.g.db.all("decisions.pending"), []);
  settle(w);
});

test("a foreign change that disappears during a voyage still raises the question", async () => {
  const w = await worldWithMoon("happy");
  stray(w); // before the voyage
  w.g.adapters.fake = stub(() => { fs.rmSync(path.join(w.dir, "stray.txt")); });
  assert.equal((await launchMoon(w.g, { taskId: "T1" })).moonStatus, "audited");
  const why = JSON.parse(pendingTreeDecision(w.g, "T1").reasoning);
  assert.deepEqual(why.vanished, ["stray.txt"]); assert.deepEqual(why.appeared, []);
  settle(w);
});
