import { test } from "node:test"; import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { createFakeAdapter } from "../../dist/providers/fake/index.js";
import { parseImplementReport, parseReviewReport } from "../../dist/providers/adapter.js";
import { repoRoot } from "../helpers.mjs";

const scripts = path.join(repoRoot, "tests", "fixtures", "scripts");
const ctx = () => ({ cwd: fs.mkdtempSync(path.join(os.tmpdir(), "fake-")), touch: ["src/lib/thing.js", "src/lib/thing.test.js"], timeoutMs: 5000, signal: new AbortController().signal });
const job = (name, role = "implement") => ({ voyageId: "v", role, specPath: "s", specText: "", prompt: `FAKE-SCRIPT: ${name}\n`, round: 1 });
async function collect(it) { const out = []; for await (const e of it) out.push(e); return out; }

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
