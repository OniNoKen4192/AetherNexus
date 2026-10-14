import type { Reducer } from "../events.js";
import type { GeneratedPlanet } from "../../core/bodies.js";
export const systemReducers: Record<string, Reducer> = {
  "system.created": (db, ev) => {
    const p = ev.payload as { kind: string; title: string; brief: string; base_sha: string; integration_branch: string; seed: number; theme: string; planets: GeneratedPlanet[] };
    db.run("systems.insert", { id: ev.system_id!, kind: p.kind, title: p.title, brief: p.brief, base_sha: p.base_sha, integration_branch: p.integration_branch, seed: p.seed, theme: p.theme, created_ts: ev.ts, last_event_id: ev.id });
    for (const planet of p.planets) {
      const planetId = `${ev.system_id}/${planet.name}`;
      db.run("planets.insertBarren", { id: planetId, system_id: ev.system_id!, name: planet.name, orbit_index: planet.orbit_index, kind: planet.kind, last_event_id: ev.id });
      for (const moon of planet.moons) db.run("moons.insertBarren", { id: `${planetId}/${moon.name}`, planet_id: planetId, name: moon.name, orbit_index: moon.orbit_index, last_event_id: ev.id });
    }
  },
};
