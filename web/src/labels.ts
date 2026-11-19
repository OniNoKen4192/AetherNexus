import type { FuelWait, RefuelOffer } from "./types";

export function statusText(status: string): string {
  if (status === "awaiting_pickup") return "cargo awaiting pickup";
  if (status === "out_of_fuel") return "out of fuel";
  return status;
}

export function parkReasonText(reason: string): string {
  if (reason === "carryover_violations") return "contraband in the cargo";
  if (reason === "baseline_tampered") return "raided by pirates";
  return reason;
}

export function parkReasonHint(reason: string): string | null {
  if (reason === "carryover_violations") return "clear the files outside the task's paths from its worktree, then reply — or cancel the delivery";
  if (reason === "baseline_tampered") return "put the gate's state file back exactly as it was, then reply — or cancel the delivery";
  return null;
}

export function needsAttention(reason: unknown): boolean {
  return reason === "carryover_violations" || reason === "baseline_tampered";
}

export function fuelWaitText(wait: FuelWait, formatTime: (iso: string) => string): string {
  const label = `waiting on ${wait.provider} fuel`;
  return wait.until === undefined ? label : `${label} · resets ${formatTime(wait.until)}`;
}

export function sendAnywayLabel(reason: string): string {
  return reason === "low" ? "Send anyway" : "Send anyway (probe)";
}

export function refuelLabel(offer: RefuelOffer): string {
  return `Refuel: ${offer.provider}/${offer.model}`;
}

export function refuelledText(voyage: Record<string, unknown>): string | null {
  if (typeof voyage["refuel_for"] !== "string") return null;
  const provider = typeof voyage["provider"] === "string" ? voyage["provider"] : "";
  const model = typeof voyage["model"] === "string" ? voyage["model"] : null;
  return `refuelled: ${provider}${model === null ? "" : `/${model}`}`;
}

export function overrideCommand(actions: string[], taskId: string): { name: "delivery.send" | "customs.send"; body: { taskId: string; override: true } } | null {
  if (actions.includes("send")) return { name: "delivery.send", body: { taskId, override: true } };
  if (actions.includes("inspect")) return { name: "customs.send", body: { taskId, override: true } };
  return null;
}

export function refuelCommand(actions: string[], taskId: string): { name: "delivery.send"; body: { taskId: string; refuel: true } } | null {
  return actions.includes("send") ? { name: "delivery.send", body: { taskId, refuel: true } } : null;
}

export function asFuelWait(value: unknown): FuelWait | null {
  if (typeof value !== "object" || value === null) return null;
  const wait = value as Record<string, unknown>;
  if (typeof wait["provider"] !== "string" || typeof wait["reason"] !== "string") return null;
  return typeof wait["until"] === "string"
    ? { provider: wait["provider"], reason: wait["reason"], until: wait["until"] }
    : { provider: wait["provider"], reason: wait["reason"] };
}

export function asRefuelOffer(value: unknown): RefuelOffer | null {
  if (typeof value !== "object" || value === null) return null;
  const offer = value as Record<string, unknown>;
  return typeof offer["provider"] === "string" && typeof offer["model"] === "string"
    ? { provider: offer["provider"], model: offer["model"] }
    : null;
}
