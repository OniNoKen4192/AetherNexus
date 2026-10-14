import type { Reducer } from "../events.js";
import type { GeneratedMoon } from "../../core/bodies.js";
export const moonReducers: Record<string, Reducer> = {
  "moon.discovered": (db, ev) => {
    const { moon } = ev.payload as { moon: GeneratedMoon };
    db.run("moons.insertBarren", { id: `${ev.planet_id}/${moon.name}`, planet_id: ev.planet_id!, name: moon.name, orbit_index: moon.orbit_index, last_event_id: ev.id });
  },
};
