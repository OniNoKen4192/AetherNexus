import type { Reducer } from "../events.js";

export const decisionReducers: Record<string, Reducer> = {
  // `reasoning` has no column; it stays in the event log
  "decision.opened": (db, ev) => {
    const p = ev.payload as { kind: string; target_kind: string; target_id: string };
    db.run("decisions.insert", { kind: p.kind, target_kind: p.target_kind, target_id: p.target_id, opened_ts: ev.ts, last_event_id: ev.id });
  },
  "decision.resolved": (db, ev) => {
    const p = ev.payload as { decision_id: number; outcome: string; human_note?: string };
    if (!db.get("decisions.byId", { id: p.decision_id })) throw new Error(`decision ${p.decision_id} does not exist`);
    db.run("decisions.resolve", { id: p.decision_id, outcome: p.outcome, human_note: p.human_note ?? null, resolved_ts: ev.ts, last_event_id: ev.id });
  },
};
