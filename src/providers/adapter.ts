export type Role = "implement" | "review";
export type AgentEventKind = "text" | "tool_use" | "tool_result" | "file_changed" | "usage" | "done" | "error";
export type ErrorClass = "rate_limited" | "capacity" | "backend_failure" | "unknown";
export type ImplementReport = { status: "IMPLEMENTED" | "IMPLEMENTED_WITH_DEVIATIONS" | "BLOCKED" | "BACKEND_FAILURE" | "RATE_LIMITED"; files_changed?: string[]; test_output?: string; deviations?: string; blocked_reason?: string; raw: string };
export type ReviewReport = { verdict: "APPROVE" | "FIX" | "REJECT"; reasoning: string; delta_spec?: string; raw: string };
export type AgentEvent =
  | { kind: "text"; ts: string; data: { text: string } }
  | { kind: "tool_use"; ts: string; data: { name: string; input: unknown; id?: string } }
  | { kind: "tool_result"; ts: string; data: { id?: string; ok: boolean; output?: string } }
  | { kind: "file_changed"; ts: string; data: { path: string } }
  | { kind: "usage"; ts: string; data: { input_tokens?: number; output_tokens?: number; cost_usd?: number } }
  | { kind: "done"; ts: string; data: { report: ImplementReport | ReviewReport; session_id?: string } }
  | { kind: "error"; ts: string; data: { classification: ErrorClass; message: string; raw?: unknown } };
export type Job = { voyageId: string; role: Role; specPath: string; specText: string; prompt: string; round: number; deltaSpec?: string; auditJson?: string; previousSessionId?: string };
export type DispatchCtx = { cwd: string; touch: string[]; timeoutMs: number; signal: AbortSignal };
export type FuelReading = { source: "unknown" } | { source: "estimated" | "reported"; remaining: number; resets_at?: string };
export interface ProviderAdapter {
  readonly id: string; readonly roles: Role[];
  dispatch(job: Job, ctx: DispatchCtx): AsyncIterable<AgentEvent>;
  classify(err: unknown): ErrorClass;
  fuel(): Promise<FuelReading>;
}

const STATUSES: ImplementReport["status"][] = ["IMPLEMENTED", "IMPLEMENTED_WITH_DEVIATIONS", "BLOCKED", "BACKEND_FAILURE", "RATE_LIMITED"];

function field(text: string, name: string): string | undefined {
  const v = text.match(new RegExp(`^${name}:[ \t]*(.*)$`, "m"))?.[1]?.trim();
  return v ? v : undefined;
}

export function parseImplementReport(text: string): ImplementReport {
  const s = text.match(/^STATUS:\s*(\w+)/m)?.[1] as ImplementReport["status"] | undefined;
  const report: ImplementReport = { status: s && STATUSES.includes(s) ? s : "BACKEND_FAILURE", raw: text };
  const files = field(text, "FILES_CHANGED");
  if (files) report.files_changed = files.split(",").map((f) => f.split(/\s+[—-]\s+/)[0]!.trim()).filter(Boolean);
  const t = field(text, "TEST_OUTPUT"); if (t) report.test_output = t;
  const d = field(text, "DEVIATIONS"); if (d) report.deviations = d;
  const b = field(text, "BLOCKED_REASON"); if (b) report.blocked_reason = b;
  return report;
}

export function parseReviewReport(text: string): ReviewReport {
  const m = text.match(/VERDICT:\s*(APPROVE|FIX|REJECT)\b/);
  if (!m) return { verdict: "FIX", reasoning: "no verdict line in report", raw: text };
  const after = text.slice((m.index ?? 0) + m[0].length).trim();
  return { verdict: m[1] as ReviewReport["verdict"], reasoning: after, raw: text };
}
