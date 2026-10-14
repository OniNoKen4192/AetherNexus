import type { Reducer } from "../events.js";
import type { GeneratedPlanet } from "../../core/bodies.js";
export const planetReducers: Record<string, Reducer> = {
  "planet.discovered": (db, ev) => {
    const { planet } = ev.payload as { planet: GeneratedPlanet };
    db.run("planets.insertBarren", { id: `${ev.system_id}/${planet.name}`, system_id: ev.system_id!, name: planet.name, orbit_index: planet.orbit_index, kind: planet.kind, last_event_id: ev.id });
  },
  "planet.assigned": (db, ev) => {
    const p = ev.payload as { stream_id: string; mission: string; territory: string[]; depends_on: string[]; branch: string; worktree: string };
    db.run("planets.assign", { id: ev.planet_id!, stream_id: p.stream_id, mission: p.mission, territory: JSON.stringify(p.territory), depends_on: JSON.stringify(p.depends_on), branch: p.branch, worktree: p.worktree, last_event_id: ev.id });
  },
};
