import type { Reducer } from "../events.js";
import type { GeneratedPlanet } from "../../core/bodies.js";
export const planetReducers: Record<string, Reducer> = {
  "planet.discovered": (db, ev) => {
    const { planet } = ev.payload as { planet: GeneratedPlanet };
    db.run("planets.insertBarren", { id: `${ev.system_id}/${planet.name}`, system_id: ev.system_id!, name: planet.name, orbit_index: planet.orbit_index, kind: planet.kind, last_event_id: ev.id });
  },
};
