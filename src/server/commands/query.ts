import { rowToEvent, type EventRow } from "../../db/events.js";
import type { Row } from "../../db/open.js";
import type { Galaxy } from "../galaxy.js";
import { Refusal } from "../errors.js";

export function status(g: Galaxy, systemId?: string): { systems: Row[]; moons: Row[]; voyages: Row[]; decisions: Row[] } {
  if (systemId && !g.db.get("systems.byId", { id: systemId })) throw new Refusal(`unknown system '${systemId}'`);
  const systems = systemId ? [g.db.get("systems.byId", { id: systemId })].filter((s): s is Row => !!s) : g.db.all("systems.all");
  const moons: Row[] = []; const voyages: Row[] = [];
  for (const s of systems) {
    for (const p of g.db.all("planets.bySystem", { system_id: s["id"] })) {
      for (const m of g.db.all("moons.byPlanet", { planet_id: p["id"] })) {
        if (m["task_id"] === null || m["task_id"] === undefined) continue;
        moons.push(m); voyages.push(...g.db.all("voyages.byAssignment", { assignment_id: m["assignment_id"] }));
      }
    }
  }
  return { systems, moons, voyages, decisions: g.db.all("decisions.pending") };
}

export function events(g: Galaxy, opts: { since?: number; moon?: string }): EventRow[] {
  const rows = opts.moon ? g.db.all("events.byMoon", { moon_id: opts.moon }) : g.db.all("events.since", { id: opts.since ?? 0 });
  const out = rows.map(rowToEvent);
  return opts.moon && opts.since !== undefined ? out.filter((e) => e.id > opts.since!) : out;
}

export function fleet(g: Galaxy): Row[] { return g.db.all("ships.all"); }
