import type { NexusDb, Row } from "./open.js";
import { REDUCERS } from "./reducers/index.js";
export type NexusEvent = { kind: string; ts?: string; system_id?: string | null; planet_id?: string | null; moon_id?: string | null;
  voyage_id?: string | null; ship_id?: string | null; task_id?: string | null; provider?: string | null; payload: Record<string, unknown> };
export type EventRow = NexusEvent & { id: number; ts: string };
export type Reducer = (db: NexusDb, ev: EventRow) => void;

export function rowToEvent(r: Row): EventRow {
  return { ...(r as unknown as EventRow), payload: JSON.parse(String(r["payload"])) as Record<string, unknown> };
}
export function applyEvent(db: NexusDb, ev: EventRow): void {
  const reducer = REDUCERS[ev.kind];
  if (!reducer) throw new Error(`no reducer for '${ev.kind}'`);
  reducer(db, ev);
}
export function append(db: NexusDb, ev: NexusEvent, precheck?: () => void): EventRow {
  return db.transaction(() => {
    precheck?.();
    const ts = ev.ts ?? new Date().toISOString();
    const { lastInsertRowid } = db.run("events.insert", {
      ts, kind: ev.kind, system_id: ev.system_id ?? null, planet_id: ev.planet_id ?? null, moon_id: ev.moon_id ?? null,
      voyage_id: ev.voyage_id ?? null, ship_id: ev.ship_id ?? null, task_id: ev.task_id ?? null, provider: ev.provider ?? null, payload: JSON.stringify(ev.payload),
    });
    const row = rowToEvent(db.get("events.byId", { id: lastInsertRowid })!);
    applyEvent(db, row);
    return row;
  });
}
