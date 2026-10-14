import fs from "node:fs";
import path from "node:path";
import { append } from "../../db/events.js";
import { rowToEvent } from "../../db/events.js";
import { pickIdleShip } from "../../core/fleet.js";
import type { MoonStatus } from "../../core/transitions.js";
import type { AgentEvent, ReviewReport } from "../../providers/adapter.js";
import { appendAmendment, hashSpec } from "../../validate/spec.js";
import { Refusal } from "../errors.js";
import type { Galaxy } from "../galaxy.js";
import { loadMoon, moonScope, parkVoyage, promptPath, moonTouch, renderPrompt, runVoyage, shipsNoun } from "../dispatch.js";

type VoyageRow = { id: string; ship_id: string; status: string; round: number; report: string | null };

function pickProvider(g: Galaxy, requested: string | undefined): string {
  if (requested) return requested;
  const ids = g.config.roles.review;
  const first = ids.find((id) => g.adapters[id] && pickIdleShip(g.db, "customs", id)) ?? ids[0];
  if (!first) throw new Refusal("no provider is configured for the review role");
  return first;
}

/** Header stays one line; the delta spec follows as an indented block. */
function amendmentFor(text: string, round: number, reasoning: string, delta: string | undefined): string {
  const note = reasoning.replace(/\s+/g, " ").trim() || "fix required";
  let out = appendAmendment(text, { round, date: new Date().toISOString().slice(0, 10), author: "customs", note });
  if (delta) out = out.replace(/\n+$/, "") + "\n\n" + delta.split("\n").map((l) => "    " + l).join("\n") + "\n";
  return out;
}

export async function inspectMoon(
  g: Galaxy, input: { taskId: string; provider?: string; onEvent?: (e: AgentEvent) => void; reviewScript?: string; signal?: AbortSignal },
): Promise<{ voyageId: string; verdict: ReviewReport | null; moonStatus: MoonStatus }> {
  const { taskId } = input;
  const moon = loadMoon(g, taskId);
  if (moon.status !== "audited") throw new Refusal(`moon ${taskId} is '${moon.status}' — only an 'audited' moon can be inspected`);
  const freighter = g.db.get<VoyageRow>("voyages.latestByTaskRole", { task_id: taskId, role: "implement" });
  if (!freighter || freighter.status !== "holding") throw new Refusal(`moon ${taskId} has no holding freighter voyage to inspect`);

  const audited = g.db.all("events.byTask", { task_id: taskId }).map(rowToEvent)
    .filter((e) => e.kind === "voyage.audited" && e.voyage_id === freighter.id).pop();
  if (!audited) throw new Refusal(`voyage ${freighter.id} has no audit on record`);
  const auditJson = JSON.stringify(audited.payload["audit"], null, 2);
  const implReport = freighter.report ? (JSON.parse(freighter.report) as { raw?: string }) : {};

  const provider = pickProvider(g, input.provider);
  if (!g.adapters[provider]) throw new Refusal(`provider '${provider}' is not configured`);
  if (!pickIdleShip(g.db, "customs", provider)) throw new Refusal(`all ${shipsNoun("customs")} in fleet '${provider}' are assigned`);

  const specAbs = path.join(g.repoRoot, moon.spec_path);
  const specText = fs.readFileSync(specAbs, "utf8");
  const worktree = path.join(g.paths.worktrees, taskId);
  const body = renderPrompt(promptPath("review.md"), {
    spec_text: specText, implementer_report: implReport.raw ?? freighter.report ?? "(no report)", audit_json: auditJson,
  });
  const prompt = input.reviewScript ? `FAKE-SCRIPT: ${input.reviewScript}\n${body}` : body;

  const outcome = await runVoyage(g, {
    role: "review", taskId, provider, worktree, touch: moonTouch(moon), ...(input.onEvent ? { onEvent: input.onEvent } : {}), ...(input.signal ? { signal: input.signal } : {}),
    job: { role: "review", specPath: moon.spec_path, specText, prompt, round: moon.round, auditJson },
  });
  const scope = moonScope(g, moon);
  if (!outcome.done) {
    // runVoyage parked the review voyage and the moon: no verdict was issued, so none is reported.
    return { voyageId: outcome.voyageId, verdict: null, moonStatus: loadMoon(g, taskId).status as MoonStatus };
  }

  const verdict = outcome.done.data.report as ReviewReport;
  // The customs ship has finished its voyage whatever the verdict.
  append(g.db, { kind: "ship.released", ...scope, voyage_id: outcome.voyageId, ship_id: outcome.shipId, payload: { voyage_id: outcome.voyageId, outcome: "docked" } });
  append(g.db, {
    kind: "verdict.issued", ...scope, voyage_id: outcome.voyageId, ship_id: outcome.shipId,
    payload: { verdict: verdict.verdict, reasoning: verdict.reasoning, ...(verdict.delta_spec ? { delta_spec: verdict.delta_spec } : {}), round: moon.round, voyage_id: freighter.id },
  });
  const fscope = { ...scope, voyage_id: freighter.id, ship_id: freighter.ship_id };

  if (verdict.verdict === "APPROVE") {
    append(g.db, { kind: "voyage.cleared", ...fscope, payload: {} });
  } else if (verdict.verdict === "REJECT") {
    append(g.db, { kind: "voyage.quarantined", ...fscope, payload: {} });
    append(g.db, { kind: "ship.quarantined", ...fscope, payload: { voyage_id: freighter.id, outcome: "quarantined" } });
    append(g.db, { kind: "decision.opened", ...scope, payload: { kind: "reject", target_kind: "moon", target_id: taskId, reasoning: verdict.reasoning } });
  } else if (moon.round >= g.config.automation.max_fix_rounds) {
    parkVoyage(g, { taskId, voyageId: freighter.id, shipId: freighter.ship_id, reason: "max_fix_rounds", details: `FIX verdict after round ${moon.round} (max ${g.config.automation.max_fix_rounds}): ${verdict.reasoning}` });
  } else {
    append(g.db, { kind: "voyage.superseded", ...fscope, payload: {} });
    append(g.db, { kind: "ship.released", ...fscope, payload: { voyage_id: freighter.id, outcome: "superseded" } });
    const amended = amendmentFor(specText, moon.round, verdict.reasoning, verdict.delta_spec);
    fs.writeFileSync(specAbs, amended);
    const wtSpec = path.join(worktree, moon.spec_path);
    if (fs.existsSync(path.dirname(wtSpec))) fs.writeFileSync(wtSpec, amended);
    append(g.db, { kind: "moon.amended", ...scope, payload: { appendix_sha: hashSpec(amended).appendixSha } });
  }
  return { voyageId: outcome.voyageId, verdict, moonStatus: loadMoon(g, taskId).status as MoonStatus };
}
