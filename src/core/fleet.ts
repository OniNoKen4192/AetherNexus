import { mulberry32 } from "./rng.js";
import { THEMES, pickName } from "./names.js";
import type { NexusDb } from "../db/open.js";
export type ShipClass = "freighter" | "customs" | "carrier" | "surveyor";
export type GeneratedShip = { id: string; name: string; class: ShipClass; fleet: string };
export type ShipRow = { id: string; name: string; class: ShipClass; fleet: string; status: string; voyage_count: number; last_event_id: number };
export function slug(name: string): string { return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
export function generateFleet(seed: number, theme: string, counts: { freighters: number; customs: number; carriers: number; surveyors: number }, fleets: string[]): GeneratedShip[] {
  const rng = mulberry32((seed ^ 0x53484950) >>> 0); const t = THEMES[theme] ?? THEMES["classic"]!;   // 0x53484950 = "SHIP": a fixed salt so fleet names differ from body names for the same seed
  const used = new Set<string>(); const out: GeneratedShip[] = [];
  const plan: [ShipClass, number][] = [["freighter", counts.freighters], ["customs", counts.customs], ["carrier", counts.carriers], ["surveyor", counts.surveyors]];
  for (const fleet of fleets) for (const [cls, n] of plan) for (let i = 0; i < n; i++) { const name = pickName(rng, t.ships, used); out.push({ id: slug(name), name, class: cls, fleet }); }
  return out;
}
export function pickIdleShip(db: NexusDb, cls: ShipClass, fleet: string): ShipRow | undefined {
  return db.get<ShipRow>("ships.pickIdle", { class: cls, fleet });
}
