import { append } from "../../db/events.js";
import type { MoonStatus } from "../../core/transitions.js";
import { Refusal } from "../errors.js";
import type { Galaxy } from "../galaxy.js";
import { loadMoon, moonScope, parkVoyage } from "../dispatch.js";

type DecisionRow = { id: number; kind: string; target_id: string; reasoning: string | null; status: string };
type VoyageRow = { id: string; ship_id: string; status: string };

export const MAIN_TREE_CHANGED = "main_tree_changed";

/** The pending main-tree question on a moon, if any. */
export function pendingTreeDecision(g: Galaxy, taskId: string): { id: number; reasoning: string } | undefined {
  const d = g.db.all<DecisionRow>("decisions.pendingByTarget", { target_id: taskId }).find((x) => x.kind === MAIN_TREE_CHANGED);
  return d ? { id: d.id, reasoning: d.reasoning ?? "" } : undefined;
}

/** Everything that advances a moon waits for the human's answer, so the answer lands on a moon that has not moved. */
export function requireTreeAnswered(g: Galaxy, taskId: string): void {
  const d = pendingTreeDecision(g, taskId);
  if (d) throw new Refusal(`moon ${taskId} has an unanswered main-tree question (decision ${d.id}) — answer it first: nexus decision answer ${d.id} --mine | --not-mine`);
}

/** Answer a main_tree_changed decision. "mine" only resolves it; "not_mine" also parks the moon as main_tree_modified. */
export function answerDecision(g: Galaxy, input: { decisionId: number; answer: "mine" | "not_mine" }): { moonStatus: MoonStatus; parked: boolean } {
  const d = g.db.get<DecisionRow>("decisions.byId", { id: input.decisionId });
  if (!d) throw new Refusal(`no decision ${input.decisionId}`);
  if (d.status !== "pending") throw new Refusal(`decision ${d.id} is '${d.status}' — only a pending decision can be answered`);
  if (d.kind !== MAIN_TREE_CHANGED) throw new Refusal(`decision ${d.id} is a '${d.kind}' decision — reply, or cancel the delivery`);
  const moon = loadMoon(g, d.target_id);
  const scope = moonScope(g, moon);
  const status = (): MoonStatus => loadMoon(g, d.target_id).status as MoonStatus;
  const resolve = (): void => { append(g.db, { kind: "decision.resolved", ...scope, payload: { decision_id: d.id, outcome: input.answer } }); };
  if (input.answer === "mine") { resolve(); return { moonStatus: status(), parked: false }; }
  // "not mine" parks first and resolves last: a crash in between leaves a parked moon with the question still pending,
  // and answering again takes the already-adrift path below and only resolves it.
  if (moon.status === "adrift" || moon.status === "quarantined") { resolve(); return { moonStatus: status(), parked: false }; }
  const reasoning = d.reasoning ?? "";
  const delivery = g.db.get<VoyageRow>("voyages.latestByAssignmentRole", { assignment_id: moon.assignment_id, role: "implement" });
  if (delivery && (delivery.status === "holding" || delivery.status === "cleared")) {
    parkVoyage(g, { taskId: moon.task_id, voyageId: delivery.id, shipId: delivery.ship_id, reason: "main_tree_modified", details: reasoning });
  } else {
    // The delivery is already superseded (FIX): park the moon itself, as the carry-over park in delivery.ts does.
    append(g.db, { kind: "moon.adrift", ...scope, payload: { reason: "main_tree_modified" } });
    append(g.db, { kind: "decision.opened", ...scope, payload: { kind: "adrift", target_kind: "moon", target_id: moon.task_id, reasoning: `the main tree changed during a voyage and the change is not the owner's: ${reasoning}` } });
  }
  resolve();
  return { moonStatus: status(), parked: true };
}
