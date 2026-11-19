// Spends the user's pools: ONE small call per real adapter. Runs only with NEXUS_LIVE set; never in CI.
// It answers what the real adapters report as fuel: every `fuel` event the adapter yields, and the raw rate-limit
// message it came from. Only rate-limit numbers and message-type counts are printed — never prompt or reply text.
import { test } from "node:test"; import assert from "node:assert/strict";
import fs from "node:fs"; import path from "node:path";
import { makeRepo } from "../helpers.mjs";

const live = !!process.env.NEXUS_LIVE;
const PROMPT = "Reply with exactly: VERDICT: APPROVE";
const say = (label, value) => console.log(`[fuel-live] ${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
const job = (extra = {}) => ({ voyageId: "live-fuel", role: "review", specPath: "spec.md", specText: "", prompt: PROMPT, round: 1, ...extra });

async function collect(adapter, theJob, cwd) {
  const events = []; const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), 240_000);
  try { for await (const e of adapter.dispatch(theJob, { cwd, touch: [], timeoutMs: 240_000, signal: ac.signal })) events.push(e); }
  finally { clearTimeout(timer); }
  return events;
}
const kinds = (events) => events.reduce((m, e) => ({ ...m, [e.kind]: (m[e.kind] ?? 0) + 1 }), {});

test("live: fuel readings from the Claude SDK", { skip: !live, timeout: 300_000 }, async () => {
  const { createClaudeAdapter } = await import("../../dist/providers/claude-sdk/index.js");
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const raw = []; const types = {};
  const tee = (args) => {
    const q = query(args);
    const wrapped = (async function* () {
      for await (const m of q) { types[m.type] = (types[m.type] ?? 0) + 1; if (m.type === "rate_limit_event") raw.push(m.rate_limit_info ?? null); yield m; }
    })();
    wrapped.interrupt = () => q.interrupt?.();
    return wrapped;
  };
  const repo = makeRepo();
  try {
    const adapter = createClaudeAdapter("claude", { adapter: "claude-sdk", auth: "login", max_turns: 1 }, { query: tee });
    const events = await collect(adapter, job({ model: "claude-haiku-5-5" }), repo.dir);
    say("claude message types", types);
    say("claude raw rate_limit_info", raw);
    say("claude adapter events", kinds(events));
    say("claude fuel events", events.filter((e) => e.kind === "fuel").map((e) => e.data));
    say("claude errors", events.filter((e) => e.kind === "error").map((e) => ({ classification: e.data.classification, message: String(e.data.message).slice(0, 200) })));
    assert.ok(events.some((e) => e.kind === "done" || e.kind === "error"), "the voyage ended");
  } finally { repo.cleanup(); }
});

test("live: fuel readings from codex mcp-server", { skip: !live, timeout: 300_000 }, async () => {
  const { createCodexAdapter } = await import("../../dist/providers/codex-mcp/index.js");
  const { codexSessionsRoot } = await import("../../dist/providers/codex-mcp/fuel.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const notifications = {}; const notifiedLimits = [];
  const findLimits = (v, depth = 0) => { if (!v || typeof v !== "object" || depth > 6) return; if (v.rate_limits && typeof v.rate_limits === "object") notifiedLimits.push(v.rate_limits); for (const k of Object.keys(v)) findLimits(v[k], depth + 1); };
  const makeClient = async (cwd) => {
    const transport = new StdioClientTransport({ command: "codex", args: ["mcp-server"], cwd, stderr: "pipe" });
    transport.stderr?.on("data", () => {});
    const client = new Client({ name: "nexus", version: "0.1.0" });
    client.fallbackNotificationHandler = async (n) => {
      const inner = n?.params?.msg?.type; const key = inner ? `${n.method} / ${inner}` : String(n?.method);
      notifications[key] = (notifications[key] ?? 0) + 1; findLimits(n?.params);
    };
    await client.connect(transport);
    return client;
  };
  const repo = makeRepo();
  try {
    const adapter = createCodexAdapter("codex", { adapter: "codex-mcp", models: { default: "gpt-5.6-luna" } }, { makeClient });
    const events = await collect(adapter, job(), repo.dir);
    const done = events.find((e) => e.kind === "done");
    const threadId = done?.data?.session_id;
    say("codex adapter events", kinds(events));
    say("codex thread id reported", !!threadId);
    say("codex fuel events", events.filter((e) => e.kind === "fuel").map((e) => e.data));
    say("codex errors", events.filter((e) => e.kind === "error").map((e) => ({ classification: e.data.classification, message: String(e.data.message).slice(0, 200) })));
    say("codex notification kinds", notifications);
    say("codex rate_limits seen in notifications", notifiedLimits.slice(-2));
    // The session log of the thread this call created: print only its rate_limits snapshots (numbers), never its text.
    if (threadId && /^[A-Za-z0-9_-]+$/.test(threadId)) {
      const root = codexSessionsRoot(process.env); const found = [];
      const visit = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) visit(p); else if (e.name.endsWith(`-${threadId}.jsonl`)) found.push(p); } };
      try { visit(root); } catch { /* no sessions root */ }
      const snapshots = [];
      for (const file of found) for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) { try { const limits = JSON.parse(line)?.payload?.rate_limits; if (limits && typeof limits === "object") snapshots.push(limits); } catch { /* not json */ } }
      say("codex session log files for the thread", found.length);
      say("codex rate_limits snapshots in the log", snapshots.length);
      say("codex last raw snapshot", snapshots.at(-1) ?? null);
    }
    assert.ok(events.some((e) => e.kind === "done" || e.kind === "error"), "the voyage ended");
  } finally { repo.cleanup(); }
});
