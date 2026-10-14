import type { Reducer } from "../events.js";

export const decisionReducers: Record<string, Reducer> = {
  "decision.opened": (db, ev) => {
    const p = ev.payload as { kind: string; target_kind: string; target_id: string; reasoning?: string };
    db.run("decisions.insert", { kind: p.kind, target_kind: p.target_kind, target_id: p.target_id, reasoning: p.reasoning ?? null, opened_ts: ev.ts, last_event_id: ev.id });
  },
  "decision.resolved": (db, ev) => {
    const p = ev.payload as { decision_id: number; outcome: string; human_note?: string };
    const row = db.get<{ status: string }>("decisions.byId", { id: p.decision_id });
    if (!row) throw new Error(`decision ${p.decision_id} does not exist`);
    if (row.status !== "pending") throw new Error(`decision ${p.decision_id} is '${row.status}'; only a pending decision can be resolved`);
    db.run("decisions.resolve", { id: p.decision_id, outcome: p.outcome, human_note: p.human_note ?? null, resolved_ts: ev.ts, last_event_id: ev.id });
  },
};
