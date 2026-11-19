import type { Role } from "../../providers/adapter.js";
import { dependencyState } from "../commands/deps.js";
import { availableActions } from "../commands/query.js";
import { loadMoon } from "../dispatch.js";
import type { Galaxy } from "../galaxy.js";
import { chooseProvider, type Capacity } from "../limiter/limiter.js";

export type Rung = "manual" | "verdicts" | "roundabout";

/** highways and autopilot behave as roundabout until their slices land. Anything unrecognised is manual. */
export function effectiveRung(level: string): Rung {
  if (level === "verdicts") return "verdicts";
  if (level === "roundabout" || level === "highways" || level === "autopilot") return "roundabout";
  return "manual";
}

export type PlannedAction = {
  action: "dock" | "park_stale" | "inspect" | "send";
  taskId: string;
  /** true when this would be the first freighter sent to the moon under its current assignment */
  first: boolean;
  /** Present only when the limiter sent the ship somewhere other than a plain flight: a reroute or a refuel. */
  provider?: string;
  /** Present only on a refuel: the cheaper model the freighter flies. */
  model?: string;
  /** Present (true) only on a refuel. */
  refuel?: true;
};

export type Hold = { taskId: string; role: Role; provider: string; reason: "dry" | "low"; until?: string };

export type PlanCtx = {
  ownPid: number;
  tracks?: (voyageId: string) => boolean;
  /** task ids that already have a scheduler action running; never planned */
  busy?: ReadonlySet<string>;
  /** plan as if at this rung; default effectiveRung(g.config.automation.level) */
  rung?: Rung;
};

type Candidate = PlannedAction & { assignmentId: number; tier: string | null };

const group = (candidate: Candidate): number => {
  if (candidate.action === "dock") return 0;
  if (candidate.action === "park_stale") return 1;
  if (candidate.action === "inspect") return 2;
  return candidate.first ? 4 : 3;
};

export function planWithHolds(g: Galaxy, ctx: PlanCtx): { actions: PlannedAction[]; holds: Hold[] } {
  const rung = ctx.rung ?? effectiveRung(g.config.automation.level);
  if (rung === "manual") return { actions: [], holds: [] };

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
        else if (actions.includes("send")) {
          if (moon.status === "awaiting_pickup") action = "send";
          else {
            const dependencies = dependencyState(g, taskId);
            first = !dependencies.visited;
            if (moon.status === "audited") action = "send";
            else if (moon.status === "adrift" || moon.status === "quarantined") {
              if (dependencies.visited || (rung === "roundabout" && dependencies.waitingOn.length === 0 && dependencies.waitingOnPlanets.length === 0)) action = "send";
            } else if ((moon.status === "emitted" || moon.status === "gated") && rung === "roundabout"
              && dependencies.waitingOn.length === 0 && dependencies.waitingOnPlanets.length === 0) action = "send";
          }
        }

        if (action) candidates.push({ action, taskId, first: action === "send" && first, assignmentId: moon.assignment_id, tier: moon.tier });
      }
    }
  }

  candidates.sort((a, b) => group(a) - group(b) || a.assignmentId - b.assignmentId);

  const inFlight = g.db.all<{ provider: string }>("voyages.inFlight");
  const providerUse = new Map<string, number>();
  for (const voyage of inFlight) providerUse.set(voyage.provider, (providerUse.get(voyage.provider) ?? 0) + 1);
  const capacity: Capacity = {
    free: g.config.scheduler.max_concurrent_ships - inFlight.length,
    providerUse,
    claimed: new Set<string>(),
  };
  const actions: PlannedAction[] = [];
  const holds: Hold[] = [];

  for (const candidate of candidates) {
    if (candidate.action !== "send" && candidate.action !== "inspect") {
      actions.push({ action: candidate.action, taskId: candidate.taskId, first: candidate.first });
      continue;
    }
    const role: Role = candidate.action === "send" ? "implement" : "review";
    const choice = chooseProvider(g, { role, tier: candidate.tier, mayRefuel: true, capacity });
    if (choice.kind === "held") {
      holds.push({ taskId: candidate.taskId, role, provider: choice.provider, reason: choice.reason,
        ...(choice.until !== undefined ? { until: choice.until } : {}) });
      continue;
    }
    if (choice.kind !== "fly") continue;

    const planned: PlannedAction = { action: candidate.action, taskId: candidate.taskId, first: candidate.first };
    if (choice.refuelFor) {
      planned.provider = choice.provider;
      planned.model = choice.model!;
      planned.refuel = true;
    } else if (choice.reroutedFrom) planned.provider = choice.provider;
    actions.push(planned);
  }

  return { actions, holds };
}

export function plan(g: Galaxy, ctx: PlanCtx): PlannedAction[] {
  return planWithHolds(g, ctx).actions;
}
