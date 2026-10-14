import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ProviderConfig } from "../../config/schema.js";
import { parseImplementReport, parseReviewReport } from "../adapter.js";
import type { AgentEvent, ErrorClass, FuelReading, Job, DispatchCtx, ProviderAdapter } from "../adapter.js";

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean; structuredContent?: unknown };
export type McpClientLike = {
  connect(t: unknown): Promise<void>;
  listTools(): Promise<{ tools: { name: string; inputSchema: unknown }[] }>;
  callTool(a: { name: string; arguments: Record<string, unknown> }): Promise<ToolResult>;
  close(): Promise<void>;
};
type Deps = { makeClient?: (cwd: string, onStderr: (line: string) => void) => Promise<McpClientLike> };

const ts = (): string => new Date().toISOString();
const text = (t: string): AgentEvent => ({ kind: "text", ts: ts(), data: { text: t } });
const errEvent = (classification: ErrorClass, message: string): AgentEvent => ({ kind: "error", ts: ts(), data: { classification, message } });

const DEFAULT_RATELIMIT = ["usage limit", "rate limit", "429"];
const MODELS_CACHE_NOISE = /failed to load models cache/i;

export function textOf(result: { content: { type: string; text?: string }[]; structuredContent?: unknown }): string {
  const joined = (result.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
  if (joined) return joined;
  const sc = result.structuredContent as { content?: unknown } | undefined;
  return typeof sc?.content === "string" ? sc.content : "";
}

function makeClassify(cfg: ProviderConfig): (err: unknown) => ErrorClass {
  const signals = (cfg.ratelimit_signal ?? DEFAULT_RATELIMIT).map((s) => s.toLowerCase());
  return (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    const low = msg.toLowerCase();
    if (signals.some((s) => low.includes(s))) return "rate_limited";
    if (/overloaded|capacity|insufficient_quota/i.test(msg)) return "capacity";
    if (/ECONN|EPIPE|spawn|exited|closed|not found/i.test(msg)) return "backend_failure";
    return "unknown";
  };
}

const modelHintOf = (specText: string): string | undefined => specText.match(/^\s*-\s+\*\*Model hint\*\*:\s*(\S+)/m)?.[1];

function dropUnknown(args: Record<string, unknown>, schema: unknown): { kept: Record<string, unknown>; dropped: string[] } {
  const props = (schema as { properties?: Record<string, unknown> } | undefined)?.properties;
  if (!props) return { kept: args, dropped: [] };
  const kept: Record<string, unknown> = {}; const dropped: string[] = [];
  for (const [k, v] of Object.entries(args)) { if (k in props) kept[k] = v; else dropped.push(k); }
  return { kept, dropped };
}

/** Builds the tool arguments (first call -> `codex`, round > 1 -> `codex-reply`) and drops keys the server's schema does not advertise. */
export function buildCodexArgs(job: Job, ctx: DispatchCtx, schema: unknown, cfg?: ProviderConfig): Record<string, unknown> {
  return buildWithDropped(job, ctx, schema, cfg).kept;
}

function buildWithDropped(job: Job, ctx: DispatchCtx, schema: unknown, cfg?: ProviderConfig): { kept: Record<string, unknown>; dropped: string[] } {
  if (job.previousSessionId) return dropUnknown({ prompt: job.prompt, threadId: job.previousSessionId }, schema);
  const hint = modelHintOf(job.specText);
  const model = (hint ? cfg?.models?.[hint] : undefined) ?? cfg?.models?.["default"];
  return dropUnknown({ prompt: job.prompt, cwd: ctx.cwd, sandbox: "workspace-write", "approval-policy": "never", ...(model ? { model } : {}) }, schema);
}

/** Parse `git status --porcelain -z`: "XY path\0"; renames/copies are followed by an extra "origpath\0". */
function parsePorcelainZ(out: string): string[] {
  const parts = out.split("\0"); const paths: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i]!; if (rec.length < 4) continue;
    paths.push(rec.slice(3));
    if (/[RC]/.test(rec.slice(0, 2))) { const orig = parts[++i]; if (orig) paths.push(orig); }
  }
  return paths;
}

function changedPaths(cwd: string): string[] {
  // The ONE direct git call outside src/core/git.ts: it is read-only (status), and Codex runs out-of-process so its writes cannot be observed any other way.
  return parsePorcelainZ(execFileSync("git", ["-C", cwd, "status", "--porcelain", "-z", "--untracked-files=all"], { encoding: "utf8" }));
}

async function realClient(cwd: string, onStderr: (line: string) => void): Promise<McpClientLike> {
  const transport = new StdioClientTransport({ command: "codex", args: ["mcp-server"], cwd, stderr: "pipe" });
  let buf = "";
  transport.stderr?.on("data", (d: Buffer) => { buf += d.toString(); const lines = buf.split(/\r?\n/); buf = lines.pop() ?? ""; for (const l of lines) if (l.trim()) onStderr(l); });
  const client = new Client({ name: "nexus", version: "0.1.0" });
  await client.connect(transport);
  return client as unknown as McpClientLike;
}

export function createCodexAdapter(id: string, cfg: ProviderConfig, deps: Deps = {}): ProviderAdapter {
  const classify = makeClassify(cfg);
  const make = deps.makeClient ?? realClient;
  return {
    id, roles: ["implement", "review"],
    classify,
    async fuel(): Promise<FuelReading> { return { source: "unknown" }; },
    async *dispatch(job: Job, ctx: DispatchCtx): AsyncIterable<AgentEvent> {
      const pending: string[] = [];
      const onStderr = (line: string): void => { if (!MODELS_CACHE_NOISE.test(line)) pending.push(line); };
      const flush = function* (): Generator<AgentEvent> { while (pending.length) yield text(`codex: ${pending.shift()}`); };
      let client: McpClientLike | undefined;
      try {
        const tool = job.previousSessionId ? "codex-reply" : "codex";
        yield text(`dispatching to codex mcp-server (tool ${tool}, sandbox workspace-write)`);
        client = await make(ctx.cwd, onStderr);
        const listed = await client.listTools();
        const { kept, dropped } = buildWithDropped(job, ctx, listed.tools.find((t) => t.name === tool)?.inputSchema, cfg);
        if (dropped.length) yield text(`codex tool '${tool}' does not advertise: ${dropped.join(", ")} (dropped)`);
        const aborted = new Promise<"abort">((res) => { if (ctx.signal.aborted) res("abort"); else ctx.signal.addEventListener("abort", () => res("abort"), { once: true }); });
        const call = client.callTool({ name: tool, arguments: kept }); call.catch(() => {}); // a late rejection after abort/close must not go unhandled
        const result = await Promise.race([call, aborted]);
        yield* flush();
        if (result === "abort") return;
        const body = textOf(result);
        if (result.isError) { yield errEvent(classify(body), body); return; }
        try { for (const p of changedPaths(ctx.cwd)) yield { kind: "file_changed", ts: ts(), data: { path: p } }; }
        catch (e) { yield text(`git status failed: ${e instanceof Error ? e.message : String(e)}`); }
        const sc = result.structuredContent as { threadId?: unknown } | undefined;
        const threadId = typeof sc?.threadId === "string" ? sc.threadId : body.match(/threadId["':\s=]+([\w-]+)/)?.[1];
        const report = job.role === "review" ? parseReviewReport(body) : parseImplementReport(body);
        yield { kind: "done", ts: ts(), data: { report, ...(threadId ? { session_id: threadId } : {}) } };
      } catch (e) {
        yield* flush();
        const message = e instanceof Error ? e.message : String(e);
        yield text(message); yield errEvent(classify(e), message);
      } finally {
        if (client) { try { await client.close(); } catch { /* best effort */ } }
      }
    },
  };
}
