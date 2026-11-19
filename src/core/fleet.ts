import { mulberry32 } from "./rng.js";
import { THEMES, pickName } from "./names.js";
import type { ShipFormation, ShipJob } from "./catalogue/types.js";
import type { NexusDb } from "../db/open.js";
/** The four ship classes of the fleet that was registered up front, before migration 003. They survive only in old `ship.registered` events. */
export type LegacyShipClass = "freighter" | "customs" | "carrier" | "surveyor";
export type GeneratedShip = { id: string; name: string; class: LegacyShipClass; fleet: string };
/** What a ship is for life: written once, into the event that creates it. */
export type ShipRecord = { id: string; name: string; fleet: string; job: ShipJob; faction: string; weight: string; formation: ShipFormation };
export type ShipRow = { id: string; name: string; job: ShipJob; fleet: string; faction: string; weight: string; formation: string /* JSON */; status: string; voyage_count: number; last_event_id: number };
export function slug(name: string): string { return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }

/** The job a voyage's role needs a ship for. */
export function jobFor(role: string): ShipJob {
  switch (role) {
    case "implement": return "delivery";
    case "review": return "customs";
    case "carry": return "transfer";
    case "plan": return "survey";
    default: throw new Error(`no ship job for role '${role}'`);
  }
}

// Migration 003 writes these same values in SQL for ships that already exist; keep the two byte-equal (JSON.stringify key order: id, name, vessels; hull, count, role).
const LEGACY: Record<LegacyShipClass, { job: ShipJob; name: string; hull: string }> = {
  freighter: { job: "delivery", name: "Freighter", hull: "freighter" },
  customs: { job: "customs", name: "Customs cutter", hull: "customs-cutter" },
  carrier: { job: "transfer", name: "Carrier", hull: "carrier" },
  surveyor: { job: "survey", name: "Surveyor", hull: "surveyor" },
};
/** A ship registered before ships carried an identity: its class becomes its job, its fleet its faction, its weight `standard`. */
export function legacyShip(old: { id: string; name: string; class: string; fleet: string }): ShipRecord {
  const legacy = Object.hasOwn(LEGACY, old.class) ? LEGACY[old.class as LegacyShipClass] : undefined;
  if (!legacy) throw new Error(`ship '${old.id}' has unknown class '${old.class}'`);
  return {
    id: old.id, name: old.name, fleet: old.fleet, job: legacy.job, faction: old.fleet, weight: "standard",
    formation: { id: `legacy-${legacy.job}`, name: legacy.name, vessels: [{ hull: legacy.hull, count: 1, role: "lead" }] },
  };
}

export function generateFleet(seed: number, theme: string, counts: { freighters: number; customs: number; carriers: number; surveyors: number }, fleets: string[]): GeneratedShip[] {
  const rng = mulberry32((seed ^ 0x53484950) >>> 0); const t = THEMES[theme] ?? THEMES["classic"]!;   // 0x53484950 = "SHIP": a fixed salt so fleet names differ from body names for the same seed
  const used = new Set<string>(); const out: GeneratedShip[] = [];
  const plan: [LegacyShipClass, number][] = [["freighter", counts.freighters], ["customs", counts.customs], ["carrier", counts.carriers], ["surveyor", counts.surveyors]];
  for (const fleet of fleets) for (const [cls, n] of plan) for (let i = 0; i < n; i++) { const name = pickName(rng, t.ships, used); out.push({ id: slug(name), name, class: cls, fleet }); }
  return out;
}
/** An idle ship of this fleet, job and weight: the least-flown first. There is no nearest-weight fallback. */
export function pickIdleShip(db: NexusDb, job: ShipJob, fleet: string, weight: string): ShipRow | undefined {
  return db.get<ShipRow>("ships.pickIdle", { job, fleet, weight });
}
