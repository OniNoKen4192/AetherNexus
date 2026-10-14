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
  spec_path: string; spec_sha: string; park_reason: string | null; tier: string | null; touch?: string | null;
};
export type PlanetRow = { id: string; system_id: string; branch: string | null; worktree: string | null };
export type DispatchOutcome = {
  voyageId: string; shipId: string; events: number;
  done?: AgentEvent & { kind: "done" }; error?: AgentEvent & { kind: "error" }; threw?: string;
  /** Set when runVoyage itself parked the voyage (adrift): the reason recorded on the moon. */
  parkReason?: string;
};
export type VoyageInput = {
  role: Role; taskId: string; provider: string; worktree: string; touch: string[];
  job: Omit<Job, "voyageId">; onEvent?: (e: AgentEvent) => void; timeoutMs?: number;
  /** External abort (the CLI's SIGINT/SIGTERM handler): the voyage parks with reason 'interrupted'. */
  signal?: AbortSignal;
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
/** The moon's Touch list (JSON column). Fails closed: an unparseable or empty list is a Refusal. */
export function moonTouch(moon: MoonRow): string[] {
  let list: unknown;
  try { list = JSON.parse(moon.touch ?? "null"); } catch { list = null; }
  if (!Array.isArray(list) || list.length === 0 || !list.every((x) => typeof x === "string")) throw new Refusal(`moon ${moon.task_id} has no Touch list`);
  return list as string[];
}
export function loadPlanet(g: Galaxy, moon: MoonRow): PlanetRow {
  const planet = g.db.get<PlanetRow>("planets.byId", { id: moon.planet_id });
  if (!planet) throw new Refusal(`planet '${moon.planet_id}' does not exist`);
  return planet;
}
/** Event envelope ids for everything that belongs to a moon. */
export function moonScope(g: Galaxy, moon: MoonRow): Pick<NexusEvent, "system_id" | "planet_id" | "moon_id" | "task_id"> {
  return { system_id: loadPlanet(g, moon).system_id, planet_id: moon.planet_id, moon_id: moon.id, task_id: moon.task_id };
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

/** The human's tree as git sees it: HEAD plus every status path. A voyage must leave it exactly as it found it. */
function mainTreeSnapshot(g: Galaxy): { head: string; status: string[] } {
  return { head: g.git.headSha(g.repoRoot), status: g.git.statusPaths(g.repoRoot).sort() };
}

export async function runVoyage(g: Galaxy, input: VoyageInput): Promise<DispatchOutcome> {
  const moon = loadMoon(g, input.taskId); const scope = moonScope(g, moon);
  const adapter = g.adapters[input.provider];
  if (!adapter) throw new Refusal(`provider '${input.provider}' is not configured`);
  const cls = shipClassFor(input.role);
  const ship = pickIdleShip(g.db, cls, input.provider);
  if (!ship) throw new Refusal(`all ${shipsNoun(cls)} in fleet '${input.provider}' are assigned`);
  const baseId = `${ship.id}/${input.taskId}/${input.role}/${input.job.round}`;
  const model = input.role === "implement" && moon.tier ? g.config.providers[input.provider]?.models?.[moon.tier] : undefined;

  const before = mainTreeSnapshot(g); // before launch: if git fails here, nothing has been taken yet

  // One transaction: the voyage.launched reducer takes the ship, so a refused launch leaves it idle.
  const launched: NexusEvent = {
    kind: "voyage.launched", ...scope, voyage_id: baseId, ship_id: ship.id, provider: input.provider,
    payload: { role: input.role, round: input.job.round, provider: input.provider, ...(model ? { model } : {}), ship_id: ship.id, worktree: input.worktree },
  };
  append(g.db, launched, () => {
    const cur = g.db.get<{ status: string }>("ships.byId", { id: ship.id });
    if (cur?.status !== "idle") throw new Refusal(`ship ${ship.id} is no longer idle`);
    // A dropped-and-reassigned task restarts its rounds, so the readable id can repeat: suffix #2, #3, ...
    let id = baseId;
    for (let n = 2; g.db.get("voyages.byId", { id }); n++) id = `${baseId}#${n}`;
    launched.voyage_id = id;
  });
  const voyageId = launched.voyage_id!;

  const out: DispatchOutcome = { voyageId, shipId: ship.id, events: 0 };
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let cost: number | undefined;
  const ac = new AbortController();
  let abortCause: "timeout" | "interrupted" | undefined;
  const abortFor = (cause: "timeout" | "interrupted"): void => { if (!ac.signal.aborted) { abortCause = cause; ac.abort(); } };
  const timer = setTimeout(() => abortFor("timeout"), timeoutMs);
  const onExternalAbort = (): void => abortFor("interrupted");
  if (input.signal?.aborted) onExternalAbort(); else input.signal?.addEventListener("abort", onExternalAbort, { once: true });
  const logEvent = (e: AgentEvent): void => { append(g.db, { kind: "voyage.event", ...scope, voyage_id: voyageId, ship_id: ship.id, payload: { event: e } }); };
  // v0 is single-flight (the CLI blocks on one voyage; no daemon until v0.5), so one Galaxy-wide log hook is
  // attributable to exactly one voyage. Concurrent voyages need a per-voyage (AsyncLocalStorage-scoped) hook
  // before v0.5 enables them.
  // Every git command issued while the voyage is in flight becomes a tool_use event on it.
  g.git.setLog((entry) => {
    try { logEvent({ kind: "tool_use", ts: new Date().toISOString(), data: { name: "git", input: entry.args } }); } catch { /* logging must never break git */ }
  });
  try {
    for await (const e of adapter.dispatch({ ...input.job, voyageId }, { cwd: input.worktree, touch: input.touch, timeoutMs, signal: ac.signal })) {
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
    clearTimeout(timer); input.signal?.removeEventListener("abort", onExternalAbort); g.git.setLog(null);
  }

  // Someone else already parked this voyage (nexus moon park, for a process presumed dead): leave it as it is.
  const cur = g.db.get<{ status: string }>("voyages.byId", { id: voyageId });
  if (cur?.status !== "launched" && cur?.status !== "working") {
    delete out.done; out.parkReason = loadMoon(g, input.taskId).park_reason ?? "parked";
    return out;
  }

  // The Bash gap: a delegate's shell can reach outside its worktree. The human's tree must be exactly as it was.
  const after = mainTreeSnapshot(g);
  if (after.head !== before.head || JSON.stringify(after.status) !== JSON.stringify(before.status)) {
    const was = new Set(before.status), now = new Set(after.status);
    const details = JSON.stringify({ head_before: before.head, head_after: after.head, appeared: after.status.filter((p) => !was.has(p)), vanished: before.status.filter((p) => !now.has(p)) });
    delete out.done; out.parkReason = "main_tree_modified";
    parkVoyage(g, { taskId: input.taskId, voyageId, shipId: ship.id, reason: "main_tree_modified", details });
    return out;
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
  const reason = abortCause ?? out.parkReason ?? (out.error ? (out.error.data.classification === "unknown" ? "backend_failure" : out.error.data.classification) : "backend_failure");
  const details = abortCause === "timeout" ? `no result within ${timeoutMs} ms`
    : abortCause === "interrupted" ? "the dispatching process was interrupted"
    : out.threw ?? out.error?.data.message ?? "the stream ended without a result";
  out.parkReason = reason;
  parkVoyage(g, { taskId: input.taskId, voyageId, shipId: ship.id, reason, details });
  return out;
}
