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
import { repliedSincePark } from "./launch.js";
import { showSystem } from "./system.js";

export type Owner = "server" | "other" | "stale";
export type SpecEntry = { path: string; taskId: string | null; touch: string[]; error: string | null };
export type Failure = { ts: string; taskId: string; voyageId: string | null; message: string };
export type Action = "launch" | "inspect" | "dock" | "reply" | "drop" | "park_stale" | "cancel" | "answer";
export type Snapshot = {
  cursor: number; repo: string; rung: string;
  limits: { max_concurrent_ships: number; per_provider_max: Record<string, number>; in_flight: number };
  roles: { implement: string[]; review: string[] };
  systems: (Row & { planets: (Row & { moons: Row[] })[] })[];
  voyages: (Row & { owner: Owner | null })[];
  fleet: Row[]; decisions: Row[]; specs: SpecEntry[]; failures: Failure[];
};
export type MoonDetail = {
  moon: Row; spec: string | null;
  voyages: (Row & { owner: Owner | null })[];
  verdicts: Row[]; events: EventRow[]; decisions: Row[]; actions: Action[];
};

type OwnerCtx = { ownPid: number; tracks?: (voyageId: string) => boolean };

function voyageOwner(g: Galaxy, voyage: Row, ctx: OwnerCtx): Owner | null {
  if (voyage["status"] !== "launched" && voyage["status"] !== "working") return null;
  const launched = g.db.all("events.byAssignment", { assignment_id: voyage["assignment_id"] }).map(rowToEvent)
    .find((e) => e.kind === "voyage.launched" && e.voyage_id === voyage["id"]);
  const ownerPid = launched?.payload["owner_pid"];
  if (ownerPid === ctx.ownPid) return ctx.tracks && !ctx.tracks(String(voyage["id"])) ? "stale" : "server";
  return typeof ownerPid === "number" && pidAlive(ownerPid) ? "other" : "stale";
}

function withOwner(g: Galaxy, voyages: Row[], ctx: OwnerCtx): (Row & { owner: Owner | null })[] {
  return voyages.map((v) => ({ ...v, owner: voyageOwner(g, v, ctx) }));
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

export function snapshot(g: Galaxy, ctx: OwnerCtx & { failures: Failure[] }): Snapshot {
  const cursor = g.db.get<{ id: number }>("events.maxId")?.id ?? 0;
  const systems = g.db.all("systems.all").map((s) => {
    const shown = showSystem(g, String(s["id"]));
    return { ...shown.system, planets: shown.planets };
  });
  const assigned = new Set<string>(); const rawVoyages: Row[] = [];
  for (const system of systems) for (const planet of system.planets) for (const moon of planet.moons) {
    if (typeof moon["task_id"] !== "string" || typeof moon["assignment_id"] !== "number") continue;
    assigned.add(moon["task_id"]); rawVoyages.push(...g.db.all("voyages.byAssignment", { assignment_id: moon["assignment_id"] }));
  }
  const inFlight = g.db.all("voyages.inFlight");
  return {
    cursor, repo: path.basename(g.repoRoot), rung: g.config.automation.level,
    limits: { max_concurrent_ships: g.config.scheduler.max_concurrent_ships, per_provider_max: g.config.scheduler.per_provider_max, in_flight: inFlight.length },
    roles: { implement: g.config.roles.implement, review: g.config.roles.review }, systems,
    voyages: withOwner(g, rawVoyages, ctx), fleet: g.db.all("ships.all"), decisions: g.db.all("decisions.pending"),
    specs: specEntries(g, assigned), failures: ctx.failures,
  };
}

export function availableActions(g: Galaxy, taskId: string, ctx: OwnerCtx): Action[] {
  const moon = loadMoon(g, taskId);
  if (pendingTreeDecision(g, taskId)) return ["answer", ...((moon.status === "adrift" || moon.status === "quarantined") ? ["drop" as const] : [])];
  if (moon.status === "emitted" || moon.status === "gated") return ["launch"];
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
    return verdict === "FIX" ? ["launch"] : [];
  }
  if (moon.status === "reviewing" && verdict === "APPROVE") {
    const implement = g.db.get<Row>("voyages.latestByAssignmentRole", { assignment_id: moon.assignment_id, role: "implement" });
    if (implement?.["status"] === "cleared" || implement?.["status"] === "en_route" || implement?.["status"] === "docked") return ["dock"];
  }
  if (moon.status === "adrift" || moon.status === "quarantined") {
    return ["reply", "drop", ...(repliedSincePark(g, moon.assignment_id) ? ["launch" as const] : [])];
  }
  return [];
}

export function moonDetail(g: Galaxy, taskId: string, ctx: OwnerCtx): MoonDetail {
  const moon = loadMoon(g, taskId);
  let spec: string | null;
  try { spec = fs.readFileSync(path.join(g.repoRoot, moon.spec_path), "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; spec = null; }
  const events = g.db.all("events.byAssignment", { assignment_id: moon.assignment_id }).map(rowToEvent);
  return {
    moon: moon as unknown as Row, spec,
    voyages: withOwner(g, g.db.all("voyages.byAssignment", { assignment_id: moon.assignment_id }), ctx),
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

export function fleet(g: Galaxy): Row[] { return g.db.all("ships.all"); }
