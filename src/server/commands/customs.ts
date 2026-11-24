import fs from "node:fs";
import path from "node:path";
import { append, appendAll, type NexusEvent } from "../../db/events.js";
import { rowToEvent } from "../../db/events.js";
import type { MoonStatus } from "../../core/transitions.js";
import type { AgentEvent, ReviewReport } from "../../providers/adapter.js";
import { appendAmendment, hashSpec, specAppendix } from "../../validate/spec.js";
import { Refusal } from "../errors.js";
import type { Galaxy } from "../galaxy.js";
import { chooseProvider } from "../limiter/limiter.js";
import { requireTreeAnswered } from "./decision.js";
import { loadMoon, moonScope, parkEvents, recordTreeWrite, promptPath, moonTouch, renderPrompt, runVoyage, type MoonRow } from "../dispatch.js";

type VoyageRow = { id: string; ship_id: string; status: string; round: number; report: string | null };

/** Header stays one line; the delta spec follows as an indented block. */
const amendmentNote = (reasoning: string): string => reasoning.replace(/\s+/g, " ").trim() || "fix required";
function amendmentFor(text: string, round: number, reasoning: string, delta: string | undefined): string {
  const note = amendmentNote(reasoning);
  let out = appendAmendment(text, { round, date: new Date().toISOString().slice(0, 10), author: "customs", note });
  if (delta) out = out.replace(/\n+$/, "") + "\n\n" + delta.split("\n").map((l) => "    " + l).join("\n") + "\n";
  return out;
}

export async function sendCustoms(
  g: Galaxy, input: { taskId: string; provider?: string; override?: boolean; onEvent?: (e: AgentEvent) => void; reviewScript?: string; signal?: AbortSignal; onLaunched?: (voyageId: string) => void },
): Promise<{ voyageId: string; verdict: ReviewReport | null; moonStatus: MoonStatus }> {
  const { taskId } = input;
  requireTreeAnswered(g, taskId);
  const moon = loadMoon(g, taskId);
  if (unrecordedReturn(g, moon)) throw new Refusal(`moon ${taskId} is 'reviewing' — customs already came back and its verdict is waiting to be recorded; run 'nexus verdict record'`);
  if (moon.status !== "audited") throw new Refusal(`moon ${taskId} is '${moon.status}' — only an 'audited' moon can be inspected`);
  const delivery = g.db.get<VoyageRow>("voyages.latestByAssignmentRole", { assignment_id: moon.assignment_id, role: "implement" });
  if (!delivery || delivery.status !== "holding") throw new Refusal(`moon ${taskId} has no holding delivery voyage to inspect`);

  const audited = g.db.all("events.byAssignment", { assignment_id: moon.assignment_id }).map(rowToEvent)
    .filter((e) => e.kind === "voyage.audited" && e.voyage_id === delivery.id).pop();
  if (!audited) throw new Refusal(`voyage ${delivery.id} has no audit on record`);
  const auditJson = JSON.stringify(audited.payload["audit"], null, 2);
  const implReport = delivery.report ? (JSON.parse(delivery.report) as { raw?: string }) : {};

  const choice = chooseProvider(g, {
    role: "review", tier: moon.tier, mayRefuel: false,
    ...(input.provider !== undefined ? { requested: input.provider } : {}), override: input.override === true,
  });
  if (choice.kind === "held") {
    const reset = choice.until ? `, resets ${choice.until}` : "";
    throw new Refusal(`moon ${taskId} is waiting on ${choice.provider} fuel (${choice.reason})${reset}`, {
      provider: choice.provider, reason: choice.reason, until: choice.until ?? null, can_refuel: choice.canRefuel ?? null,
    });
  }
  if (choice.kind === "none") throw new Refusal(choice.message);
  const provider = choice.provider;
  if (!g.adapters[provider]) throw new Refusal(`provider '${provider}' is not configured`);

  const specAbs = path.join(g.repoRoot, moon.spec_path);
  const specText = fs.readFileSync(specAbs, "utf8");
  const worktree = path.join(g.paths.worktrees, taskId);
  const body = renderPrompt(promptPath("review.md"), {
    spec_text: specText, implementer_report: implReport.raw ?? delivery.report ?? "(no report)", audit_json: auditJson,
  });
  const prompt = input.reviewScript ? `FAKE-SCRIPT: ${input.reviewScript}\n${body}` : body;

  const outcome = await runVoyage(g, {
    role: "review", taskId, provider, worktree, touch: moonTouch(moon), ...(input.onEvent ? { onEvent: input.onEvent } : {}), ...(input.signal ? { signal: input.signal } : {}), ...(input.onLaunched ? { onLaunched: input.onLaunched } : {}),
    job: { role: "review", specPath: moon.spec_path, specText, prompt, round: moon.round, auditJson },
  });
  if (!outcome.done) {
    // runVoyage ended the review voyage without a verdict (parked, or its ship ran out of fuel and the moon is back to audited): none is reported.
    return { voyageId: outcome.voyageId, verdict: null, moonStatus: loadMoon(g, taskId).status as MoonStatus };
  }

  const verdict = outcome.done.data.report as ReviewReport;
  // The customs ship was released with its return, in runVoyage.
  writeVerdict(g, moon, delivery, { id: outcome.voyageId, ship_id: outcome.shipId }, verdict);
  return { voyageId: outcome.voyageId, verdict, moonStatus: loadMoon(g, taskId).status as MoonStatus };
}

/**
 * Record the verdict a customs voyage brought back when the record of it is missing (`unrecordedReturn`). Nothing flies:
 * no ship, no provider, no fuel. Refused for any moon that has no such verdict waiting.
 */
export function recordVerdict(g: Galaxy, input: { taskId: string }): { voyageId: string; verdict: ReviewReport; moonStatus: MoonStatus } {
  const { taskId } = input;
  requireTreeAnswered(g, taskId);
  const moon = loadMoon(g, taskId);
  const unrecorded = unrecordedReturn(g, moon);
  if (!unrecorded) throw new Refusal(`moon ${taskId} is '${moon.status}' — no customs verdict is waiting to be recorded`);
  const delivery = g.db.get<VoyageRow>("voyages.latestByAssignmentRole", { assignment_id: moon.assignment_id, role: "implement" });
  if (!delivery || delivery.status !== "holding") throw new Refusal(`moon ${taskId} has no holding delivery voyage for the verdict to apply to`);
  writeVerdict(g, moon, delivery, unrecorded.review, unrecorded.verdict);
  return { voyageId: unrecorded.review.id, verdict: unrecorded.verdict, moonStatus: loadMoon(g, taskId).status as MoonStatus };
}

const verdictRecorded = (g: Galaxy, moon: MoonRow, reviewVoyageId: string): boolean =>
  g.db.all("events.byAssignment", { assignment_id: moon.assignment_id }).map(rowToEvent).some((e) => e.kind === "verdict.issued" && e.voyage_id === reviewVoyageId);

/**
 * The customs voyage that returned for this moon without its verdict being recorded, with the verdict from its report; null
 * when there is none. The return and the verdict are two writes, so a process that dies between them leaves the moon
 * `reviewing` with nothing flying. `recordVerdict` records the stored verdict; customs does not fly again.
 */
export function unrecordedReturn(g: Galaxy, moon: MoonRow): { review: { id: string; ship_id: string }; verdict: ReviewReport } | null {
  if (moon.status !== "reviewing") return null;
  const review = g.db.get<VoyageRow>("voyages.latestByAssignmentRole", { assignment_id: moon.assignment_id, role: "review" });
  if (!review || review.status !== "docked" || !review.report) return null;
  let verdict: ReviewReport;
  try { verdict = JSON.parse(review.report) as ReviewReport; } catch { return null; }
  if (verdict?.verdict !== "APPROVE" && verdict?.verdict !== "FIX" && verdict?.verdict !== "REJECT") return null;
  return verdictRecorded(g, moon, review.id) ? null : { review: { id: review.id, ship_id: review.ship_id }, verdict };
}

/**
 * Record customs' verdict and what it does to the delivery. The verdict and the delivery's fate are one transaction, so a
 * crash cannot leave a verdict that nothing acted on; the transaction also checks that this customs voyage has no verdict
 * yet, so two processes finishing the same return record it once.
 */
function writeVerdict(g: Galaxy, moon: MoonRow, delivery: VoyageRow, review: { id: string; ship_id: string }, verdict: ReviewReport): void {
  const taskId = moon.task_id;
  const scope = moonScope(g, moon);
  const fscope = { ...scope, voyage_id: delivery.id, ship_id: delivery.ship_id };
  let outOfRounds = false;
  const rows = appendAll(g.db, () => {
    if (verdictRecorded(g, moon, review.id)) return [];
    const issued: NexusEvent = {
      kind: "verdict.issued", ...scope, voyage_id: review.id, ship_id: review.ship_id,
      payload: { verdict: verdict.verdict, reasoning: verdict.reasoning, ...(verdict.delta_spec ? { delta_spec: verdict.delta_spec } : {}), round: moon.round, voyage_id: delivery.id },
    };
    if (verdict.verdict === "APPROVE") return [issued, { kind: "voyage.cleared", ...fscope, payload: {} }];
    if (verdict.verdict === "REJECT") return [
      issued,
      { kind: "voyage.quarantined", ...fscope, payload: {} },
      { kind: "ship.quarantined", ...fscope, payload: { voyage_id: delivery.id, outcome: "quarantined" } },
      { kind: "decision.opened", ...scope, payload: { kind: "reject", target_kind: "moon", target_id: taskId, reasoning: verdict.reasoning } },
    ];
    // This FIX counts towards the cap. Out of rounds, the delivery is parked, not superseded.
    const fixes = g.db.all<{ verdict: string }>("verdicts.byAssignment", { assignment_id: moon.assignment_id }).filter((row) => row.verdict === "FIX").length + 1;
    if (fixes >= g.config.automation.max_fix_rounds) {
      outOfRounds = true;
      return [issued, ...parkEvents(g, { taskId, voyageId: delivery.id, shipId: delivery.ship_id, reason: "max_fix_rounds", details: `FIX verdict after round ${moon.round} (max ${g.config.automation.max_fix_rounds}): ${verdict.reasoning}` })];
    }
    // a superseded voyage never keeps its ship
    return [
      issued,
      { kind: "voyage.superseded", ...fscope, payload: {} },
      { kind: "ship.released", ...fscope, payload: { voyage_id: delivery.id, outcome: "superseded" } },
    ];
  });
  if (rows.length > 0 && verdict.verdict === "FIX" && !outOfRounds) amendForFix(g, moon);
}

/**
 * Write customs' latest FIX into the spec as an amendment, unless it is already there. The amendment is files and a log
 * entry written after the verdict, so a process can die anywhere among them; this is called again before the next
 * delivery is sent and finishes whatever is missing, writing the entry at most once. A FIX at the round cap parks the
 * moon and is not an amendment.
 */
export function amendForFix(g: Galaxy, moon: MoonRow): void {
  const events = g.db.all("events.byAssignment", { assignment_id: moon.assignment_id }).map(rowToEvent);
  const issued = events.filter((e) => e.kind === "verdict.issued").pop();
  if (!issued || issued.payload["verdict"] !== "FIX") return;
  const later = events.filter((e) => e.id > issued.id);
  if (later.some((e) => e.kind === "moon.amended" && e.payload["for_verdict"] === issued.id)) return;
  if (later.some((e) => e.kind === "moon.adrift" && e.payload["reason"] === "max_fix_rounds")) return;
  const reasoning = typeof issued.payload["reasoning"] === "string" ? issued.payload["reasoning"] : "";
  const delta = typeof issued.payload["delta_spec"] === "string" ? issued.payload["delta_spec"] : undefined;
  const specAbs = path.join(g.repoRoot, moon.spec_path);
  let text = fs.readFileSync(specAbs, "utf8");
  // The entry is in the file when the process died after writing it (or an older build wrote it and logged it unmarked).
  const header = `customs: ${amendmentNote(reasoning)}`;
  const written = specAppendix(text).split("\n").some((line) => /^### A\d+ /.test(line) && line.endsWith(header));
  if (!written) {
    text = amendmentFor(text, Number(issued.payload["round"]), reasoning, delta);
    recordTreeWrite(g, [moon.spec_path]);
    fs.writeFileSync(specAbs, text);
  }
  const wtSpec = path.join(g.paths.worktrees, moon.task_id, moon.spec_path);
  if (fs.existsSync(path.dirname(wtSpec))) fs.writeFileSync(wtSpec, text);
  append(g.db, { kind: "moon.amended", ...moonScope(g, moon), payload: { appendix_sha: hashSpec(text).appendixSha, for_verdict: issued.id } });
}
