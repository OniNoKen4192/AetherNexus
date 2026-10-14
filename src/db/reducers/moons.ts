import type { Reducer } from "../events.js";
import type { NexusDb } from "../open.js";
import type { GeneratedMoon } from "../../core/bodies.js";
import { nextMoonStatus, type MoonStatus } from "../../core/transitions.js";

type MoonRow = { id: string; status: MoonStatus | null; task_id: string | null };
function moonRow(db: NexusDb, id: string | null | undefined): MoonRow {
  const row = id ? db.get<MoonRow>("moons.byId", { id }) : undefined;
  if (!row) throw new Error(`moon '${id}' does not exist`);
  return row;
}
/** Read the moon, validate the transition for `key`, write the new status. Throws TransitionRefused (rolls back append). */
export function transitionMoon(db: NexusDb, moonId: string | null | undefined, key: string, lastEventId: number, parkReason: string | null = null): MoonStatus {
  const row = moonRow(db, moonId);
  const next = nextMoonStatus(row.status ?? "barren", key, row.task_id ?? row.id);
  db.run("moons.setStatus", { id: row.id, status: next, park_reason: parkReason, last_event_id: lastEventId });
  return next;
}
const reasonOf = (p: Record<string, unknown>): string | null => (typeof p["reason"] === "string" ? p["reason"] : null);

export const moonReducers: Record<string, Reducer> = {
  "moon.discovered": (db, ev) => {
    const { moon } = ev.payload as { moon: GeneratedMoon };
    db.run("moons.insertBarren", { id: `${ev.planet_id}/${moon.name}`, planet_id: ev.planet_id!, name: moon.name, orbit_index: moon.orbit_index, last_event_id: ev.id });
  },
  "moon.assigned": (db, ev) => {
    const p = ev.payload as { task_id: string; spec_path: string; spec_sha: string; touch: string[]; depends_on: string[]; tier: string };
    nextMoonStatus((moonRow(db, ev.moon_id).status ?? "barren"), "moon.assigned", p.task_id);
    db.run("moons.assign", { id: ev.moon_id!, task_id: p.task_id, spec_path: p.spec_path, spec_sha: p.spec_sha, touch: JSON.stringify(p.touch), depends_on: JSON.stringify(p.depends_on), tier: p.tier, assignment_id: ev.id, last_event_id: ev.id });
  },
  "moon.gated": (db, ev) => {
    transitionMoon(db, ev.moon_id, "moon.gated", ev.id);
    const round = (ev.payload as { round?: number }).round;
    if (typeof round === "number") db.run("moons.setRound", { id: ev.moon_id!, round, last_event_id: ev.id });
  },
  "moon.gate_failed": (db, ev) => { transitionMoon(db, ev.moon_id, "moon.gate_failed", ev.id, reasonOf(ev.payload)); },
  "moon.adrift": (db, ev) => { transitionMoon(db, ev.moon_id, "moon.adrift", ev.id, reasonOf(ev.payload)); },
  "moon.dropped": (db, ev) => { transitionMoon(db, ev.moon_id, "moon.dropped", ev.id); },
  "moon.merged": (db, ev) => {
    transitionMoon(db, ev.moon_id, "moon.merged", ev.id);
    db.run("moons.settle", { id: ev.moon_id!, last_event_id: ev.id });
  },
  // A spec amendment is recorded for the log; the spec file itself is the state.
  "moon.amended": (db, ev) => { moonRow(db, ev.moon_id); },
  // A human reply is log-only; launch reads the event stream to decide whether a parked moon may relaunch.
  "human.message": () => {},
  // Log-only: records which paths a relaunch restored to the baseline; it changes no status.
  "moon.restored": () => {},
  "moon.cleared": (db, ev) => { moonRow(db, ev.moon_id); db.run("moons.clear", { id: ev.moon_id!, last_event_id: ev.id }); },
};
