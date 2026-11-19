import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { append, rowToEvent, type NexusEvent } from "../db/events.js";
import { withGitLog, type GitLog } from "../core/git.js";
import { jobFor, pickIdleShip } from "../core/fleet.js";
import type { ShipJob } from "../core/catalogue/types.js";
import type { AgentEvent, Job, Role } from "../providers/adapter.js";
import { Refusal } from "./errors.js";
import type { Galaxy } from "./galaxy.js";
import { recordReading } from "./limiter/pool.js";
import { endOutOfFuel } from "./limiter/wall.js";

export type MoonRow = {
  id: string; planet_id: string; task_id: string; assignment_id: number; status: string | null; round: number;
  spec_path: string; spec_sha: string; park_reason: string | null; tier: string | null; touch?: string | null;
};
export type PlanetRow = { id: string; system_id: string; branch: string | null; worktree: string | null };
export type DispatchOutcome = {
  voyageId: string; shipId: string; events: number;
  done?: AgentEvent & { kind: "done" }; error?: AgentEvent & { kind: "error" }; threw?: string;
  /** Set when runVoyage itself ended the voyage without a result: the park reason recorded on the moon, or "out_of_fuel" when the ship hit the wall and the cargo awaits pickup (no park). */
  parkReason?: string;
};
export type VoyageInput = {
  role: Role; taskId: string; provider: string; worktree: string; touch: string[];
  job: Omit<Job, "voyageId">; onEvent?: (e: AgentEvent) => void; timeoutMs?: number;
  /** External abort (the CLI's SIGINT/SIGTERM handler): the voyage parks with reason 'interrupted'. */
  signal?: AbortSignal;
  /** Called once, synchronously, right after the voyage.launched append, with the new voyage id. */
  onLaunched?: (voyageId: string) => void;
  /** Fly this model instead of the provider's default (a refuel). Only an explicit model is handed to the adapter. */
  model?: string;
  /** The provider whose pool this voyage is refuelling for; recorded on voyage.launched. */
  refuelFor?: string;
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
/** Event envelope ids for everything that belongs to a moon's current assignment. */
export function moonScope(g: Galaxy, moon: MoonRow): Pick<NexusEvent, "system_id" | "planet_id" | "moon_id" | "task_id" | "assignment_id"> {
  return { system_id: loadPlanet(g, moon).system_id, planet_id: moon.planet_id, moon_id: moon.id, task_id: moon.task_id, assignment_id: moon.assignment_id };
}

type InFlightRow = { provider: string };
/** True when the provider already has as many voyages in flight as scheduler.per_provider_max allows (false when unset). */
export function providerAtCap(g: Galaxy, provider: string): boolean {
  const max = g.config.scheduler.per_provider_max[provider];
  if (max === undefined) return false;
  return g.db.all<InFlightRow>("voyages.inFlight").filter((v) => v.provider === provider).length >= max;
}

/** Advisory early refusal with the same wording as the authoritative check in the voyage.launched transaction, so a cap wins over "no idle ship". */
export function refuseIfAtCap(g: Galaxy, provider: string): void {
  if (providerAtCap(g, provider)) throw new Refusal(`provider '${provider}' is at its limit of ${g.config.scheduler.per_provider_max[provider]} (scheduler.per_provider_max)`);
}

export const shipsNoun = (job: ShipJob): string => (job === "delivery" ? "freighters" : job);

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

/** Record, before the write, that the system is about to write these repo-relative paths into the main tree, so no voyage mistakes them for a foreign change. */
export function recordTreeWrite(g: Galaxy, paths: string[]): void {
  append(g.db, { kind: "tree.written", payload: { paths: paths.map((p) => p.replaceAll("\\", "/")) } });
}

/** The human's tree as git sees it: HEAD plus every status path. A voyage must leave it exactly as it found it. */
function mainTreeSnapshot(g: Galaxy): { head: string; status: string[] } {
  return { head: g.git.headSha(g.repoRoot), status: g.git.statusPaths(g.repoRoot).sort() };
}

export async function runVoyage(g: Galaxy, input: VoyageInput): Promise<DispatchOutcome> {
  const moon = loadMoon(g, input.taskId); const scope = moonScope(g, moon);
  const adapter = g.adapters[input.provider];
  if (!adapter) throw new Refusal(`provider '${input.provider}' is not configured`);
  const job = jobFor(input.role);
  refuseIfAtCap(g, input.provider);
  const ship = pickIdleShip(g.db, job, input.provider, "standard");
  if (!ship) throw new Refusal(`all ${shipsNoun(job)} in fleet '${input.provider}' are assigned`);
  const baseId = `${ship.id}/${input.taskId}/${input.role}/${input.job.round}`;
  const model = input.model ?? (input.role === "implement" && moon.tier ? g.config.providers[input.provider]?.models?.[moon.tier] : undefined);

  const before = mainTreeSnapshot(g); // before launch: if git fails here, nothing has been taken yet

  // One transaction: the voyage.launched reducer takes the ship, so a refused launch leaves it idle.
  const launched: NexusEvent = {
    kind: "voyage.launched", ...scope, voyage_id: baseId, ship_id: ship.id, provider: input.provider,
    payload: { role: input.role, round: input.job.round, provider: input.provider, ...(model ? { model } : {}), ...(input.refuelFor ? { refuel_for: input.refuelFor } : {}), ship_id: ship.id, worktree: input.worktree, owner_pid: process.pid },
  };
  const launchedRow = append(g.db, launched, () => {
    const cur = g.db.get<{ status: string }>("ships.byId", { id: ship.id });
    if (cur?.status !== "idle") throw new Refusal(`ship ${ship.id} is no longer idle`);
    // A dropped-and-reassigned task restarts its rounds, so the readable id can repeat: suffix #2, #3, ...
    let id = baseId;
    for (let n = 2; g.db.get("voyages.byId", { id }); n++) id = `${baseId}#${n}`;
    launched.voyage_id = id;
    // Scheduler limits are checked here, in the launch transaction, so they hold across processes sharing the file.
    const inFlight = g.db.all<InFlightRow>("voyages.inFlight");
    const total = g.config.scheduler.max_concurrent_ships;
    if (inFlight.length >= total) throw new Refusal(`${inFlight.length} ${inFlight.length === 1 ? "voyage" : "voyages"} in flight — the limit is ${total} (scheduler.max_concurrent_ships)`);
    const perProvider = g.config.scheduler.per_provider_max[input.provider];
    if (perProvider !== undefined && inFlight.filter((v) => v.provider === input.provider).length >= perProvider) {
      throw new Refusal(`provider '${input.provider}' is at its limit of ${perProvider} (scheduler.per_provider_max)`);
    }
  });
  const voyageId = launched.voyage_id!;
  // A throwing callback must not strand a launched voyage: report it and run on.
  try { input.onLaunched?.(voyageId); } catch (err) { process.stderr.write(`onLaunched callback threw for voyage ${voyageId}: ${err instanceof Error ? err.message : String(err)}
`); }

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
  // Every git command issued while the voyage is in flight becomes a tool_use event on it.
  const gitLog: GitLog = (entry) => {
    try { logEvent({ kind: "tool_use", ts: new Date().toISOString(), data: { name: "git", input: entry.args } }); } catch { /* logging must never break git */ }
  };
  try {
    await withGitLog(gitLog, async () => {
      for await (const e of adapter.dispatch({ ...input.job, voyageId, ...(input.model ? { model: input.model } : {}) }, { cwd: input.worktree, touch: input.touch, timeoutMs, signal: ac.signal })) {
        out.events++; logEvent(e); input.onEvent?.(e);
        if (e.kind === "usage" && e.data.cost_usd !== undefined) cost = (cost ?? 0) + e.data.cost_usd;
        if (e.kind === "fuel" && typeof e.data.window === "string" && typeof e.data.used === "number" && e.data.used >= 0 && e.data.used <= 1) {
          try { recordReading(g, { ...scope, voyage_id: voyageId, ship_id: ship.id }, input.provider, e.data); } catch { /* a reading must never break a voyage */ }
        }
        if (e.kind === "done") out.done = e;
        if (e.kind === "error") out.error = e;
      }
    });
  } catch (err) {
    out.threw = err instanceof Error ? err.message : String(err);
    const c = adapter.classify(err);
    out.parkReason = c === "unknown" ? "backend_failure" : c;
  } finally {
    clearTimeout(timer); input.signal?.removeEventListener("abort", onExternalAbort);
  }

  // Someone else already parked this voyage (nexus moon park, for a process presumed dead): leave it as it is.
  const cur = g.db.get<{ status: string }>("voyages.byId", { id: voyageId });
  if (cur?.status !== "launched" && cur?.status !== "working") {
    delete out.done; out.parkReason = loadMoon(g, input.taskId).park_reason ?? "parked";
    return out;
  }

  // The Bash gap: a delegate's shell can reach outside its worktree. Anything but the system's own recorded writes
  // opens a question for the human; the voyage carries on as if the tree were unchanged.
  const after = mainTreeSnapshot(g);
  const was = new Set(before.status), now = new Set(after.status);
  const own = new Set<string>();
  for (const row of g.db.all("events.kindSince", { kind: "tree.written", id: launchedRow.id })) {
    for (const p of (rowToEvent(row).payload["paths"] as string[] | undefined) ?? []) own.add(p);
  }
  const appeared = after.status.filter((p) => !was.has(p) && !own.has(p)), vanished = before.status.filter((p) => !now.has(p) && !own.has(p));
  if (after.head !== before.head || appeared.length > 0 || vanished.length > 0) {
    append(g.db, {
      kind: "decision.opened", ...scope,
      payload: { kind: "main_tree_changed", target_kind: "moon", target_id: input.taskId, reasoning: JSON.stringify({ voyage_id: voyageId, head_before: before.head, head_after: after.head, appeared, vanished }) },
    });
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
  // The provider's allowance ran out: nobody needs to look, the cargo waits for the pool to refill. An abort is not a wall hit.
  if (!abortCause && reason === "rate_limited") {
    const r = endOutOfFuel(g, {
      taskId: input.taskId, voyageId, shipId: ship.id, role: input.role, provider: input.provider, ...(model ? { model } : {}),
      ...(out.error?.data.resets_at ? { resetsAt: out.error.data.resets_at } : {}), ...(out.error?.data.model_family ? { modelFamily: out.error.data.model_family } : {}), details,
    });
    out.parkReason = r.parked ? "rate_limited" : "out_of_fuel";
    return out;
  }
  out.parkReason = reason;
  parkVoyage(g, { taskId: input.taskId, voyageId, shipId: ship.id, reason, details });
  return out;
}
