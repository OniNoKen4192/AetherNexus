import { THEMES, pickName } from "../names.js";
import { pick, type Rng } from "../rng.js";
import { PLAIN_FORMATION } from "./builtin.js";
import type { Catalogue, Formation, ShipFormation, ShipJob, Vessel } from "./types.js";

function copyVessels(vessels: readonly Vessel[]): Vessel[] {
  return vessels.map((vessel) => ({ ...vessel }));
}

function copyFormation(formation: Formation | ShipFormation): ShipFormation {
  const copy: ShipFormation = { id: formation.id, name: formation.name, vessels: copyVessels(formation.vessels) };
  if ("art" in formation) copy.art = formation.art;
  return copy;
}

function applies(values: readonly string[] | undefined, value: string): boolean {
  return values === undefined || values.length === 0 || values.includes(value);
}

export function pickFormation(c: Catalogue, q: { job: ShipJob; weight: string; faction: string }, rng: Rng): ShipFormation {
  const candidates = c.formations.filter((formation) =>
    formation.job === q.job && applies(formation.weights, q.weight) && applies(formation.factions, q.faction));
  return copyFormation(candidates.length > 0 ? pick(rng, candidates) : PLAIN_FORMATION);
}

export function pickCargo(c: Catalogue, weight: string, rng: Rng): { id: string; label: string } | null {
  const candidates = c.cargo.filter((cargo) => applies(cargo.weights, weight));
  if (candidates.length === 0) return null;
  const cargo = pick(rng, candidates);
  return { id: cargo.id, label: cargo.label };
}

function generatedName(pattern: string, pools: Record<string, string[]>, rng: Rng): string {
  return pattern.replace(/\{([^{}]+)\}/g, (_placeholder, pool: string) => pick(rng, pools[pool]!));
}

export function shipName(c: Catalogue, q: { faction: string; theme: string }, rng: Rng, used: Set<string>): string {
  const rules = c.names[q.faction];
  if (rules !== undefined) {
    let candidate = "";
    for (let attempt = 0; attempt < 32; attempt++) {
      candidate = generatedName(pick(rng, rules.patterns), rules.pools, rng);
      if (!used.has(candidate)) {
        used.add(candidate);
        return candidate;
      }
    }
    return pickName(rng, [candidate], used);
  }
  const theme = THEMES[q.theme] ?? THEMES.classic!;
  return pickName(rng, theme.ships, used);
}
