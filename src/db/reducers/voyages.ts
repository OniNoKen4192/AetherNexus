import type { Reducer } from "../events.js";
import type { NexusDb } from "../open.js";
import { nextVoyageStatus, type VoyageStatus } from "../../core/transitions.js";
import { transitionMoon } from "./moons.js";

function transitionVoyage(db: NexusDb, id: string | null | undefined, key: string): VoyageStatus {
  const row = id ? db.get<{ status: VoyageStatus }>("voyages.byId", { id }) : undefined;
  if (!row) throw new Error(`voyage '${id}' does not exist`);
  return nextVoyageStatus(row.status, key, id!);
}
const set = (key: string): Reducer => (db, ev) => {
  db.run("voyages.setStatus", { id: ev.voyage_id!, status: transitionVoyage(db, ev.voyage_id, key), last_event_id: ev.id });
};
const json = (v: unknown): string | null => (v === undefined ? null : JSON.stringify(v));

export const voyageReducers: Record<string, Reducer> = {
  "voyage.launched": (db, ev) => {
    const p = ev.payload as { role: string; round: number; provider: string; model?: string; ship_id: string; session_id?: string };
    transitionMoon(db, ev.moon_id, `voyage.launched:${p.role}`, ev.id);
    db.run("voyages.insert", { id: ev.voyage_id!, ship_id: p.ship_id ?? ev.ship_id, moon_id: ev.moon_id ?? null, planet_id: ev.planet_id ?? null, role: p.role, round: p.round, provider: p.provider ?? ev.provider, model: p.model ?? null, session_id: p.session_id ?? null, launched_ts: ev.ts, last_event_id: ev.id });
  },
  "voyage.event": set("voyage.event"),
  "voyage.returned": (db, ev) => {
    const p = ev.payload as { role: string; report?: unknown; session_id?: string; cost?: unknown };
    const status = transitionVoyage(db, ev.voyage_id, `voyage.returned:${p.role}`);
    db.run("voyages.setReturned", { id: ev.voyage_id!, status, returned_ts: ev.ts, report: json(p.report), session_id: p.session_id ?? null, cost: json(p.cost), last_event_id: ev.id });
  },
  // the audit moves the moon; the voyage stays 'holding' until cleared
  "voyage.audited": (db, ev) => { transitionMoon(db, ev.moon_id, "voyage.audited", ev.id); },
  "voyage.cleared": set("voyage.cleared"),
  "voyage.departed": set("voyage.departed"),
  "voyage.docked": (db, ev) => {
    const status = transitionVoyage(db, ev.voyage_id, "voyage.docked");
    db.run("voyages.setDocked", { id: ev.voyage_id!, status, docked_ts: ev.ts, last_event_id: ev.id });
  },
  "voyage.superseded": set("voyage.superseded"),
  "voyage.quarantined": set("voyage.quarantined"),
  "voyage.adrift": (db, ev) => {
    const status = transitionVoyage(db, ev.voyage_id, "voyage.adrift");
    const { reason, details } = ev.payload as { reason?: string; details?: unknown };
    db.run("voyages.setAdrift", { id: ev.voyage_id!, status, adrift: JSON.stringify({ reason: reason ?? null, details: details ?? null }), last_event_id: ev.id });
  },
};
