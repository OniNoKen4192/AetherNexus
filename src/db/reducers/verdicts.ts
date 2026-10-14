import type { Reducer } from "../events.js";
import { transitionMoon } from "./moons.js";

export const verdictReducers: Record<string, Reducer> = {
  "verdict.issued": (db, ev) => {
    const p = ev.payload as { verdict: string; delta_spec?: unknown; reasoning?: string; round: number; voyage_id?: string };
    transitionMoon(db, ev.moon_id, `verdict.issued:${p.verdict}`, ev.id);
    db.run("verdicts.insert", { moon_id: ev.moon_id!, voyage_id: p.voyage_id ?? ev.voyage_id, verdict: p.verdict, delta_spec: p.delta_spec === undefined || p.delta_spec === null ? null : typeof p.delta_spec === "string" ? p.delta_spec : JSON.stringify(p.delta_spec), reasoning: p.reasoning ?? null, round: p.round, last_event_id: ev.id });
  },
};
