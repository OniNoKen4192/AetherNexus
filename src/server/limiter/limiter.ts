import { pickIdleShip, type ShipRow } from "../../core/fleet.js";
import type { Role } from "../../providers/adapter.js";
import { loadMoon, providerAtCap, shipClassFor, shipsNoun } from "../dispatch.js";
import type { Galaxy } from "../galaxy.js";
import { poolState } from "./pool.js";

export type FuelVerdict = { allow: true } | { allow: false; reason: "dry" | "low"; until?: string };
export type Capacity = { free: number; providerUse: Map<string, number>; claimed: Set<string> };
export type Choice =
  | { kind: "fly"; provider: string; shipId: string; model?: string; reroutedFrom?: { provider: string; reason: "dry" | "low" }; refuelFor?: { provider: string; reason: "dry" | "low" } }
  | { kind: "held"; provider: string; reason: "dry" | "low"; until?: string; canRefuel?: { provider: string; model: string } }
  | { kind: "none"; message: string };

export function fuelCheck(g: Galaxy, role: Role, provider: string, model?: string): FuelVerdict {
  const state = poolState(g, provider, model);
  if (state.state === "dry") return { allow: false, reason: "dry", until: state.until };
  if (state.state === "free" || role === "review") return { allow: true };
  if (state.state === "low") return { allow: false, reason: "low", ...(state.resets_at !== undefined ? { until: state.resets_at } : {}) };
  return { allow: true };
}

function available(g: Galaxy, provider: string, role: Role, capacity?: Capacity): ShipRow | undefined {
  if (!g.adapters[provider]) return undefined;
  const max = g.config.scheduler.per_provider_max[provider];
  if (capacity) {
    if (max !== undefined && (capacity.providerUse.get(provider) ?? 0) >= max) return undefined;
    const cls = shipClassFor(role);
    return g.db.all<ShipRow>("ships.all").find((ship) => ship.fleet === provider && ship.class === cls && ship.status === "idle" && !capacity.claimed.has(ship.id));
  }
  if (providerAtCap(g, provider)) return undefined;
  return pickIdleShip(g.db, shipClassFor(role), provider);
}

function refusal(g: Galaxy, provider: string, role: Role, capacity?: Capacity): string {
  if (!g.adapters[provider]) return `provider '${provider}' is not configured`;
  const max = g.config.scheduler.per_provider_max[provider];
  const atCap = capacity ? max !== undefined && (capacity.providerUse.get(provider) ?? 0) >= max : providerAtCap(g, provider);
  if (atCap) return `provider '${provider}' is at its limit of ${max} (scheduler.per_provider_max)`;
  return `all ${shipsNoun(shipClassFor(role))} in fleet '${provider}' are assigned`;
}

function take(capacity: Capacity | undefined, provider: string, shipId: string): void {
  if (!capacity) return;
  capacity.free--;
  capacity.providerUse.set(provider, (capacity.providerUse.get(provider) ?? 0) + 1);
  capacity.claimed.add(shipId);
}

function parseTime(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function chooseProvider(g: Galaxy, p: { role: Role; tier: string | null; mayRefuel: boolean; requested?: string; override?: boolean; capacity?: Capacity }): Choice {
  const order = p.requested !== undefined ? [p.requested] : g.config.roles[p.role];
  if (order.length === 0) return { kind: "none", message: `no provider is configured for the ${p.role} role` };
  if (p.capacity && p.capacity.free <= 0) return { kind: "none", message: "the concurrency limit is reached" };

  let held: { provider: string; verdict: Exclude<FuelVerdict, { allow: true }> } | undefined;
  for (const provider of order) {
    const ship = available(g, provider, p.role, p.capacity);
    if (!ship) continue;
    if (p.override) {
      take(p.capacity, provider, ship.id);
      return { kind: "fly", provider, shipId: ship.id };
    }
    const verdict = fuelCheck(g, p.role, provider);
    if (!verdict.allow) { held ??= { provider, verdict }; continue; }
    take(p.capacity, provider, ship.id);
    return { kind: "fly", provider, shipId: ship.id, ...(held ? { reroutedFrom: { provider: held.provider, reason: held.verdict.reason } } : {}) };
  }

  if (!held) return { kind: "none", message: refusal(g, order[0]!, p.role, p.capacity) };
  const heldChoice: Choice & { kind: "held" } = {
    kind: "held", provider: held.provider, reason: held.verdict.reason,
    ...(held.verdict.until !== undefined ? { until: held.verdict.until } : {}),
  };
  if (p.role !== "implement") return heldChoice;

  const refuel = g.config.providers[held.provider]?.pool?.refuel;
  if (!refuel || p.tier === null || !Object.hasOwn(refuel.models, p.tier)) return heldChoice;
  const model = refuel.models[p.tier];
  if (typeof model !== "string" || model.length === 0) return heldChoice;
  if (!fuelCheck(g, "implement", refuel.provider, model).allow) return heldChoice;
  const until = parseTime(held.verdict.until);
  if (until !== undefined && until <= g.now() + refuel.min_wait_minutes * 60_000) return heldChoice;
  const ship = available(g, refuel.provider, "implement", p.capacity);
  if (!ship) return heldChoice;
  if (!p.mayRefuel) return { ...heldChoice, canRefuel: { provider: refuel.provider, model } };
  take(p.capacity, refuel.provider, ship.id);
  return { kind: "fly", provider: refuel.provider, shipId: ship.id, model, refuelFor: { provider: held.provider, reason: held.verdict.reason } };
}

export function fuelHold(g: Galaxy, taskId: string, action: "send" | "inspect"): (Choice & { kind: "held" }) | null {
  let tier: string | null;
  try { tier = loadMoon(g, taskId).tier; } catch { return null; }
  const choice = chooseProvider(g, { role: action === "send" ? "implement" : "review", tier, mayRefuel: false });
  return choice.kind === "held" ? choice : null;
}
