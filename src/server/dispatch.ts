import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { append, type NexusEvent } from "../db/events.js";
import { pickIdleShip, type ShipClass } from "../core/fleet.js";
import type { AgentEvent, Job, Role } from "../providers/adapter.js";
import { Refusal } from "./errors.js";
import type { Galaxy } from "./galaxy.js";

export type MoonRow = {
  id: string; planet_id: string; task_id: string; status: string | null; round: number;
  spec_path: string; spec_sha: string; park_reason: string | null; tier: string | null;
};
export type PlanetRow = { id: string; system_id: string; branch: string | null; worktree: string | null };
export type DispatchOutcome = {
  voyageId: string; shipId: string; events: number;
  done?: AgentEvent & { kind: "done" }; error?: AgentEvent & { kind: "error" }; threw?: string;
  /** Set when runVoyage itself parked the voyage (adrift): the reason recorded on the moon. */
  parkReason?: string;
};
export type VoyageInput = {
  role: Role; taskId: string; provider: string; worktree: string;
  job: Omit<Job, "voyageId">; onEvent?: (e: AgentEvent) => void; timeoutMs?: number;
};

const PROMPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "prompts");
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export function promptPath(name: string): string { return path.join(PROMPTS_DIR, name); }

/** Replace {{name}} with vars[name] in one pass (substituted text is never re-scanned). Unknown names throw. */
export function renderPrompt(templatePath: string, vars: Record<string, string>): string {
  const text = fs.readFileSync(templatePath, "utf8").replaceAll("\r\n", "\n");
  return text.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) throw new Error(`prompt template ${path.basename(templatePath)}: unknown variable '{{${name}}}'`);
    return vars[name]!;
  });
}

export function loadMoon(g: Galaxy, taskId: string): MoonRow {
  const moon = g.db.get<MoonRow>("moons.byTask", { task_id: taskId });
  if (!moon) throw new Refusal(`no moon is assigned task '${taskId}'`);
  return moon;
}
export function loadPlanet(g: Galaxy, moon: MoonRow): PlanetRow {
  const planet = g.db.get<PlanetRow>("planets.byId", { id: moon.planet_id });
  if (!planet) throw new Refusal(`planet '${moon.planet_id}' does not exist`);
  return planet;
}
/** Event envelope ids for everything that belongs to a moon. */
export function moonScope(g: Galaxy, moon: MoonRow): Pick<NexusEvent, "system_id" | "planet_id" | "moon_id"> {
  return { system_id: loadPlanet(g, moon).system_id, planet_id: moon.planet_id, moon_id: moon.id };
}

export const shipClassFor = (role: Role): ShipClass => (role === "implement" ? "freighter" : "customs");
export const shipsNoun = (cls: ShipClass): string => (cls === "customs" ? "customs" : `${cls}s`);

/** Park sequence: voyage, ship, moon, then a pending decision. Each is its own transaction, so a crash leaves a visible, finishable park. */
export function parkVoyage(g: Galaxy, p: { taskId: string; voyageId: string; shipId: string; reason: string; details?: string }): void {
  const moon = loadMoon(g, p.taskId); const scope = moonScope(g, moon);
  append(g.db, { kind: "voyage.adrift", ...scope, voyage_id: p.voyageId, ship_id: p.shipId, payload: { reason: p.reason, ...(p.details !== undefined ? { details: p.details } : {}) } });
  append(g.db, { kind: "ship.adrift", ...scope, voyage_id: p.voyageId, ship_id: p.shipId, payload: { voyage_id: p.voyageId, outcome: "adrift" } });
  append(g.db, { kind: "moon.adrift", ...scope, voyage_id: p.voyageId, payload: { reason: p.reason } });
  append(g.db, {
    kind: "decision.opened", ...scope,
    payload: { kind: "adrift", target_kind: "moon", target_id: p.taskId, reasoning: `voyage ${p.voyageId} parked: ${p.reason}${p.details ? ` — ${p.details}` : ""}` },
  });
}

export async function runVoyage(g: Galaxy, input: VoyageInput): Promise<DispatchOutcome> {
  const moon = loadMoon(g, input.taskId); const scope = moonScope(g, moon);
  const adapter = g.adapters[input.provider];
  if (!adapter) throw new Refusal(`provider '${input.provider}' is not configured`);
  const cls = shipClassFor(input.role);
  const ship = pickIdleShip(g.db, cls, input.provider);
  if (!ship) throw new Refusal(`all ${shipsNoun(cls)} in fleet '${input.provider}' are assigned`);
  const voyageId = `${ship.id}/${input.taskId}/${input.role}/${input.job.round}`;
  const model = input.role === "implement" && moon.tier ? g.config.providers[input.provider]?.models?.[moon.tier] : undefined;

  append(g.db, { kind: "ship.assigned", ...scope, voyage_id: voyageId, ship_id: ship.id, provider: input.provider, payload: { voyage_id: voyageId } }, () => {
    const cur = g.db.get<{ status: string }>("ships.byId", { id: ship.id });
    if (cur?.status !== "idle") throw new Refusal(`ship ${ship.id} is no longer idle`);
  });
  append(g.db, {
    kind: "voyage.launched", ...scope, voyage_id: voyageId, ship_id: ship.id, provider: input.provider,
    payload: { role: input.role, round: input.job.round, provider: input.provider, ...(model ? { model } : {}), ship_id: ship.id, worktree: input.worktree },
  });

  const out: DispatchOutcome = { voyageId, shipId: ship.id, events: 0 };
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let cost: number | undefined;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const logEvent = (e: AgentEvent): void => { append(g.db, { kind: "voyage.event", ...scope, voyage_id: voyageId, ship_id: ship.id, payload: { event: e } }); };
  // Every git command issued while the voyage is in flight becomes a tool_use event on it.
  g.git.setLog((entry) => {
    try { logEvent({ kind: "tool_use", ts: new Date().toISOString(), data: { name: "git", input: entry.args } }); } catch { /* logging must never break git */ }
  });
  try {
    for await (const e of adapter.dispatch({ ...input.job, voyageId }, { cwd: input.worktree, touch: [], timeoutMs, signal: ac.signal })) {
      out.events++; logEvent(e); input.onEvent?.(e);
      if (e.kind === "usage" && e.data.cost_usd !== undefined) cost = (cost ?? 0) + e.data.cost_usd;
      if (e.kind === "done") out.done = e;
      if (e.kind === "error") out.error = e;
    }
  } catch (err) {
    out.threw = err instanceof Error ? err.message : String(err);
    const c = adapter.classify(err);
    out.parkReason = c === "unknown" ? "backend_failure" : c;
  } finally {
    clearTimeout(timer); g.git.setLog(null);
  }

  if (out.done) {
    const d = out.done.data;
    append(g.db, {
      kind: "voyage.returned", ...scope, voyage_id: voyageId, ship_id: ship.id,
      payload: { role: input.role, report: d.report, ...(d.session_id ? { session_id: d.session_id } : {}), ...(cost !== undefined ? { cost } : {}) },
    });
    delete out.parkReason;
    return out;
  }
  const reason = out.parkReason ?? (out.error ? (out.error.data.classification === "unknown" ? "backend_failure" : out.error.data.classification) : "backend_failure");
  const details = out.threw ?? out.error?.data.message ?? "the stream ended without a result";
  out.parkReason = reason;
  parkVoyage(g, { taskId: input.taskId, voyageId, shipId: ship.id, reason, details });
  return out;
}
