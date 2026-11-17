import { append, rowToEvent, type NexusEvent } from "../../db/events.js";
import type { Row } from "../../db/open.js";
import type { Galaxy } from "../galaxy.js";

export type Reading = { window: string; used: number; resets_at?: string; model_family?: string; ts: string };
export type PoolState =
  | { state: "dry"; until: string }
  | { state: "free" }
  | { state: "low" | "ok"; remaining: number; window: string; resets_at?: string; reading_ts: string }
  | { state: "unknown" };

const EVENT_LIMIT = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

function dateMs(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function familyApplies(family: unknown, model?: string): boolean {
  if (typeof family !== "string" || family.length === 0) return true;
  return model === undefined || model.toLocaleLowerCase().includes(family.toLocaleLowerCase());
}

function recent(g: Galaxy, kind: string, provider: string): ReturnType<typeof rowToEvent>[] {
  return g.db.all<Row>("events.latestByKindProvider", { kind, provider, limit: EVENT_LIMIT }).map(rowToEvent);
}

export function poolReadings(g: Galaxy, provider: string): Reading[] {
  const now = g.now();
  const seen = new Set<string>();
  const readings: Reading[] = [];
  for (const event of recent(g, "fuel.reading", provider)) {
    const p = event.payload;
    const used = p["used"];
    if (typeof p["window"] !== "string" || typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 1) continue;
    const family = typeof p["model_family"] === "string" ? p["model_family"] : undefined;
    const key = `${p["window"]}\u0000${family ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const reset = dateMs(p["resets_at"]);
    const eventTs = dateMs(event.ts);
    const live = reset !== undefined ? reset > now : eventTs !== undefined && eventTs > now - DAY_MS;
    if (!live) continue;
    readings.push({
      window: p["window"], used, ts: event.ts,
      ...(reset !== undefined ? { resets_at: p["resets_at"] as string } : {}),
      ...(family !== undefined ? { model_family: family } : {}),
    });
  }
  return readings;
}

export function poolState(g: Galaxy, provider: string, model?: string): PoolState {
  const noFamily = Symbol();
  const exhaustions = new Map<string | symbol, { event: ReturnType<typeof rowToEvent>; until: string; untilMs: number }>();
  for (const event of recent(g, "fuel.exhausted", provider)) {
    const family = event.payload["model_family"];
    if (!familyApplies(family, model)) continue;
    const until = event.payload["until"];
    const untilMs = dateMs(until);
    if (untilMs === undefined) continue;
    const key = typeof family === "string" && family.length > 0 ? family : noFamily;
    if (!exhaustions.has(key)) exhaustions.set(key, { event, until: until as string, untilMs });
  }
  let liveUntil: { value: string; ms: number } | undefined;
  for (const { event: exhaustion, until, untilMs } of exhaustions.values()) {
    if (untilMs <= g.now()) continue;
    const family = exhaustion.payload["model_family"];
    const returned = g.db.all<{ model: string | null }>("voyages.returnedByProviderSince", { provider, ts: exhaustion.ts });
    const cleared = returned.some((voyage) => typeof family !== "string" || (typeof voyage.model === "string" && familyApplies(family, voyage.model)));
    if (!cleared && (!liveUntil || untilMs > liveUntil.ms)) liveUntil = { value: until, ms: untilMs };
  }
  if (liveUntil) return { state: "dry", until: liveUntil.value };

  const pool = g.config.providers[provider]?.pool;
  if (!pool || pool.kind === "free") return { state: "free" };
  const readings = poolReadings(g, provider).filter((reading) => familyApplies(reading.model_family, model));
  if (readings.length === 0) return { state: "unknown" };
  const tightest = readings.reduce((a, b) => b.used > a.used ? b : a);
  const remaining = 1 - tightest.used;
  const low = (pool.reserve_floor ?? 0) - remaining > 1e-9;
  return {
    state: low ? "low" : "ok",
    remaining, window: tightest.window, reading_ts: tightest.ts,
    ...(tightest.resets_at !== undefined ? { resets_at: tightest.resets_at } : {}),
  };
}

export function recordReading(g: Galaxy, scope: Partial<NexusEvent>, provider: string, data: { window: string; used: number; resets_at?: string; model_family?: string }): boolean {
  const previous = recent(g, "fuel.reading", provider).find((event) =>
    event.payload["window"] === data.window && event.payload["model_family"] === data.model_family);
  if (previous && typeof previous.payload["used"] === "number" && Math.abs(previous.payload["used"] - data.used) <= 0.01 && previous.payload["resets_at"] === data.resets_at) return false;
  append(g.db, {
    ...scope, kind: "fuel.reading", provider, ts: new Date(g.now()).toISOString(),
    payload: { ...data, source: "reported" },
  });
  return true;
}
