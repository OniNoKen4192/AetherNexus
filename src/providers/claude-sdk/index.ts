import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderConfig } from "../../config/schema.js";
import { parseImplementReport, parseReviewReport } from "../adapter.js";
import type { AgentEvent, ErrorClass, FuelReading, Job, DispatchCtx, ProviderAdapter, Role } from "../adapter.js";
import { makeTouchGate, WRITE_TOOLS } from "./gate-hook.js";

export { makeTouchGate };

/**
 * Per-role tool allowlists. The spike (docs/spikes/2026-10-14-sdk-probe/README.md §1) proved `tools: [...]` is a
 * strict allowlist (with `tools:["Read"]` the model had no Bash), so we allowlist instead of using `disallowedTools`.
 */
const TOOLS: Record<Role, string[]> = {
  implement: ["Read", "Grep", "Glob", "Bash", "Edit", "Write", "MultiEdit"],
  review: ["Read", "Grep", "Glob", "Bash"],
};

const ts = (): string => new Date().toISOString();
const text = (t: string): AgentEvent => ({ kind: "text", ts: ts(), data: { text: t } });
const errEvent = (classification: ErrorClass, message: string): AgentEvent => ({ kind: "error", ts: ts(), data: { classification, message } });

export function buildEnv(cfg: ProviderConfig, base: NodeJS.ProcessEnv): { env: Record<string, string | undefined>; mode: "login" | "api_key" } {
  const env: Record<string, string | undefined> = { ...base };
  const scrub = (): void => { for (const k of Object.keys(env)) if (k.toUpperCase() === "ANTHROPIC_API_KEY" || k.toUpperCase() === "ANTHROPIC_AUTH_TOKEN") delete env[k]; };
  if (cfg.auth === "api_key") {
    const name = cfg.api_key_env ?? "ANTHROPIC_API_KEY";
    const key = base[name];
    if (!key) throw new Error(`${name} is not set`);
    if (!cfg.max_budget_usd) throw new Error("api_key mode requires max_budget_usd");
    scrub(); env["ANTHROPIC_API_KEY"] = key;
    return { env, mode: "api_key" };
  }
  scrub();
  return { env, mode: "login" };
}

export function classify(err: unknown): ErrorClass {
  const msg = err instanceof Error ? err.message : String(err);
  if (/rate.?limit|429|usage limit|resets/i.test(msg)) return "rate_limited";
  if (/overloaded|529|capacity|max_budget/i.test(msg)) return "capacity";
  if (/ECONN|EPIPE|spawn|exit code|error_during_execution|returned an error result/i.test(msg)) return "backend_failure";
  return "unknown";
}

type Block = { type?: string; text?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: unknown; is_error?: boolean };
const blocksOf = (m: unknown): Block[] => { const c = (m as { message?: { content?: unknown } }).message?.content; return Array.isArray(c) ? (c as Block[]) : []; };
const flatten = (c: unknown): string => typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : "")).join("") : c == null ? "" : JSON.stringify(c);

export function mapMessage(m: SDKMessage, role: Role): AgentEvent[] {
  const msg = m as unknown as Record<string, unknown> & { type: string; subtype?: string };
  switch (msg.type) {
    case "system":
      return msg.subtype === "init" ? [text(`session ${msg["session_id"]}; model ${msg["model"]}; apiKeySource ${msg["apiKeySource"]}`)] : [];
    case "assistant": {
      const out: AgentEvent[] = [];
      for (const b of blocksOf(m)) {
        if (b.type === "text" && b.text) out.push(text(b.text));
        else if (b.type === "tool_use") {
          out.push({ kind: "tool_use", ts: ts(), data: { name: b.name ?? "", input: b.input, ...(b.id ? { id: b.id } : {}) } });
          if (b.name && WRITE_TOOLS.has(b.name)) {
            const p = b.input?.["file_path"] ?? b.input?.["notebook_path"];
            if (typeof p === "string") out.push({ kind: "file_changed", ts: ts(), data: { path: p } });
          }
        }
      }
      return out;
    }
    case "user":
      return blocksOf(m).filter((b) => b.type === "tool_result").map((b): AgentEvent => ({ kind: "tool_result", ts: ts(), data: { ...(b.tool_use_id ? { id: b.tool_use_id } : {}), ok: !b.is_error, output: flatten(b.content).slice(0, 2000) } }));
    case "result": {
      const usage = msg["usage"] as { input_tokens?: number; output_tokens?: number } | undefined;
      const u: AgentEvent = { kind: "usage", ts: ts(), data: { ...(usage?.input_tokens !== undefined ? { input_tokens: usage.input_tokens } : {}), ...(usage?.output_tokens !== undefined ? { output_tokens: usage.output_tokens } : {}), ...(typeof msg["total_cost_usd"] === "number" ? { cost_usd: msg["total_cost_usd"] } : {}) } };
      if (msg.subtype === "success") {
        const raw = String(msg["result"] ?? "");
        const report = role === "review" ? parseReviewReport(raw) : parseImplementReport(raw);
        return [u, { kind: "done", ts: ts(), data: { report, session_id: String(msg["session_id"]) } }];
      }
      const errors = Array.isArray(msg["errors"]) ? (msg["errors"] as unknown[]).map(String) : [];
      return [u, errEvent(msg.subtype === "error_max_budget_usd" ? "capacity" : "backend_failure", errors.join("; ") || String(msg.subtype))];
    }
    case "rate_limit_event": {
      const info = msg["rate_limit_info"] as { status?: string } | undefined;
      return info?.status === "rejected"
        ? [errEvent("rate_limited", `rate limit rejected: ${JSON.stringify(info)}`)]
        : [text(`rate limit status: ${info?.status ?? "unknown"}`)];
    }
    default:
      return [];
  }
}

type QueryFn = typeof sdkQuery;
type Q = AsyncIterable<SDKMessage> & { interrupt?: () => Promise<void> | void };

export function createClaudeAdapter(id: string, cfg: ProviderConfig, deps: { query?: QueryFn } = {}): ProviderAdapter {
  const run = deps.query ?? sdkQuery;
  return {
    id, roles: ["implement", "review"],
    classify,
    async fuel(): Promise<FuelReading> { return { source: "unknown" }; },
    async *dispatch(job: Job, ctx: DispatchCtx): AsyncIterable<AgentEvent> {
      let built: ReturnType<typeof buildEnv>;
      try { built = buildEnv(cfg, process.env); } catch (e) { yield errEvent("unknown", e instanceof Error ? e.message : String(e)); return; }
      yield text(`auth mode: ${built.mode}`);
      const options: Options = {
        cwd: ctx.cwd, env: built.env, strictMcpConfig: true, settingSources: ["project"], permissionMode: "dontAsk",
        tools: TOOLS[job.role], allowedTools: TOOLS[job.role], maxTurns: cfg.max_turns ?? 60,
        ...(cfg.max_budget_usd ? { maxBudgetUsd: cfg.max_budget_usd } : {}),
        ...(job.previousSessionId ? { resume: job.previousSessionId } : {}),
        ...(cfg.models?.["frontier"] ? { model: cfg.models["frontier"] } : {}),
        hooks: { PreToolUse: [{ matcher: "Write|Edit|MultiEdit|NotebookEdit", hooks: [makeTouchGate(ctx.touch, ctx.cwd)] }] },
      };
      let q: Q;
      try { q = run({ prompt: job.prompt, options }) as Q; } catch (e) { yield text(String(e)); yield errEvent(classify(e), e instanceof Error ? e.message : String(e)); return; }
      const aborted = new Promise<"abort">((res) => { if (ctx.signal.aborted) res("abort"); else ctx.signal.addEventListener("abort", () => res("abort"), { once: true }); });
      const it = q[Symbol.asyncIterator]();
      let sawResult = false;
      try {
        for (;;) {
          const next = await Promise.race([it.next(), aborted]);
          if (next === "abort") { try { await q.interrupt?.(); } catch { /* best effort */ } void it.return?.(undefined)?.catch?.(() => {}); return; }
          if (next.done) return;
          if ((next.value as { type?: string }).type === "result") sawResult = true;
          yield* mapMessage(next.value, job.role);
        }
      } catch (e) {
        // The SDK throws after yielding an error result; that result was already reported, so don't double-report.
        if (sawResult) return;
        const message = e instanceof Error ? e.message : String(e);
        yield text(message);
        yield errEvent(classify(e), message);
      }
    },
  };
}
