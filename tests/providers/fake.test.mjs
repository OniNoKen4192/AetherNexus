import { test } from "node:test"; import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { createFakeAdapter } from "../../dist/providers/fake/index.js";
import { buildAdapters } from "../../dist/providers/index.js";
import { parseImplementReport, parseReviewReport } from "../../dist/providers/adapter.js";
import { repoRoot } from "../helpers.mjs";

const scripts = path.join(repoRoot, "tests", "fixtures", "scripts");
const ctx = () => ({ cwd: fs.mkdtempSync(path.join(os.tmpdir(), "fake-")), touch: ["src/lib/thing.js", "src/lib/thing.test.js"], timeoutMs: 5000, signal: new AbortController().signal });
const job = (name, role = "implement") => ({ voyageId: "v", role, specPath: "s", specText: "", prompt: `FAKE-SCRIPT: ${name}\n`, round: 1 });
async function collect(it) { const out = []; for await (const e of it) out.push(e); return out; }
const writeScript = (dir, name, value) => fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(value));

test("happy: emits events in order, writes files into cwd, ends with done", async () => {
  const c = ctx(); const events = await collect(createFakeAdapter(scripts).dispatch(job("happy"), c));
  assert.deepEqual(events.map((e) => e.kind), ["text", "tool_use", "file_changed", "file_changed", "usage", "done"]);
  assert.equal(fs.readFileSync(path.join(c.cwd, "src", "lib", "thing.js"), "utf8"), "export const thing = 2;\n");
  assert.equal(events.at(-1).data.report.status, "IMPLEMENTED");
  for (const e of events) assert.match(e.ts, /^\d{4}-/);
});
test("rate-limited emits an error event and stops; classify maps it", async () => {
  const a = createFakeAdapter(scripts); const events = await collect(a.dispatch(job("rate-limited"), ctx()));
  assert.equal(events.at(-1).kind, "error"); assert.equal(events.at(-1).data.classification, "rate_limited");
  assert.equal(a.classify(new Error("usage limit reached")), "unknown", "fake classify never guesses from text");
});
test("crash-midrun throws out of the iterator after earlier events", async () => {
  const seen = []; await assert.rejects(async () => { for await (const e of createFakeAdapter(scripts).dispatch(job("crash-midrun"), ctx())) seen.push(e.kind); }, /socket hang up/);
  assert.deepEqual(seen, ["file_changed"]);
});
test("review scripts produce review reports", async () => {
  for (const [name, verdict] of [["review-approve", "APPROVE"], ["review-fix", "FIX"], ["review-reject", "REJECT"]]) {
    const events = await collect(createFakeAdapter(scripts).dispatch(job(name, "review"), ctx())); assert.equal(events.at(-1).data.report.verdict, verdict, name);
  }
});
test("abort signal stops the stream", async () => {
  const ac = new AbortController(); const c = { ...ctx(), signal: ac.signal }; const seen = [];
  for await (const e of createFakeAdapter(scripts).dispatch(job("happy"), c)) { seen.push(e.kind); ac.abort(); }
  assert.equal(seen.length, 1);
});
test("report parsers", () => {
  const r = parseImplementReport("STATUS: IMPLEMENTED_WITH_DEVIATIONS\nFILES_CHANGED: a.js — x\nTEST_OUTPUT: ok\nDEVIATIONS: renamed helper\nBLOCKED_REASON:");
  assert.equal(r.status, "IMPLEMENTED_WITH_DEVIATIONS"); assert.equal(r.deviations, "renamed helper");
  assert.equal(parseImplementReport("I did stuff").status, "BACKEND_FAILURE");
  assert.equal(parseReviewReport("…\nVERDICT: REJECT\nreason here").verdict, "REJECT");
  assert.deepEqual(parseReviewReport("no verdict").verdict, "FIX");
});

test("I6: parseReviewReport splits reasoning from a multi-line DELTA SPEC block", () => {
  const text = [
    "I re-ran the acceptance tests and read the diff.",
    "",
    "VERDICT: FIX",
    "The implementation adds X but the test only checks the happy path.",
    "Edge case for an empty input is missing.",
    "",
    "DELTA SPEC:",
    "- Add a test for thing() with an empty array.",
    "- thing([]) must return 0.",
    "",
  ].join("\n");
  const r = parseReviewReport(text);
  assert.equal(r.verdict, "FIX");
  assert.equal(r.reasoning, "The implementation adds X but the test only checks the happy path.\nEdge case for an empty input is missing.");
  assert.equal(r.delta_spec, "- Add a test for thing() with an empty array.\n- thing([]) must return 0.");
  assert.equal(r.raw, text);
  const inline = parseReviewReport("VERDICT: FIX\nneeds a test\nDELTA SPEC: add a test for []");
  assert.equal(inline.reasoning, "needs a test"); assert.equal(inline.delta_spec, "add a test for []");
  const approve = parseReviewReport("VERDICT: APPROVE\nall good"); assert.equal(approve.reasoning, "all good"); assert.equal("delta_spec" in approve, false);
});

test("fuel-ok reports fuel before file changes and still completes", async () => {
  const before = Date.now(); const events = await collect(createFakeAdapter(scripts).dispatch(job("fuel-ok"), ctx()));
  const fuel = events.find((e) => e.kind === "fuel");
  assert.deepEqual({ window: fuel.data.window, used: fuel.data.used }, { window: "5h", used: 0.2 });
  assert.ok(Date.parse(fuel.data.resets_at) - before >= 55000 && Date.parse(fuel.data.resets_at) - before <= 65000);
  assert.ok(events.indexOf(fuel) < events.findIndex((e) => e.kind === "file_changed"));
  assert.equal(events.at(-1).kind, "done");
});

test("wall hits the wall once and redirects round 2 to happy", async () => {
  const firstJob = job("wall"); const before = Date.now();
  const first = await collect(createFakeAdapter(scripts).dispatch(firstJob, ctx())); const error = first.at(-1);
  assert.equal(error.kind, "error"); assert.equal(error.data.classification, "rate_limited");
  assert.ok(Date.parse(error.data.resets_at) - before >= 200 && Date.parse(error.data.resets_at) - before <= 600);
  assert.equal(first.some((e) => e.kind === "done"), false);
  const second = await collect(createFakeAdapter(scripts).dispatch({ ...firstJob, round: 2 }, ctx()));
  const happy = await collect(createFakeAdapter(scripts).dispatch(job("happy"), ctx()));
  assert.deepEqual(second.map((e) => e.kind), happy.map((e) => e.kind));
});

test("wall-twice hits the wall at rounds 1 and 2", async () => {
  for (const round of [1, 2]) {
    const events = await collect(createFakeAdapter(scripts).dispatch({ ...job("wall-twice"), round }, ctx()));
    assert.equal(events.at(-1).kind, "error"); assert.equal(events.at(-1).data.classification, "rate_limited");
  }
});

test("model_family passes through fuel and error events", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-scripts-"));
  writeScript(dir, "families", { name: "families", role: "implement", steps: [
    { fuel: { window: "5h", used: 0.5, model_family: "family-a" } },
    { error: { classification: "rate_limited", message: "usage limit reached", model_family: "family-b" } },
  ] });
  const events = await collect(createFakeAdapter(dir).dispatch(job("families"), ctx()));
  assert.equal(events[0].data.model_family, "family-a"); assert.equal(events[1].data.model_family, "family-b");
});

test("provider redirect beats round redirect", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-scripts-"));
  fs.copyFileSync(path.join(scripts, "happy.json"), path.join(dir, "happy.json"));
  fs.copyFileSync(path.join(scripts, "wall-twice.json"), path.join(dir, "wall-twice.json"));
  writeScript(dir, "redirect", { name: "redirect", role: "implement", steps: [], providers: { spare: "happy" }, rounds: { "1": "wall-twice" } });
  const spare = await collect(createFakeAdapter(dir, { id: "spare" }).dispatch(job("redirect"), ctx()));
  const fallback = await collect(createFakeAdapter(dir).dispatch(job("redirect"), ctx()));
  assert.equal(spare.at(-1).kind, "done"); assert.equal(fallback.at(-1).kind, "error");
});

test("missing redirect target names the missing script", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-scripts-"));
  writeScript(dir, "missing", { name: "missing", role: "implement", steps: [], rounds: { "1": "not-there" } });
  await assert.rejects(() => collect(createFakeAdapter(dir).dispatch(job("missing"), ctx())), /not-there/);
});

test("fake adapter ids default and can be configured", () => {
  assert.equal(createFakeAdapter(scripts).id, "fake"); assert.equal(createFakeAdapter(scripts, { id: "spare" }).id, "spare");
});

test("job model is announced as the first event only when set", async () => {
  const modeled = await collect(createFakeAdapter(scripts).dispatch({ ...job("happy"), model: "m-cheap" }, ctx()));
  assert.equal(modeled[0].kind, "text"); assert.equal(modeled[0].data.text, "fake: model m-cheap");
  const ordinary = await collect(createFakeAdapter(scripts).dispatch(job("happy"), ctx()));
  assert.equal(ordinary.some((e) => e.kind === "text" && e.data.text === "fake: model m-cheap"), false);
});

test("buildAdapters assigns config ids and exposes no fuel method", () => {
  const adapters = buildAdapters({ providers: { primary: { adapter: "fake" }, spare: { adapter: "fake" } } }, { scriptsDir: scripts });
  assert.equal(adapters.primary.id, "primary"); assert.equal(adapters.spare.id, "spare");
  assert.equal("fuel" in adapters.primary, false); assert.equal("fuel" in adapters.spare, false);
});
