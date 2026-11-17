import type { Role } from "../../providers/adapter.js";
import { append } from "../../db/events.js";
import { loadMoon, moonScope, parkVoyage } from "../dispatch.js";
import type { Galaxy } from "../galaxy.js";
import { poolReadings } from "./pool.js";

type EndOutOfFuelParams = {
  taskId: string;
  voyageId: string;
  shipId: string;
  role: Role;
  provider: string;
  model?: string;
  resetsAt?: string;
  modelFamily?: string;
  details: string;
};

function parsedDate(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function endOutOfFuel(g: Galaxy, p: EndOutOfFuelParams): { parked: boolean; until: string } {
  const now = g.now();
  const requestedReset = parsedDate(p.resetsAt);
  const readingResets = poolReadings(g, p.provider)
    .map((reading) => parsedDate(reading.resets_at))
    .filter((value): value is number => value !== undefined);
  const reset = requestedReset ?? (readingResets.length > 0 ? Math.min(...readingResets) : now + 30 * 60 * 1000);
  const until = new Date(Math.max(reset, now + 60 * 1000)).toISOString();
  const ts = new Date(now).toISOString();
  const moon = loadMoon(g, p.taskId);
  const scope = moonScope(g, moon);

  append(g.db, {
    kind: "fuel.exhausted", ...scope, voyage_id: p.voyageId, provider: p.provider, ts,
    payload: { until, voyage_id: p.voyageId, ...(p.modelFamily ? { model_family: p.modelFamily } : {}) },
  });

  const previous = g.db.all<{ id: string; role: string; provider: string }>("voyages.byAssignment", { assignment_id: moon.assignment_id })
    .filter((voyage) => voyage.id !== p.voyageId && voyage.role === p.role && voyage.provider === p.provider)
    .at(-1);
  const secondHit = previous !== undefined && g.db.all<{ kind: string; voyage_id: string | null }>("events.byAssignment", { assignment_id: moon.assignment_id })
    .some((event) => event.kind === "voyage.out_of_fuel" && event.voyage_id === previous.id);
  if (secondHit) {
    parkVoyage(g, { taskId: p.taskId, voyageId: p.voyageId, shipId: p.shipId, reason: "rate_limited", details: p.details });
    return { parked: true, until };
  }

  append(g.db, {
    kind: "voyage.out_of_fuel", ...scope, voyage_id: p.voyageId, ship_id: p.shipId, ts,
    payload: { reason: "out_of_fuel", details: p.details },
  });
  append(g.db, {
    kind: "ship.released", ...scope, voyage_id: p.voyageId, ship_id: p.shipId, ts,
    payload: { voyage_id: p.voyageId, outcome: "out_of_fuel" },
  });
  append(g.db, {
    kind: p.role === "implement" ? "moon.awaiting_pickup" : "moon.review_abandoned", ...scope, ts, payload: {},
  });
  return { parked: false, until };
}
