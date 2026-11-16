import fs from "node:fs"; import path from "node:path"; import { setTimeout as sleep } from "node:timers/promises";
import type { ProviderAdapter, Job, DispatchCtx, AgentEvent, ErrorClass, ImplementReport, ReviewReport, Role } from "../adapter.js";

export type FakeScript = { name: string; role: Role; steps: FakeStep[]; rounds?: Record<string, string>; providers?: Record<string, string> };
export type FakeStep = { delay_ms?: number } & (
  | { text: string } | { write: { path: string; content: string } } | { tool: string; input?: unknown }
  | { usage: { input_tokens: number; output_tokens: number } }
  | { fuel: { window: string; used: number; resets_in_ms?: number; model_family?: string } }
  | { error: { classification: ErrorClass; message: string; resets_in_ms?: number; model_family?: string } }
  | { done: { status?: ImplementReport["status"]; verdict?: ReviewReport["verdict"]; reasoning?: string; delta_spec?: string } }
  | { crash: string }
);

export function createFakeAdapter(scriptsDir: string, opts: { id?: string; pick?: (job: Job) => string } = {}): ProviderAdapter {
  const pick = opts.pick ?? ((job: Job) => {
    // A review prompt embeds the spec, whose comment names the IMPLEMENT script; only review-* names count there.
    const names = [...job.prompt.matchAll(/FAKE-SCRIPT:\s*(\S+)/g)].map((m) => m[1]!);
    const name = (job.role === "review" ? names.find((n) => n.startsWith("review-")) : names[0]) ?? (job.role === "review" ? "review-approve" : "happy");
    // Scripted "first attempt goes wrong" scripts behave on the fix round.
    return (name === "fix-round" || name === "scope-violation") && job.round > 1 ? "happy" : name;
  });
  const now = () => new Date().toISOString();
  const timed = (resets_in_ms?: number, model_family?: string) => ({
    ...(resets_in_ms === undefined ? {} : { resets_at: new Date(Date.now() + resets_in_ms).toISOString() }),
    ...(model_family === undefined ? {} : { model_family }),
  });
  return {
    id: opts.id ?? "fake", roles: ["implement", "review"],
    async *dispatch(job: Job, ctx: DispatchCtx): AsyncIterable<AgentEvent> {
      const picked = JSON.parse(fs.readFileSync(path.join(scriptsDir, `${pick(job)}.json`), "utf8")) as FakeScript;
      const redirect = picked.providers?.[opts.id ?? "fake"] ?? picked.rounds?.[String(job.round)];
      const script = redirect === undefined ? picked : JSON.parse(fs.readFileSync(path.join(scriptsDir, `${redirect}.json`), "utf8")) as FakeScript;
      if (job.model !== undefined) yield { kind: "text", ts: now(), data: { text: `fake: model ${job.model}` } };
      for (const step of script.steps) {
        if (ctx.signal.aborted) return;
        if (step.delay_ms) {
          try { await sleep(step.delay_ms, undefined, { signal: ctx.signal }); } catch (err) { if (ctx.signal.aborted) return; throw err; }
        }
        if ("text" in step) yield { kind: "text", ts: now(), data: { text: step.text } };
        else if ("tool" in step) yield { kind: "tool_use", ts: now(), data: { name: step.tool, input: step.input } };
        else if ("write" in step) { const p = path.join(ctx.cwd, step.write.path); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, step.write.content); yield { kind: "file_changed", ts: now(), data: { path: step.write.path } }; }
        else if ("usage" in step) yield { kind: "usage", ts: now(), data: step.usage };
        else if ("fuel" in step) yield { kind: "fuel", ts: now(), data: { window: step.fuel.window, used: step.fuel.used, ...timed(step.fuel.resets_in_ms, step.fuel.model_family) } };
        else if ("error" in step) { yield { kind: "error", ts: now(), data: { classification: step.error.classification, message: step.error.message, ...timed(step.error.resets_in_ms, step.error.model_family) } }; return; }
        else if ("crash" in step) throw new Error(step.crash);
        else if ("done" in step) {
          const d = step.done;
          const report: ImplementReport | ReviewReport = job.role === "review"
            ? { verdict: d.verdict ?? "APPROVE", reasoning: d.reasoning ?? "", ...(d.delta_spec ? { delta_spec: d.delta_spec } : {}), raw: `VERDICT: ${d.verdict ?? "APPROVE"}\n${d.reasoning ?? ""}` }
            : { status: d.status ?? "IMPLEMENTED", raw: `STATUS: ${d.status ?? "IMPLEMENTED"}` };
          yield { kind: "done", ts: now(), data: { report, session_id: `fake-${job.voyageId}` } }; return;
        }
      }
    },
    classify(): ErrorClass { return "unknown"; },
  };
}
