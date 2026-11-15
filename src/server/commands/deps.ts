import { loadMoon } from "../dispatch.js";
import type { Galaxy } from "../galaxy.js";

export type DependencyState = {
  /** A freighter has been sent to this moon under its current assignment (an implement voyage exists). */
  visited: boolean;
  /** Task ids in the moon's depends_on that are not settled on the same planet. */
  waitingOn: string[];
  /** Stream ids in the planet's depends_on. In this slice every one of them counts as unmet. */
  waitingOnPlanets: string[];
};

type MoonDependencyRow = {
  task_id: string;
  planet_id: string;
  assignment_id: number;
  status: string | null;
  depends_on: string | null;
};

type PlanetDependencyRow = { depends_on: string | null };

function stringArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
}

export function dependencyState(g: Galaxy, taskId: string): DependencyState {
  const loaded = loadMoon(g, taskId);
  const moon = g.db.get<MoonDependencyRow>("moons.byTask", { task_id: taskId });
  if (!moon) throw new Error(`moon '${taskId}' disappeared after it was loaded`);

  const dependencies = stringArray(moon.depends_on);
  const settled = new Set(
    g.db.all<MoonDependencyRow>("moons.byPlanet", { planet_id: moon.planet_id })
      .filter((candidate) => candidate.status === "merged")
      .map((candidate) => candidate.task_id),
  );
  const planet = g.db.get<PlanetDependencyRow>("planets.byId", { id: moon.planet_id });
  const visited = g.db.get("voyages.latestByAssignmentRole", { assignment_id: loaded.assignment_id, role: "implement" }) !== undefined;

  return {
    visited,
    waitingOn: dependencies.filter((dependency) => !settled.has(dependency)),
    waitingOnPlanets: stringArray(planet?.depends_on ?? null),
  };
}
