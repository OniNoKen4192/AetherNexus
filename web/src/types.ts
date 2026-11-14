// The page's view of the server's JSON. Re-declared from src/server/commands/query.ts and
// src/db/events.ts; the page never imports from src/.

export type Row = Record<string, unknown>;

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

/** One event row with its payload parsed (as the feed sends it). */
export type FeedEvent = {
  id: number; ts: string; kind: string;
  system_id?: string | null; planet_id?: string | null; moon_id?: string | null;
  voyage_id?: string | null; ship_id?: string | null; task_id?: string | null;
  assignment_id?: number | null; provider?: string | null; payload: Record<string, unknown>;
};

export type MoonDetail = {
  moon: Row; spec: string | null;
  voyages: (Row & { owner: Owner | null })[];
  verdicts: Row[]; events: FeedEvent[]; decisions: Row[]; actions: Action[];
};
