import type { NexusDb } from "./open.js";
import { applyEvent, rowToEvent } from "./events.js";
// delete order respects foreign keys
export const PROJECTION_TABLES = ["verdicts", "decisions", "voyages", "moons", "planets", "ships", "systems"] as const;
export function rebuild(db: NexusDb): { events: number } {
  return db.transaction(() => {
    for (const t of PROJECTION_TABLES) db.raw.exec(`DELETE FROM ${t}`);
    let n = 0;
    for (const r of db.all("events.all")) { applyEvent(db, rowToEvent(r)); n++; }
    return { events: n };
  });
}
export function dumpProjections(db: NexusDb): string {
  const out: Record<string, unknown[]> = {};
  for (const t of [...PROJECTION_TABLES].sort()) out[t] = db.raw.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all();
  return JSON.stringify(out, null, 1);
}
