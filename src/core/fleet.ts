import { mulberry32 } from "./rng.js";
import { pickCargo, pickFormation, shipName } from "./catalogue/pick.js";
import type { Catalogue, ShipFormation, ShipJob } from "./catalogue/types.js";
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

const mix = (seed: number, salt: number, n: number): number => ((seed ^ salt) + Math.imul(n + 1, 0x9e3779b1)) >>> 0;
/**
 * A new ship for a job no idle ship can take. Call it inside the launch transaction: the name and id are chosen against
 * every ship the galaxy has ever had (a retired ship's name is never given out again), and the pick is seeded from
 * `seed` and the number of ships so far, so the same history gives the same ship.
 */
export function commissionShip(db: NexusDb, p: { catalogue: Catalogue; fleet: string; job: ShipJob; faction: string; weight: string; theme: string; seed: number }): ShipRecord {
  const ships = db.all<{ id: string; name: string }>("ships.all");
  const rng = mulberry32(mix(p.seed, 0x53484950, ships.length));   // 0x53484950 = "SHIP"
  const formation = pickFormation(p.catalogue, { job: p.job, weight: p.weight, faction: p.faction }, rng);
  const name = shipName(p.catalogue, { faction: p.faction, theme: p.theme }, rng, new Set(ships.map((s) => s.name)));
  const ids = new Set(ships.map((s) => s.id)); const base = slug(name) || "ship";
  let id = base; for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;   // two names can share a slug
  return { id, name, fleet: p.fleet, job: p.job, faction: p.faction, weight: p.weight, formation };
}
/** The cargo of one trip, drawn per voyage (seeded from `seed` and the number of voyages so far); null when the catalogue has none for the weight. */
export function drawCargo(db: NexusDb, catalogue: Catalogue, weight: string, seed: number): { id: string; label: string } | null {
  const voyages = db.get<{ n: number }>("voyages.count")!.n;
  return pickCargo(catalogue, weight, mulberry32(mix(seed, 0x43415247, voyages)));   // 0x43415247 = "CARG"
}
/** An idle ship of this fleet, job and weight: the least-flown first. There is no nearest-weight fallback. */
export function pickIdleShip(db: NexusDb, job: ShipJob, fleet: string, weight: string): ShipRow | undefined {
  return db.get<ShipRow>("ships.pickIdle", { job, fleet, weight });
}
