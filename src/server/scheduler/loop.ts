import { GitRefusal } from "../../core/git.js";
import { TransitionRefused } from "../../core/transitions.js";
import { append, rowToEvent, type EventRow } from "../../db/events.js";
import { reloadConfig } from "../commands/config.js";
import { dockCargo } from "../commands/dock.js";
import { sendDelivery } from "../commands/delivery.js";
import { parkMoonOnly, parkStaleMoon } from "../commands/park.js";
import { sendCustoms } from "../commands/customs.js";
import { loadMoon, moonScope } from "../dispatch.js";
import { Refusal } from "../errors.js";
import { followEvents } from "../follow.js";
import type { Galaxy } from "../galaxy.js";
import type { VoyageRunner } from "../http/runner.js";
import { effectiveRung, planWithHolds, type Hold, type PlanCtx, type PlannedAction } from "./plan.js";

export type Scheduler = {
  /** Ask for a pass. Calls during a pass coalesce into one further pass. */
  wake(): void;
  /** Resolves when no pass is running and none is pending. */
  settled(): Promise<void>;
  /** Stop the follower and the timer, wait for the running pass. Voyages in flight are not touched. */
  stop(): Promise<void>;
};

function messageOf(error: unknown): string {
  try {
    const message: unknown = error instanceof Error ? error.message : error;
    return typeof message === "string" ? message : String(message);
  } catch {
    return "unknown error";
  }
}

/**
 * The loop that acts on what `plan` decides: it sends freighters, has customs inspect, docks, and parks a moon whose
 * voyage's process is gone. Woken by every new event and by a slow tick. One pass at a time; an error never stops it.
 * A ship the limiter holds for fuel is not an action and never a failure: the hold is written to the log once
 * (`limiter.held`), and the tick sends the ship when the pool is back.
 */
export function createScheduler(g: Galaxy, opts: { runner: VoyageRunner; pollMs: number; tickMs?: number }): Scheduler {
  const { runner } = opts;
  /** Moons with a freighter or customs run started here that has not settled yet. */
  const busy = new Set<string>();
  /** One failed attempt per (moon, action), with the moon's status at the time. A second failure in a row parks the moon. */
  const failed = new Map<string, { taskId: string; status: string | null; gaveUp?: true }>();
  let stopped = false;
  let again = false;
  let current: Promise<void> | undefined;
  let lastNotice: string | undefined;

  const key = (a: PlannedAction): string => `${a.action}\n${a.taskId}`;
  const ctx = (): PlanCtx => ({ ownPid: process.pid, tracks: (id) => runner.tracks(id), busy });
  const statusOf = (taskId: string): string | null => {
    try { return loadMoon(g, taskId).status; } catch { return null; }
  };
  /** A notice for the Bridge that is not about one moon's attempt. The same text is not repeated pass after pass. */
  const notice = (message: string): void => {
    if (message === lastNotice) return;
    lastNotice = message;
    runner.report({ taskId: "scheduler", message });
  };

  async function execute(a: PlannedAction): Promise<void> {
    if (a.action === "dock") { dockCargo(g, { taskId: a.taskId }); return; }
    if (a.action === "park_stale") { parkStaleMoon(g, { taskId: a.taskId, reason: "the voyage's process is gone", details: "parked by the scheduler: the voyage's process is gone" }); return; }
    // No provider is passed: the command asks the limiter again and records a reroute or a refuel itself. The plan's
    // provider and model are a forecast; only its permission to refuel is handed on.
    const send: (input: { taskId: string; signal: AbortSignal; onLaunched: (voyageId: string) => void }) => Promise<unknown> =
      a.action === "send" ? (input) => sendDelivery(g, { ...input, ...(a.refuel ? { refuel: true } : {}) }) : (input) => sendCustoms(g, input);
    busy.add(a.taskId);
    try {
      // Resolves once the voyage is launched (or the command returned without one); rejects when it is refused before launch.
      // What happens to a launched voyage afterwards is the runner's business.
      await runner.start(a.taskId, ({ signal, onLaunched }) => send({ taskId: a.taskId, signal, onLaunched }).finally(() => {
        busy.delete(a.taskId);
        wake();
      }));
    } catch (error) {
      busy.delete(a.taskId);
      throw error;
    }
  }

  /**
   * Write `limiter.held` when a ship starts waiting on fuel. The plan reports the same hold on every pass, and every
   * event wakes a pass, so it is written again only when the provider, reason or reset time changed, or a ship of the
   * same role was launched for the moon since.
   */
  function recordHold(hold: Hold): void {
    const moon = loadMoon(g, hold.taskId);
    const events = g.db.all<EventRow>("events.byAssignment", { assignment_id: moon.assignment_id }).map(rowToEvent);
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.kind === "voyage.launched" && e.payload["role"] === hold.role) break;
      if (e.kind !== "limiter.held" || e.payload["role"] !== hold.role) continue;
      if (e.payload["provider"] === hold.provider && e.payload["reason"] === hold.reason && e.payload["until"] === hold.until) return;
      break;
    }
    append(g.db, {
      kind: "limiter.held", ...moonScope(g, moon),
      payload: { task_id: hold.taskId, role: hold.role, provider: hold.provider, reason: hold.reason, ...(hold.until !== undefined ? { until: hold.until } : {}) },
    });
  }

  async function pass(): Promise<void> {
    const { actions, holds } = planWithHolds(g, ctx());
    for (const hold of holds) {
      if (stopped) return;
      try { recordHold(hold); }
      catch (error) { notice(`the scheduler could not record that ${hold.taskId} is waiting on ${hold.provider} fuel: ${messageOf(error)}`); }
    }
    for (const [k, record] of failed) if (statusOf(record.taskId) !== record.status) failed.delete(k);
    for (const action of actions) {
      if (stopped) return;
      if (failed.get(key(action))?.gaveUp) continue;
      try {
        append(g.db, {
          kind: "scheduler.acted", ...moonScope(g, loadMoon(g, action.taskId)),
          payload: { action: action.action, task_id: action.taskId, rung: effectiveRung(g.config.automation.level) },
        });
        await execute(action);
        failed.delete(key(action));
      } catch (error) {
        // If the plan no longer asks for this, the moon's state or the capacity moved under us (a human click, another
        // voyage taking the ship): a race, not a failure.
        let stillPlanned: boolean;
        // A ship the limiter now holds is in the plan's holds, not its actions: also not a failure.
        try { stillPlanned = planWithHolds(g, ctx()).actions.some((a) => a.taskId === action.taskId && a.action === action.action); }
        catch { stillPlanned = false; }
        if (!stillPlanned) continue;
        if (!failed.has(key(action))) {
          failed.set(key(action), { taskId: action.taskId, status: statusOf(action.taskId) });
          continue;
        }
        failed.delete(key(action));
        const refused = error instanceof Refusal || error instanceof TransitionRefused || error instanceof GitRefusal;
        try {
          parkMoonOnly(g, { taskId: action.taskId, reason: refused ? "scheduler_refused" : "scheduler_error", details: messageOf(error) });
        } catch (parkError) {
          // Every attempt writes an event, and every event wakes the loop: leave this moon alone until its status changes.
          failed.set(key(action), { taskId: action.taskId, status: statusOf(action.taskId), gaveUp: true });
          runner.report({ taskId: action.taskId, message: `the scheduler could not ${action.action === "park_stale" ? "park" : action.action === "send" ? "send the delivery" : action.action} and could not park the moon: ${messageOf(parkError)} (after: ${messageOf(error)})` });
        }
      }
    }
  }

  async function run(): Promise<void> {
    try {
      do {
        again = false;
        try { await pass(); lastNotice = undefined; }
        catch (error) { notice(`a scheduler pass failed: ${messageOf(error)}`); }
      } while (again && !stopped);
    } finally {
      // Cleared in the same turn as the loop's last check, so a wake() can never land between the two and be lost.
      current = undefined;
    }
  }

  function wake(): void {
    if (stopped) return;
    if (current) { again = true; return; }
    current = run();
  }

  const onEvents = (rows: EventRow[]): void => {
    if (rows.some((row) => row.kind === "config.changed" && row.payload["pid"] !== process.pid)) {
      const reloaded = reloadConfig(g);
      if (!reloaded.ok) runner.report({ taskId: "config", message: `.nexus/config.json was changed by another process and could not be reloaded: ${reloaded.error}` });
    }
    // An agent's own output changes nothing the plan looks at.
    if (rows.some((row) => row.kind !== "voyage.event")) wake();
  };

  const follower = followEvents(g.db, { since: g.db.get<{ id: number }>("events.maxId")?.id ?? 0, pollMs: opts.pollMs, onEvents });
  const timer = setInterval(wake, opts.tickMs ?? 5000);
  timer.unref();

  return {
    wake,
    async settled() { while (current) await current; },
    async stop() {
      stopped = true;
      follower.stop();
      clearInterval(timer);
      while (current) await current;
    },
  };
}
