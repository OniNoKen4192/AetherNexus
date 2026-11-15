import type { ShipClass, ShipRow } from "../../core/fleet.js";
import { dependencyState } from "../commands/deps.js";
import { availableActions } from "../commands/query.js";
import { loadMoon } from "../dispatch.js";
import type { Galaxy } from "../galaxy.js";

export type Rung = "manual" | "verdicts" | "roundabout";

/** highways and autopilot behave as roundabout until their slices land. Anything unrecognised is manual. */
export function effectiveRung(level: string): Rung {
  if (level === "verdicts") return "verdicts";
  if (level === "roundabout" || level === "highways" || level === "autopilot") return "roundabout";
  return "manual";
}

export type PlannedAction = {
  action: "dock" | "park_stale" | "inspect" | "launch";
  taskId: string;
  /** true when this would be the first freighter sent to the moon under its current assignment */
  first: boolean;
};

export type PlanCtx = {
  ownPid: number;
  tracks?: (voyageId: string) => boolean;
  /** task ids that already have a scheduler action running; never planned */
  busy?: ReadonlySet<string>;
  /** plan as if at this rung; default effectiveRung(g.config.automation.level) */
  rung?: Rung;
};

type Candidate = PlannedAction & { assignmentId: number };

const group = (candidate: Candidate): number => {
  if (candidate.action === "dock") return 0;
  if (candidate.action === "park_stale") return 1;
  if (candidate.action === "inspect") return 2;
  return candidate.first ? 4 : 3;
};

export function plan(g: Galaxy, ctx: PlanCtx): PlannedAction[] {
  const rung = ctx.rung ?? effectiveRung(g.config.automation.level);
  if (rung === "manual") return [];

  const candidates: Candidate[] = [];
  for (const system of g.db.all("systems.all")) {
    for (const planet of g.db.all("planets.bySystem", { system_id: system["id"] })) {
      for (const row of g.db.all("moons.byPlanet", { planet_id: planet["id"] })) {
        if (typeof row["task_id"] !== "string" || ctx.busy?.has(row["task_id"])) continue;
        const taskId = row["task_id"];
        const moon = loadMoon(g, taskId);
        const actions = availableActions(g, taskId, { ownPid: ctx.ownPid, ...(ctx.tracks ? { tracks: ctx.tracks } : {}) });
        let action: PlannedAction["action"] | undefined;
        let first = false;

        if (actions.includes("dock") && moon.status === "reviewing") action = "dock";
        else if (actions.includes("park_stale") && (moon.status === "implementing" || moon.status === "reviewing")) action = "park_stale";
        else if (actions.includes("inspect") && moon.status === "audited") action = "inspect";
        else if (actions.includes("launch")) {
          const dependencies = dependencyState(g, taskId);
          first = !dependencies.visited;
          if (moon.status === "audited") action = "launch";
          else if (moon.status === "adrift" || moon.status === "quarantined") {
            if (dependencies.visited || (rung === "roundabout" && dependencies.waitingOn.length === 0 && dependencies.waitingOnPlanets.length === 0)) action = "launch";
          } else if ((moon.status === "emitted" || moon.status === "gated") && rung === "roundabout"
            && dependencies.waitingOn.length === 0 && dependencies.waitingOnPlanets.length === 0) action = "launch";
        }

        if (action) candidates.push({ action, taskId, first: action === "launch" && first, assignmentId: moon.assignment_id });
      }
    }
  }

  candidates.sort((a, b) => group(a) - group(b) || a.assignmentId - b.assignmentId);

  const inFlight = g.db.all<{ provider: string }>("voyages.inFlight");
  let free = g.config.scheduler.max_concurrent_ships - inFlight.length;
  const providerUse = new Map<string, number>();
  for (const voyage of inFlight) providerUse.set(voyage.provider, (providerUse.get(voyage.provider) ?? 0) + 1);
  const ships = g.db.all<ShipRow>("ships.all");
  const claimed = new Set<string>();
  const out: PlannedAction[] = [];

  for (const candidate of candidates) {
    if (candidate.action !== "launch" && candidate.action !== "inspect") {
      out.push({ action: candidate.action, taskId: candidate.taskId, first: candidate.first });
      continue;
    }
    if (free <= 0) continue;

    const providers = candidate.action === "launch" ? g.config.roles.implement : g.config.roles.review;
    const shipClass: ShipClass = candidate.action === "launch" ? "freighter" : "customs";
    let selectedProvider: string | undefined;
    let selectedShip: ShipRow | undefined;
    for (const provider of providers) {
      if (!(provider in g.adapters)) continue;
      const limit = g.config.scheduler.per_provider_max[provider];
      if (limit !== undefined && (providerUse.get(provider) ?? 0) >= limit) continue;
      const ship = ships.find((item) => item.fleet === provider && item.class === shipClass && item.status === "idle" && !claimed.has(item.id));
      if (!ship) continue;
      selectedProvider = provider;
      selectedShip = ship;
      break;
    }
    if (!selectedProvider || !selectedShip) continue;

    free--;
    providerUse.set(selectedProvider, (providerUse.get(selectedProvider) ?? 0) + 1);
    claimed.add(selectedShip.id);
    out.push({ action: candidate.action, taskId: candidate.taskId, first: candidate.first });
  }

  return out;
}
