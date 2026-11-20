// The page's view of the server's JSON. Re-declared from src/server/commands/query.ts and
// src/db/events.ts; the page never imports from src/.

export type Row = Record<string, unknown>;

export type Owner = "server" | "other" | "stale";
export type SpecEntry = { path: string; taskId: string | null; touch: string[]; error: string | null };
export type Failure = { ts: string; taskId: string; voyageId: string | null; message: string };
export type Action = "send" | "inspect" | "dock" | "reply" | "cancel_delivery" | "park_stale" | "cancel" | "answer";

export type PoolView = {
  provider: string; kind: string; state: "dry" | "free" | "low" | "ok" | "unknown";
  remaining?: number; resets_at?: string; until?: string; reading_ts?: string;
  reserve_floor: number; refuel?: { provider: string; models: Record<string, string> };
  windows: { window: string; used: number; resets_at?: string; model_family?: string; ts: string }[];
};
export type FuelWait = { provider: string; reason: string; until?: string };
export type RefuelOffer = { provider: string; model: string };

export type Snapshot = {
  cursor: number; repo: string; rung: string; ready_to_send: number;
  limits: { max_concurrent_ships: number; per_provider_max: Record<string, number>; in_flight: number };
  roles: { implement: string[]; review: string[] };
  systems: (Row & { planets: (Row & { moons: Row[] })[] })[];
  voyages: (Row & { owner: Owner | null; refuel_for: string | null })[];
  weights: string[];
  fleet: Row[]; pools: PoolView[]; decisions: Row[]; specs: SpecEntry[]; failures: Failure[];
};

/** One event row with its payload parsed (as the feed sends it). */
export type FeedEvent = {
  id: number; ts: string; kind: string;
  system_id?: string | null; planet_id?: string | null; moon_id?: string | null;
  voyage_id?: string | null; ship_id?: string | null; task_id?: string | null;
  assignment_id?: number | null; provider?: string | null; payload: Record<string, unknown>;
};

export type MoonDetail = {
  moon: Row; spec: string | null;
  voyages: (Row & { owner: Owner | null; refuel_for: string | null })[];
  verdicts: Row[]; events: FeedEvent[]; decisions: Row[]; actions: Action[];
};
