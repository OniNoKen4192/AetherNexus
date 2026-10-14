import { test } from "node:test"; import assert from "node:assert/strict";
import { createCodexAdapter, buildCodexArgs, textOf } from "../../dist/providers/codex-mcp/index.js";
import { makeRepo } from "../helpers.mjs";

const SCHEMA = { properties: { prompt: {}, cwd: {}, sandbox: {}, "approval-policy": {}, model: {}, threadId: {} } };
const baseJob = { voyageId: "v", role: "implement", specPath: "s", specText: "- **Model hint**: terra\n", prompt: "NEXUS-SPEC: do it", round: 1 };
const mkCtx = (cwd, signal = new AbortController().signal) => ({ cwd, touch: ["src/**"], timeoutMs: 5000, signal });
async function run(a, j, c) { const ev = []; for await (const e of a.dispatch(j, c)) ev.push(e); return ev; }
function stub({ schema = SCHEMA, result, onCall, hang } = {}) {
  const s = { calls: [], closed: 0, connected: 0 };
  s.client = {
    async connect() { s.connected++; },
    async listTools() { return { tools: [{ name: "codex", inputSchema: schema }, { name: "codex-reply", inputSchema: schema }] }; },
    async callTool(a) { s.calls.push(a); if (hang) return new Promise(() => {}); onCall?.(a); return result ?? { content: [{ type: "text", text: "STATUS: IMPLEMENTED" }], structuredContent: { threadId: "th-1", content: "STATUS: IMPLEMENTED" } }; },
    async close() { s.closed++; },
  };
  return s;
}
const cfg = { adapter: "codex-mcp", models: { default: "m-def", terra: "m-terra" }, ratelimit_signal: ["usage limit"] };

test("first call: args carry cwd/prompt/sandbox/approval, tier model, no unknown keys; session_id = threadId", async () => {
  const repo = makeRepo(); const s = stub();
  try {
    const a = createCodexAdapter("codex", cfg, { makeClient: async () => s.client });
    const ev = await run(a, baseJob, mkCtx(repo.dir));
    assert.equal(s.calls[0].name, "codex");
    const args = s.calls[0].arguments;
    assert.equal(args.cwd, repo.dir); assert.match(args.prompt, /^NEXUS-SPEC:/); assert.equal(args.sandbox, "workspace-write"); assert.equal(args["approval-policy"], "never"); assert.equal(args.model, "m-terra");
    assert.ok(Object.keys(args).every((k) => k in SCHEMA.properties));
    assert.match(ev[0].data.text, /dispatching to codex mcp-server \(tool codex, sandbox workspace-write\)/);
    const done = ev.at(-1); assert.equal(done.kind, "done"); assert.equal(done.data.report.status, "IMPLEMENTED"); assert.equal(done.data.session_id, "th-1");
    assert.ok(s.closed >= 1);
  } finally { repo.cleanup(); }
});
test("model falls back to default when no tier hint matches; omitted when none configured", () => {
  const ctx = mkCtx("/x");
  assert.equal(buildCodexArgs({ ...baseJob, specText: "- **Model hint**: nope\n" }, ctx, SCHEMA, cfg).model, "m-def");
  assert.equal("model" in buildCodexArgs(baseJob, ctx, SCHEMA, { adapter: "codex-mcp" }), false);
});
test("schema-driven key dropping logs a text event", async () => {
  const repo = makeRepo(); const s = stub({ schema: { properties: { prompt: {}, cwd: {}, sandbox: {}, "approval-policy": {} } } });
  try {
    const ev = await run(createCodexAdapter("codex", cfg, { makeClient: async () => s.client }), baseJob, mkCtx(repo.dir));
    assert.equal("model" in s.calls[0].arguments, false);
    assert.ok(ev.some((e) => e.kind === "text" && /does not advertise: model.*dropped/.test(e.data.text)));
  } finally { repo.cleanup(); }
});
test("file_changed for files written during the call", async () => {
  const repo = makeRepo(); const s = stub({ onCall: () => { repo.write("src/lib/new.js", "x\n"); repo.write("README.md", "changed\n"); } });
  try {
    const ev = await run(createCodexAdapter("codex", cfg, { makeClient: async () => s.client }), baseJob, mkCtx(repo.dir));
    const paths = ev.filter((e) => e.kind === "file_changed").map((e) => e.data.path).sort();
    assert.deepEqual(paths, ["README.md", "src/lib/new.js"]);
    assert.ok(ev.findIndex((e) => e.kind === "file_changed") < ev.findIndex((e) => e.kind === "done"));
  } finally { repo.cleanup(); }
});
test("isError + ratelimit signal -> rate_limited error, no done", async () => {
  const repo = makeRepo(); const s = stub({ result: { isError: true, content: [{ type: "text", text: "You hit the Usage Limit" }] } });
  try {
    const ev = await run(createCodexAdapter("codex", cfg, { makeClient: async () => s.client }), baseJob, mkCtx(repo.dir));
    const e = ev.at(-1); assert.equal(e.kind, "error"); assert.equal(e.data.classification, "rate_limited"); assert.equal(ev.some((x) => x.kind === "done"), false);
  } finally { repo.cleanup(); }
});
test("classify: defaults, capacity, backend_failure, unknown", () => {
  const a = createCodexAdapter("codex", { adapter: "codex-mcp" });
  assert.equal(a.classify(new Error("HTTP 429")), "rate_limited"); assert.equal(a.classify("insufficient_quota"), "capacity");
  assert.equal(a.classify(new Error("spawn codex ENOENT")), "backend_failure"); assert.equal(a.classify("???"), "unknown");
});
test("round 2 with previousSessionId -> codex-reply with threadId", async () => {
  const repo = makeRepo(); const s = stub();
  try {
    await run(createCodexAdapter("codex", cfg, { makeClient: async () => s.client }), { ...baseJob, round: 2, previousSessionId: "th-0" }, mkCtx(repo.dir));
    assert.equal(s.calls[0].name, "codex-reply"); assert.deepEqual(s.calls[0].arguments, { prompt: "NEXUS-SPEC: do it", threadId: "th-0" });
  } finally { repo.cleanup(); }
});
test("abort: closes the client and emits no done", async () => {
  const repo = makeRepo(); const s = stub({ hang: true }); const ac = new AbortController();
  try {
    const p = run(createCodexAdapter("codex", cfg, { makeClient: async () => s.client }), baseJob, mkCtx(repo.dir, ac.signal));
    setTimeout(() => ac.abort(), 50); const ev = await p;
    assert.ok(s.closed >= 1); assert.equal(ev.some((e) => e.kind === "done"), false);
  } finally { repo.cleanup(); }
});
test("textOf joins text blocks", () => assert.equal(textOf({ content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] }), "ab"));
