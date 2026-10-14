import { test } from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { writeSpec, read } from "../helpers.mjs"; import { worldWithMoon } from "../fixtures/world.mjs";
import { assignMoon } from "../../dist/server/commands/assign.js";
import { launchMoon } from "../../dist/server/commands/launch.js";
import { renderPrompt } from "../../dist/server/dispatch.js";

test("happy launch: gate → voyage events logged → audit clean → moon audited, freighter holding", async () => {
  const w = await worldWithMoon("happy"); const seen = [];
  const r = await launchMoon(w.g, { taskId: "T1", provider: "fake", onEvent: (e) => seen.push(e.kind) });
  assert.equal(r.moonStatus, "audited"); assert.equal(r.audit.verdict, "clean"); assert.deepEqual(r.audit.in_scope.sort(), ["src/lib/thing.js", "src/lib/thing.test.js"]);
  assert.deepEqual(seen, ["text", "tool_use", "file_changed", "file_changed", "usage", "done"]);
  const v = w.g.db.get("voyages.byId", { id: r.voyageId }); assert.equal(v.status, "holding"); assert.equal(v.role, "implement");
  assert.equal(w.g.db.all("events.byMoon", { moon_id: w.moonId }).filter((e) => e.kind === "voyage.event").length, 6);
  assert.ok(fs.existsSync(path.join(w.dir, ".nexus", "worktrees", "T1", "src", "lib", "thing.test.js")));
  assert.equal(w.git("status", "--porcelain"), "", "main tree untouched");
  const ship = w.g.db.get("ships.byId", { id: v.ship_id }); assert.equal(ship.status, "assigned");
  w.cleanup();
});

test("Review Focus #5: scope violation with IMPLEMENTED report → audit decides → adrift with out_of_scope", async () => {
  const w = await worldWithMoon("scope-violation"); const r = await launchMoon(w.g, { taskId: "T1", provider: "fake" });
  assert.equal(r.moonStatus, "adrift"); assert.deepEqual(r.audit.out_of_scope, ["README.md"]);
  const m = w.g.db.get("moons.byTask", { task_id: "T1" }); assert.equal(m.park_reason, "audit_violations");
  assert.equal(w.g.db.all("decisions.pending").length, 1); assert.equal(w.g.db.get("voyages.byId", { id: r.voyageId }).status, "adrift");
  w.cleanup();
});

test("rate-limited and crash both park the voyage with the reason; nothing half-written", async () => {
  for (const [script, reason] of [["rate-limited", "rate_limited"], ["crash-midrun", "backend_failure"]]) {
    const w = await worldWithMoon(script); const r = await launchMoon(w.g, { taskId: "T1", provider: "fake" });
    assert.equal(r.moonStatus, "adrift"); assert.equal(w.g.db.get("moons.byTask", { task_id: "T1" }).park_reason, reason, script);
    assert.equal(w.g.db.get("voyages.byId", { id: r.voyageId }).status, "adrift"); w.cleanup();
  }
});

test("launch refuses when no freighter is idle, and when moon is in the wrong state", async () => {
  const w = await worldWithMoon("happy", (c) => { c.roles = { implement: ["fake"], review: ["fake"] }; c.fleet = { freighters: 1, customs: 1, carriers: 1, surveyors: 1, name_theme: "classic" }; });
  await launchMoon(w.g, { taskId: "T1", provider: "fake" });               // freighter now holding (assigned)
  const spec2 = writeSpec(w.dir, "T2", read("tests/fixtures/specs/good-basic.md").replace("src/lib/thing.js", "src/lib/two.js")); w.git("add", "-A"); w.git("commit", "-qm", "s2");
  assignMoon(w.g, { planetId: w.planetId, specPath: spec2 });
  await assert.rejects(launchMoon(w.g, { taskId: "T2", provider: "fake" }), /all freighters in fleet 'fake' are assigned/);
  await assert.rejects(launchMoon(w.g, { taskId: "T1", provider: "fake" }), /is 'audited'/);
  w.cleanup();
});

test("launch refuses a moon whose spec body changed since assign, before any side effect", async () => {
  const w = await worldWithMoon("happy"); const p = path.join(w.dir, ".nexus", "specs", "T1.md");
  fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace("Add X to thing.", "Add Y to thing."));
  await assert.rejects(launchMoon(w.g, { taskId: "T1", provider: "fake" }), /spec body changed since assign/);
  assert.equal(w.g.db.get("moons.byTask", { task_id: "T1" }).status, "emitted"); assert.ok(!fs.existsSync(path.join(w.dir, ".nexus", "worktrees", "T1")));
  w.cleanup();
});

test("launch refuses an adrift moon and points at reply/drop", async () => {
  const w = await worldWithMoon("rate-limited"); await launchMoon(w.g, { taskId: "T1", provider: "fake" });
  await assert.rejects(launchMoon(w.g, { taskId: "T1", provider: "fake" }), /adrift.*reply/);
  w.cleanup();
});

test("renderPrompt substitutes in one pass and throws on an unknown variable", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-prompt-")); const tmp = path.join(dir, "t.md");
  fs.writeFileSync(tmp, "a {{x}} b {{y}}\n");
  assert.equal(renderPrompt(tmp, { x: "{{y}}", y: "Y" }), "a {{y}} b Y\n");
  assert.throws(() => renderPrompt(tmp, { x: "1" }), /unknown variable '\{\{y\}\}'/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an audit that throws parks the voyage as audit_error instead of stranding the moon", async () => {
  const w = await worldWithMoon("happy");
  const r = await launchMoon(w.g, { taskId: "T1", provider: "fake" }, { audit: () => { throw new Error("boom"); } });
  assert.equal(r.audit, null); assert.equal(r.moonStatus, "adrift");
  assert.equal(w.g.db.get("moons.byTask", { task_id: "T1" }).park_reason, "audit_error");
  assert.equal(w.g.db.get("voyages.byId", { id: r.voyageId }).status, "adrift");
  assert.match(w.g.db.all("decisions.pending")[0].reasoning, /boom/); w.cleanup();
});

test("the moon's Touch list reaches the adapter's DispatchCtx", async () => {
  const w = await worldWithMoon("happy", (c) => { c.roles = { implement: ["fake", "probe"], review: ["fake"] }; c.providers.probe = { adapter: "fake" }; });
  let touch;
  w.g.adapters.probe = { id: "probe", roles: ["implement", "review"], classify: () => "unknown", fuel: async () => ({ source: "unknown" }),
    async *dispatch(_job, ctx) { touch = ctx.touch; yield { kind: "done", ts: new Date().toISOString(), data: { report: { status: "IMPLEMENTED", raw: "STATUS: IMPLEMENTED" } } }; } };
  await launchMoon(w.g, { taskId: "T1", provider: "probe" });
  assert.deepEqual(touch, ["src/lib/thing.js", "src/lib/thing.test.js"]);
  w.cleanup();
});

test("moonTouch fails closed on an empty or invalid Touch list", async () => {
  const { moonTouch } = await import("../../dist/server/dispatch.js");
  for (const touch of [null, "[]", "not json", "[1]"]) assert.throws(() => moonTouch({ task_id: "T9", touch }), /moon T9 has no Touch list/);
  assert.deepEqual(moonTouch({ task_id: "T9", touch: '["a"]' }), ["a"]);
});

// ---- final-review fix wave ----
const { dropMoon } = await import("../../dist/server/commands/park.js");
const { inspectMoon } = await import("../../dist/server/commands/review.js");
const { openGalaxy } = await import("../../dist/server/galaxy.js");
const { runVoyage, loadMoon, moonScope } = await import("../../dist/server/dispatch.js");
const { append } = await import("../../dist/db/events.js");
const { Refusal } = await import("../../dist/server/errors.js");
const { TransitionRefused } = await import("../../dist/core/transitions.js");
const { repoRoot } = await import("../helpers.mjs");

const doneImpl = () => ({ kind: "done", ts: new Date().toISOString(), data: { report: { status: "IMPLEMENTED", raw: "STATUS: IMPLEMENTED" } } });
/** A stub adapter: `body(job, ctx)` runs inside dispatch; it yields done unless it returns false. */
const stub = (body) => ({ id: "fake", roles: ["implement", "review"], classify: () => "unknown", fuel: async () => ({ source: "unknown" }),
  async *dispatch(job, ctx) { if ((await body(job, ctx)) !== false) yield doneImpl(); } });
/** Resolves when the signal aborts. */
const untilAborted = (signal) => new Promise((res) => (signal.aborted ? res() : signal.addEventListener("abort", res, { once: true })));
/** Every non-idle ship has a voyage whose state explains it. */
function assertShipsConsistent(g, taskId = "T1") {
  const voyages = g.db.all("voyages.byTask", { task_id: taskId });
  for (const s of g.db.all("ships.all")) {
    if (s.status === "idle") continue;
    const mine = voyages.filter((v) => v.ship_id === s.id).at(-1);
    assert.ok(mine, `ship ${s.id} is '${s.status}' with no voyage`);
    const want = { assigned: ["launched", "working", "holding", "cleared", "en_route"], adrift: ["adrift"], quarantined: ["quarantined"] }[s.status];
    assert.ok(want?.includes(mine.status), `ship ${s.id} '${s.status}' but its voyage is '${mine.status}'`);
  }
}

test("I1: rate-limited → drop → re-assign the same spec → launch succeeds with a #2 voyage id; no ship stranded", async () => {
  const w = await worldWithMoon("rate-limited");
  const a = await launchMoon(w.g, { taskId: "T1", provider: "fake" }); assert.equal(a.moonStatus, "adrift");
  dropMoon(w.g, { taskId: "T1" });
  const p = path.join(w.dir, ".nexus", "specs", "T1.md");
  fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace("FAKE-SCRIPT: rate-limited", "FAKE-SCRIPT: happy")); w.git("add", "-A"); w.git("commit", "-qm", "retry");
  assignMoon(w.g, { planetId: w.planetId, specPath: ".nexus/specs/T1.md" });
  const b = await launchMoon(w.g, { taskId: "T1", provider: "fake" });
  assert.equal(b.moonStatus, "audited"); assert.equal(b.voyageId, `${a.voyageId}#2`, "same ship, same round: suffixed, not a UNIQUE failure");
  assertShipsConsistent(w.g);
  const busy = w.g.db.all("ships.all").filter((s) => s.status !== "idle").map((s) => [s.id, s.status]);
  assert.deepEqual(busy, [[w.g.db.get("voyages.byId", { id: b.voyageId }).ship_id, "assigned"]]);
  w.cleanup();
});

test("I1 / Review Focus #3: two launches of one gated moon through two galaxy handles — exactly one proceeds, no ship stranded", async () => {
  const w = await worldWithMoon("happy");
  append(w.g.db, { kind: "moon.gated", ...moonScope(w.g, loadMoon(w.g, "T1")), payload: { base_sha: w.g.git.headSha(), state_path: "x", round: 1 } });
  const g2 = openGalaxy(w.dir, { scriptsDir: path.join(repoRoot, "tests", "fixtures", "scripts") });
  try {
    const results = await Promise.allSettled([launchMoon(w.g, { taskId: "T1", provider: "fake" }), launchMoon(g2, { taskId: "T1", provider: "fake" })]);
    const ok = results.filter((r) => r.status === "fulfilled"), refused = results.filter((r) => r.status === "rejected");
    assert.equal(ok.length, 1); assert.equal(ok[0].value.moonStatus, "audited");
    assert.equal(refused.length, 1); assert.ok(refused[0].reason instanceof Refusal || refused[0].reason instanceof TransitionRefused, String(refused[0].reason));
    assert.equal(w.g.db.all("voyages.byTask", { task_id: "T1" }).length, 1);
    assertShipsConsistent(w.g);
  } finally { g2.close(); w.cleanup(); }
});

test("I5: resume only the same task's session on the same provider", async () => {
  const w = await worldWithMoon("fix-round", (c) => { c.roles = { implement: ["fake", "probe"], review: ["fake"] }; c.providers.probe = { adapter: "fake" }; c.automation = { level: "manual", max_fix_rounds: 5 }; });
  const jobs = [];
  for (const id of ["fake", "probe"]) { const real = w.g.adapters[id]; w.g.adapters[id] = { ...real, dispatch: (job, ctx) => { jobs.push({ id, job }); return real.dispatch(job, ctx); } }; }
  await launchMoon(w.g, { taskId: "T1", provider: "fake" }); await inspectMoon(w.g, { taskId: "T1", provider: "fake", reviewScript: "review-fix" });
  await launchMoon(w.g, { taskId: "T1", provider: "probe" }); await inspectMoon(w.g, { taskId: "T1", provider: "fake", reviewScript: "review-fix" });
  await launchMoon(w.g, { taskId: "T1", provider: "probe" });
  const impl = jobs.filter((j) => j.job.role === "implement");
  assert.deepEqual(impl.map((j) => j.id), ["fake", "probe", "probe"]);
  assert.equal(impl[0].job.previousSessionId, undefined, "round 1 has nothing to resume");
  assert.equal(impl[1].job.previousSessionId, undefined, "fake's session is not handed to probe");
  assert.equal(impl[2].job.previousSessionId, `fake-${impl[1].job.voyageId}`, "probe resumes its own round-2 session");
  w.cleanup();
});

test("I4a: a voyage that writes into the human's tree parks as main_tree_modified", async () => {
  const w = await worldWithMoon("happy");
  w.g.adapters.fake = stub(() => { fs.writeFileSync(path.join(w.dir, "stray.txt"), "written via Bash\n"); });
  const r = await launchMoon(w.g, { taskId: "T1", provider: "fake" });
  assert.equal(r.moonStatus, "adrift"); assert.equal(r.audit, null);
  assert.equal(loadMoon(w.g, "T1").park_reason, "main_tree_modified");
  const v = w.g.db.get("voyages.byId", { id: r.voyageId }); assert.equal(v.status, "adrift"); assert.match(JSON.parse(v.report).adrift.details, /stray\.txt/);
  assertShipsConsistent(w.g);
  w.cleanup();
});

test("I4b: a state file tampered between gate and audit parks as baseline_tampered", async () => {
  const w = await worldWithMoon("happy");
  w.g.adapters.fake = stub(() => {
    const f = path.join(w.g.paths.stateDir, "T1.json"); const s = JSON.parse(fs.readFileSync(f, "utf8"));
    s.touch.push("README.md"); fs.writeFileSync(f, JSON.stringify(s, null, 2) + "\n");
  });
  const r = await launchMoon(w.g, { taskId: "T1", provider: "fake" });
  assert.equal(r.moonStatus, "adrift"); assert.equal(r.audit, null); assert.equal(loadMoon(w.g, "T1").park_reason, "baseline_tampered");
  const gated = w.g.db.all("events.byTask", { task_id: "T1" }).filter((e) => e.kind === "moon.gated").map((e) => JSON.parse(e.payload));
  assert.match(gated.at(-1).baseline_sha, /^[0-9a-f]{64}$/);
  w.cleanup();
});

test("I2: an externally aborted launch parks the voyage as interrupted; ship and moon parked consistently", async () => {
  const w = await worldWithMoon("happy");
  w.g.adapters.fake = stub(async (_job, ctx) => { await untilAborted(ctx.signal); return false; });
  const ac = new AbortController(); const p = launchMoon(w.g, { taskId: "T1", provider: "fake", signal: ac.signal });
  setTimeout(() => ac.abort(), 20);
  const r = await p;
  assert.equal(r.moonStatus, "adrift"); assert.equal(loadMoon(w.g, "T1").park_reason, "interrupted");
  assert.equal(w.g.db.get("voyages.byId", { id: r.voyageId }).status, "adrift"); assertShipsConsistent(w.g);
  w.cleanup();
});

test("minor: a voyage that runs past timeoutMs parks as timeout, not backend_failure", async () => {
  const w = await worldWithMoon("happy");
  const moon = loadMoon(w.g, "T1");
  append(w.g.db, { kind: "moon.gated", ...moonScope(w.g, moon), payload: { base_sha: w.g.git.headSha(), state_path: "x", round: 1 } });
  w.g.adapters.fake = stub(async (_job, ctx) => { await untilAborted(ctx.signal); return false; });
  const out = await runVoyage(w.g, { role: "implement", taskId: "T1", provider: "fake", worktree: w.dir, touch: ["src/**"], timeoutMs: 30, job: { role: "implement", specPath: moon.spec_path, specText: "", prompt: "", round: 1 } });
  assert.equal(out.parkReason, "timeout"); assert.equal(loadMoon(w.g, "T1").park_reason, "timeout");
  w.cleanup();
});
