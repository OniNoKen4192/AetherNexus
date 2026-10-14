import { test } from "node:test"; import assert from "node:assert/strict";
import { buildEnv, makeTouchGate, mapMessage, createClaudeAdapter } from "../../dist/providers/claude-sdk/index.js";

const sig = { signal: new AbortController().signal };
const hookIn = (tool_name, file_path, extra = {}) => ({ hook_event_name: "PreToolUse", tool_name, tool_input: { file_path, ...extra }, tool_use_id: "1", session_id: "s", cwd: "/repo/wt" });

test("login mode deletes an inherited ANTHROPIC_API_KEY; api_key mode requires it", () => {
  const { env, mode } = buildEnv({ adapter: "claude-sdk", auth: "login" }, { PATH: "p", ANTHROPIC_API_KEY: "sk-leak", ANTHROPIC_AUTH_TOKEN: "t" });
  assert.equal(mode, "login"); assert.equal("ANTHROPIC_API_KEY" in env, false); assert.equal("ANTHROPIC_AUTH_TOKEN" in env, false); assert.equal(env.PATH, "p");
  assert.equal("Anthropic_Api_Key" in buildEnv({ adapter: "claude-sdk", auth: "login" }, { Anthropic_Api_Key: "x", anthropic_auth_token: "y", PATH: "p" }).env, false);
  assert.equal("anthropic_auth_token" in buildEnv({ adapter: "claude-sdk", auth: "login" }, { anthropic_auth_token: "y" }).env, false);
  assert.throws(() => buildEnv({ adapter: "claude-sdk", auth: "api_key", api_key_env: "MY_KEY", max_budget_usd: 1 }, { PATH: "p" }), /MY_KEY is not set/);
  assert.equal(buildEnv({ adapter: "claude-sdk", auth: "api_key", api_key_env: "MY_KEY", max_budget_usd: 1 }, { MY_KEY: "k" }).env.ANTHROPIC_API_KEY, "k");
  assert.throws(() => buildEnv({ adapter: "claude-sdk", auth: "api_key", api_key_env: "MY_KEY" }, { MY_KEY: "k" }), /api_key mode requires max_budget_usd/);
});
test("touch gate denies writes outside touch, allows inside, ignores non-write tools", async () => {
  const gate = makeTouchGate(["src/lib/**"], "/repo/wt");
  const deny = await gate(hookIn("Write", "/repo/wt/README.md"), "1", sig);
  assert.equal(deny.hookSpecificOutput.permissionDecision, "deny"); assert.equal(deny.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal((await gate(hookIn("Edit", "src/lib/x.ts"), "2", sig)).hookSpecificOutput.permissionDecision, "allow");
  assert.equal((await gate(hookIn("Write", "/elsewhere/src/lib/x.ts"), "3", sig)).hookSpecificOutput.permissionDecision, "deny");
  assert.equal((await gate(hookIn("Write", "../src/lib/x.ts"), "4", sig)).hookSpecificOutput.permissionDecision, "deny");
  assert.equal((await gate({ ...hookIn("NotebookEdit", undefined), tool_input: { notebook_path: "/repo/wt/n.ipynb" } }, "5", sig)).hookSpecificOutput.permissionDecision, "deny");
  assert.deepEqual(await gate(hookIn("Read", "/etc/passwd"), "6", sig), {});
});
test("mapMessage: assistant text/tool_use, result → usage + done with parsed report, rate limit rejected → error", () => {
  const asst = { type: "assistant", session_id: "s", uuid: "u", message: { role: "assistant", content: [{ type: "text", text: "hi" }, { type: "tool_use", id: "t", name: "Write", input: { file_path: "src/a.ts", content: "" } }] } };
  assert.deepEqual(mapMessage(asst, "implement").map((e) => e.kind), ["text", "tool_use", "file_changed"]);
  assert.equal(mapMessage(asst, "implement")[2].data.path, "src/a.ts");
  const res = { type: "result", subtype: "success", session_id: "s", num_turns: 2, total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 }, result: "STATUS: IMPLEMENTED\nFILES_CHANGED: a" };
  const ev = mapMessage(res, "implement"); assert.equal(ev[0].kind, "usage"); assert.equal(ev[0].data.cost_usd, 0.01); assert.equal(ev[1].kind, "done"); assert.equal(ev[1].data.report.status, "IMPLEMENTED"); assert.equal(ev[1].data.session_id, "s");
  assert.equal(mapMessage({ ...res, result: "VERDICT: APPROVE\nok" }, "review")[1].data.report.verdict, "APPROVE");
  const err = { type: "result", subtype: "error_max_turns", is_error: true, session_id: "s", num_turns: 1, total_cost_usd: 0, usage: {}, errors: ["max turns"] };
  assert.equal(mapMessage(err, "implement").at(-1).kind, "error"); assert.equal(mapMessage(err, "implement").at(-1).data.classification, "backend_failure");
  assert.equal(mapMessage({ ...err, subtype: "error_max_budget_usd" }, "implement").at(-1).data.classification, "capacity");
  assert.equal(mapMessage({ type: "rate_limit_event", rate_limit_info: { status: "rejected" }, session_id: "s", uuid: "u" }, "implement")[0].data.classification, "rate_limited");
  assert.equal(mapMessage({ type: "rate_limit_event", rate_limit_info: { status: "allowed" }, session_id: "s", uuid: "u" }, "implement")[0].kind, "text");
  assert.deepEqual(mapMessage({ type: "system", subtype: "thinking_tokens" }, "implement"), []);
  assert.match(mapMessage({ type: "system", subtype: "init", session_id: "s", model: "m", apiKeySource: "none" }, "implement")[0].data.text, /session s; model m; apiKeySource none/);
  const ur = { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "x".repeat(3000), is_error: true }] } };
  const tr = mapMessage(ur, "implement")[0]; assert.equal(tr.kind, "tool_result"); assert.equal(tr.data.ok, false); assert.equal(tr.data.output.length, 2000);
});

const okResult = { type: "result", subtype: "success", session_id: "s", num_turns: 1, total_cost_usd: 0, usage: {}, result: "STATUS: IMPLEMENTED" };
const job = { voyageId: "v", role: "implement", specPath: "s", specText: "", prompt: "P", round: 2, previousSessionId: "prev" };
const ctx = (signal = new AbortController().signal) => ({ cwd: "/wt", touch: ["src/**"], timeoutMs: 1000, signal });
async function run(a, j = job, c = ctx()) { const events = []; for await (const e of a.dispatch(j, c)) events.push(e); return events; }

test("adapter wires query options: cwd, env, strictMcpConfig, settingSources, hooks, resume, tools; emits mode as first event", async () => {
  let seen; const fakeQuery = ({ prompt, options }) => { seen = { prompt, options }; return (async function* () { yield okResult; })(); };
  const a = createClaudeAdapter("claude", { adapter: "claude-sdk", auth: "login", max_turns: 7, models: { frontier: "m1" } }, { query: fakeQuery });
  const events = await run(a);
  assert.equal(events[0].kind, "text"); assert.match(events[0].data.text, /auth mode: login/);
  assert.equal(seen.options.cwd, "/wt"); assert.equal(seen.options.strictMcpConfig, true); assert.deepEqual(seen.options.settingSources, ["project"]); assert.equal(seen.options.maxTurns, 7); assert.equal(seen.options.resume, "prev"); assert.equal(seen.options.permissionMode, "dontAsk"); assert.equal(seen.options.model, "m1");
  assert.deepEqual(seen.options.tools, ["Read", "Grep", "Glob", "Bash", "Edit", "Write", "MultiEdit"]); assert.deepEqual(seen.options.allowedTools, seen.options.tools);
  assert.ok(seen.options.hooks.PreToolUse.length === 1); assert.equal("ANTHROPIC_API_KEY" in seen.options.env, false);
  await run(a, { ...job, role: "review" }); assert.deepEqual(seen.options.tools, ["Read", "Grep", "Glob", "Bash"]); assert.deepEqual(seen.options.allowedTools, seen.options.tools);
  assert.equal(a.classify(new Error("rate limit exceeded (429)")), "rate_limited"); assert.equal(a.classify(new Error("ECONNRESET")), "backend_failure");
  assert.equal(a.classify(new Error("overloaded")), "capacity"); assert.equal(a.classify(new Error("???")), "unknown");
});
test("iterator that yields a result then throws yields exactly one done and no extra error", async () => {
  const fakeQuery = () => (async function* () { yield okResult; throw new Error("Claude Code returned an error result: boom"); })();
  const events = await run(createClaudeAdapter("claude", { adapter: "claude-sdk", auth: "login" }, { query: fakeQuery }));
  assert.equal(events.filter((e) => e.kind === "done").length, 1); assert.equal(events.filter((e) => e.kind === "error").length, 0);
  const errResult = { ...okResult, subtype: "error_max_turns", is_error: true, errors: ["Reached maximum number of turns (1)"] };
  const e2 = await run(createClaudeAdapter("claude", { adapter: "claude-sdk", auth: "login" }, { query: () => (async function* () { yield errResult; throw new Error("Claude Code returned an error result: x"); })() }));
  assert.equal(e2.filter((e) => e.kind === "error").length, 1);
});
test("iterator that throws before any result yields one classified error", async () => {
  const e = await run(createClaudeAdapter("claude", { adapter: "claude-sdk", auth: "login" }, { query: () => (async function* () { throw new Error("spawn ENOENT"); })() }));
  const errs = e.filter((x) => x.kind === "error"); assert.equal(errs.length, 1); assert.equal(errs[0].data.classification, "backend_failure");
});
test("abort calls interrupt and stops", async () => {
  const ac = new AbortController(); let interrupted = false;
  const q = (async function* () { yield { type: "system", subtype: "init", session_id: "s", model: "m", apiKeySource: "none" }; await new Promise((r) => setTimeout(r, 50)); yield okResult; })();
  q.interrupt = async () => { interrupted = true; };
  const p = run(createClaudeAdapter("claude", { adapter: "claude-sdk", auth: "login" }, { query: () => q }), job, ctx(ac.signal));
  setTimeout(() => ac.abort(), 10); await p; assert.equal(interrupted, true);
});
