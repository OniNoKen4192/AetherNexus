export type Vessel = { hull: string; count: number; role: string };
export type Formation = { id: string; name: string; vessels: Vessel[] };
export type VoyageShip = { name: string; faction: string; weight: string; formation_name: string };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function formationText(f: { name: string; vessels: { hull: string; count: number; role: string }[] }): string {
  if (f.vessels.length === 0) return f.name;
  const vessels = f.vessels.map((vessel) => `${vessel.count} ${vessel.hull}${vessel.count > 1 ? "s" : ""}`);
  return `${f.name} (${vessels.join(", ")})`;
}

export function voyageSentence(v: { ship: { name: string; faction: string; formation_name: string } | null; cargo: { label: string } | null }): string | null {
  if (v.ship === null) return null;
  const sentence = `${v.ship.name} — ${v.ship.formation_name.toLowerCase()} (${v.ship.faction})`;
  return v.cargo === null ? sentence : `${sentence}, carrying ${v.cargo.label}`;
}

export function sortShips<T extends { weight: string; name: string }>(ships: T[], weights: string[]): T[] {
  const rank = new Map(weights.map((weight, index) => [weight, index]));
  return ships.slice().sort((left, right) => {
    const leftRank = rank.get(left.weight) ?? weights.length;
    const rightRank = rank.get(right.weight) ?? weights.length;
    return leftRank - rightRank || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  });
}

export function asVoyageShip(value: unknown): VoyageShip | null {
  const item = record(value);
  if (item === null || typeof item.name !== "string" || typeof item.faction !== "string"
    || typeof item.weight !== "string" || typeof item.formation_name !== "string") return null;
  return { name: item.name, faction: item.faction, weight: item.weight, formation_name: item.formation_name };
}

export function asCargo(value: unknown): { id: string; label: string } | null {
  const item = record(value);
  if (item === null || typeof item.id !== "string" || typeof item.label !== "string") return null;
  return { id: item.id, label: item.label };
}

export function asFormation(value: unknown): Formation | null {
  const item = record(value);
  if (item === null || typeof item.id !== "string" || typeof item.name !== "string" || !Array.isArray(item.vessels)) return null;
  const vessels: Vessel[] = [];
  for (const value of item.vessels) {
    const vessel = record(value);
    if (vessel !== null && typeof vessel.hull === "string" && typeof vessel.count === "number" && typeof vessel.role === "string") {
      vessels.push({ hull: vessel.hull, count: vessel.count, role: vessel.role });
    }
  }
  return { id: item.id, name: item.name, vessels };
}
