import fs from "node:fs";
import path from "node:path";
import { rowToEvent, type EventRow } from "../../db/events.js";
import type { Row } from "../../db/open.js";
import { parseSpec } from "../../validate/spec.js";
import { loadMoon } from "../dispatch.js";
import type { Galaxy } from "../galaxy.js";
import { Refusal } from "../errors.js";
import { pidAlive } from "../lock.js";
import { pendingTreeDecision } from "./decision.js";
import { dependencyState } from "./deps.js";
import { repliedSincePark } from "./delivery.js";
import { showSystem } from "./system.js";
import { fuelHold } from "../limiter/limiter.js";
import { poolReadings, poolState } from "../limiter/pool.js";
import { PLAIN_FORMATION } from "../../core/catalogue/builtin.js";
import type { ShipFormation } from "../../core/catalogue/types.js";

export type Owner = "server" | "other" | "stale";
export type SpecEntry = { path: string; taskId: string | null; touch: string[]; error: string | null };
export type Failure = { ts: string; taskId: string; voyageId: string | null; message: string };
export type Action = "send" | "inspect" | "dock" | "reply" | "cancel_delivery" | "park_stale" | "cancel" | "answer";
export type PoolView = {
  provider: string; kind: string; state: "dry" | "free" | "low" | "ok" | "unknown";
  remaining?: number; resets_at?: string; until?: string; reading_ts?: string;
  reserve_floor: number;
  refuel?: { provider: string; models: Record<string, string> };
  windows: { window: string; used: number; resets_at?: string; model_family?: string; ts: string }[];
};
export type FuelWait = { provider: string; reason: string; until?: string };
export type RefuelOffer = { provider: string; model: string };
type FuelFields = { waiting_on_fuel: FuelWait | null; can_refuel: RefuelOffer | null };
/** A ship as every read shows it: the row, with `formation` parsed. */
export type ShipView = Row & { formation: ShipFormation };
/** What a voyage row says about its ship. */
export type VoyageShip = { name: string; faction: string; weight: string; formation_name: string };
type VoyageView = Row & { owner: Owner | null; refuel_for: string | null; cargo: { id: string; label: string } | null; ship: VoyageShip | null };
export type Snapshot = {
  cursor: number; repo: string; rung: string;
  /** First deliveries that would be sent right now if the rung were roundabout; 0 when the caller did not supply it. */
  ready_to_send: number;
  limits: { max_concurrent_ships: number; per_provider_max: Record<string, number>; in_flight: number };
  roles: { implement: string[]; review: string[] };
  systems: (Row & { planets: (Row & { moons: (Row | (Row & FuelFields))[] })[] })[];
  pools: PoolView[];
  /** The catalogue's weights, lightest first: the order the page lists ships in. */
  weights: string[];
  voyages: VoyageView[];
  fleet: ShipView[]; decisions: Row[]; specs: SpecEntry[]; failures: Failure[];
};
export type MoonDetail = {
  moon: Row & FuelFields; spec: string | null;
  voyages: VoyageView[];
  verdicts: Row[]; events: EventRow[]; decisions: Row[]; actions: Action[];
};

type OwnerCtx = { ownPid: number; tracks?: (voyageId: string) => boolean; assignmentEvents?: EventRow[] };

function ownerFromLaunch(voyage: Row, launched: EventRow | undefined, ctx: OwnerCtx): Owner | null {
  if (voyage["status"] !== "launched" && voyage["status"] !== "working") return null;
  const ownerPid = launched?.payload["owner_pid"];
  if (ownerPid === ctx.ownPid) return ctx.tracks && !ctx.tracks(String(voyage["id"])) ? "stale" : "server";
  return typeof ownerPid === "number" && pidAlive(ownerPid) ? "other" : "stale";
}

function voyageOwner(g: Galaxy, voyage: Row, ctx: OwnerCtx): Owner | null {
  const launched = (ctx.assignmentEvents ?? g.db.all("events.byAssignment", { assignment_id: voyage["assignment_id"] }).map(rowToEvent))
    .find((e) => e.kind === "voyage.launched" && e.voyage_id === voyage["id"]);
  return ownerFromLaunch(voyage, launched, ctx);
}

function formation(value: unknown): ShipFormation {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (parsed !== null && typeof parsed === "object" && typeof parsed.name === "string" && Array.isArray(parsed.vessels)) return parsed as ShipFormation;
  } catch { /* Bad stored JSON falls back to the plain formation. */ }
  return { ...PLAIN_FORMATION, vessels: PLAIN_FORMATION.vessels.map((vessel) => ({ ...vessel })) };
}

function shipViews(rows: Row[]): ShipView[] {
  return rows.map((ship) => ({ ...ship, formation: formation(ship["formation"]) }));
}

function cargo(value: unknown): { id: string; label: string } | null {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return parsed !== null && typeof parsed === "object" && typeof parsed.id === "string" && typeof parsed.label === "string"
      ? { id: parsed.id, label: parsed.label }
      : null;
  } catch { return null; }
}

function voyageRows(voyages: Row[], assignmentEvents: EventRow[], ctx: OwnerCtx, ships: Map<string, ShipView>): VoyageView[] {
  return voyages.map((voyage) => {
    const launched = assignmentEvents.find((event) => event.kind === "voyage.launched" && event.voyage_id === voyage["id"]);
    const refuelFor = launched?.payload["refuel_for"];
    const found = ships.get(String(voyage["ship_id"]));
    const ship = found === undefined ? null : { name: String(found["name"]), faction: String(found["faction"]), weight: String(found["weight"]), formation_name: found.formation.name };
    return { ...voyage, owner: ownerFromLaunch(voyage, launched, ctx), refuel_for: typeof refuelFor === "string" ? refuelFor : null, cargo: cargo(voyage["cargo"]), ship };
  });
}

function fuelFields(g: Galaxy, taskId: string, ctx: OwnerCtx): FuelFields {
  const actions = availableActions(g, taskId, ctx);
  const action = actions.includes("send") ? "send" : actions.includes("inspect") ? "inspect" : null;
  if (action === null) return { waiting_on_fuel: null, can_refuel: null };
  const hold = fuelHold(g, taskId, action);
  if (hold === null) return { waiting_on_fuel: null, can_refuel: null };
  return {
    waiting_on_fuel: { provider: hold.provider, reason: hold.reason, ...(hold.until !== undefined ? { until: hold.until } : {}) },
    can_refuel: hold.canRefuel ?? null,
  };
}

function pools(g: Galaxy): PoolView[] {
  const providers = [...new Set([...g.config.roles.implement, ...g.config.roles.review])];
  return providers.map((provider) => {
    const config = g.config.providers[provider]?.pool;
    const state = poolState(g, provider);
    return {
      provider, kind: config?.kind ?? "free", state: state.state,
      ...(state.state === "dry" ? { until: state.until } : {}),
      ...(state.state === "low" || state.state === "ok" ? {
        remaining: state.remaining, reading_ts: state.reading_ts,
        ...(state.resets_at !== undefined ? { resets_at: state.resets_at } : {}),
      } : {}),
      reserve_floor: config?.reserve_floor ?? 0,
      ...(config?.refuel ? { refuel: { provider: config.refuel.provider, models: config.refuel.models } } : {}),
      windows: poolReadings(g, provider),
    };
  });
}

function specEntries(g: Galaxy, assigned: Set<string>): SpecEntry[] {
  let names: string[];
  try { names = fs.readdirSync(g.paths.specs).filter((name) => name.endsWith(".md")).sort(); }
  catch { return []; }
  const out: SpecEntry[] = [];
  for (const name of names) {
    const abs = path.join(g.paths.specs, name);
    const rel = path.relative(g.repoRoot, abs).replaceAll("\\", "/");
    let taskId: string | null = null; let touch: string[] = []; let error: string | null = null;
    try {
      const parsed = parseSpec(fs.readFileSync(abs, "utf8"));
      taskId = parsed.taskId ?? null; touch = parsed.touch;
      if (!taskId) error = "spec has no Task ID";
      else if (touch.length === 0) error = "spec has an empty Touch list";
    } catch (e) {
      error = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").trim() || "spec could not be read or parsed";
    }
    if (taskId !== null && assigned.has(taskId)) continue;
    out.push({ path: rel, taskId, touch, error });
  }
  return out;
}

export function snapshot(g: Galaxy, ctx: OwnerCtx & { failures: Failure[]; readyToSend?: number }): Snapshot {
  const cursor = g.db.get<{ id: number }>("events.maxId")?.id ?? 0;
  const systems = g.db.all("systems.all").map((s) => {
    const shown = showSystem(g, String(s["id"]));
    return { ...shown.system, planets: shown.planets };
  });
  const fleet = shipViews(g.db.all("ships.all"));
  const ships = new Map(fleet.map((ship) => [String(ship["id"]), ship]));
  const assigned = new Set<string>(); const voyages: VoyageView[] = [];
  for (const system of systems) for (const planet of system.planets) for (const moon of planet.moons) {
    if (typeof moon["task_id"] !== "string" || typeof moon["assignment_id"] !== "number") continue;
    const dependencies = dependencyState(g, moon["task_id"]);
    moon["waiting_on"] = dependencies.visited ? [] : dependencies.waitingOn;
    moon["waiting_on_planets"] = dependencies.visited ? [] : dependencies.waitingOnPlanets;
    const assignmentEvents = g.db.all("events.byAssignment", { assignment_id: moon["assignment_id"] }).map(rowToEvent);
    Object.assign(moon, fuelFields(g, moon["task_id"], { ...ctx, assignmentEvents }));
    assigned.add(moon["task_id"]); voyages.push(...voyageRows(g.db.all("voyages.byAssignment", { assignment_id: moon["assignment_id"] }), assignmentEvents, ctx, ships));
  }
  const inFlight = g.db.all("voyages.inFlight");
  return {
    cursor, repo: path.basename(g.repoRoot), rung: g.config.automation.level, ready_to_send: ctx.readyToSend ?? 0,
    limits: { max_concurrent_ships: g.config.scheduler.max_concurrent_ships, per_provider_max: g.config.scheduler.per_provider_max, in_flight: inFlight.length },
    roles: { implement: g.config.roles.implement, review: g.config.roles.review }, systems, pools: pools(g), weights: [...g.catalogue.weights],
    voyages, fleet, decisions: g.db.all("decisions.pending"),
    specs: specEntries(g, assigned), failures: ctx.failures,
  };
}

export function availableActions(g: Galaxy, taskId: string, ctx: OwnerCtx): Action[] {
  const moon = loadMoon(g, taskId);
  if (pendingTreeDecision(g, taskId)) return ["answer", ...((moon.status === "adrift" || moon.status === "quarantined" || moon.status === "awaiting_pickup") ? ["cancel_delivery" as const] : [])];
  if (moon.status === "emitted" || moon.status === "gated") return ["send"];
  const voyages = g.db.all("voyages.byAssignment", { assignment_id: moon.assignment_id });
  if (moon.status === "implementing" || moon.status === "reviewing") {
    const flying = voyages.filter((v) => v["status"] === "launched" || v["status"] === "working").pop();
    if (flying) {
      const owner = voyageOwner(g, flying, ctx);
      return owner === "server" ? ["cancel"] : owner === "stale" ? ["park_stale"] : [];
    }
  }
  const verdicts = g.db.all("verdicts.byAssignment", { assignment_id: moon.assignment_id });
  const verdict = verdicts[verdicts.length - 1]?.["verdict"];
  if (moon.status === "audited") {
    const implement = g.db.get<Row>("voyages.latestByAssignmentRole", { assignment_id: moon.assignment_id, role: "implement" });
    if (implement?.["status"] === "holding") return ["inspect"];
    return verdict === "FIX" ? ["send"] : [];
  }
  if (moon.status === "reviewing" && verdict === "APPROVE") {
    const implement = g.db.get<Row>("voyages.latestByAssignmentRole", { assignment_id: moon.assignment_id, role: "implement" });
    if (implement?.["status"] === "cleared" || implement?.["status"] === "en_route" || implement?.["status"] === "docked") return ["dock"];
  }
  if (moon.status === "adrift" || moon.status === "quarantined") {
    return ["reply", "cancel_delivery", ...(repliedSincePark(g, moon.assignment_id) ? ["send" as const] : [])];
  }
  if (moon.status === "awaiting_pickup") return ["send", "cancel_delivery"];
  return [];
}

export function moonDetail(g: Galaxy, taskId: string, ctx: OwnerCtx): MoonDetail {
  const moon = loadMoon(g, taskId);
  const dependencies = dependencyState(g, taskId);
  let spec: string | null;
  try { spec = fs.readFileSync(path.join(g.repoRoot, moon.spec_path), "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; spec = null; }
  const events = g.db.all("events.byAssignment", { assignment_id: moon.assignment_id }).map(rowToEvent);
  const fuel = fuelFields(g, taskId, { ...ctx, assignmentEvents: events });
  const ships = new Map(shipViews(g.db.all("ships.all")).map((ship) => [String(ship["id"]), ship]));
  return {
    moon: { ...moon, waiting_on: dependencies.visited ? [] : dependencies.waitingOn, waiting_on_planets: dependencies.visited ? [] : dependencies.waitingOnPlanets, ...fuel }, spec,
    voyages: voyageRows(g.db.all("voyages.byAssignment", { assignment_id: moon.assignment_id }), events, ctx, ships),
    verdicts: g.db.all("verdicts.byAssignment", { assignment_id: moon.assignment_id }), events,
    decisions: g.db.all("decisions.pendingByTarget", { target_id: taskId }), actions: availableActions(g, taskId, ctx),
  };
}

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

export function fleet(g: Galaxy): ShipView[] { return shipViews(g.db.all("ships.all")); }
