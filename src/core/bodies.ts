import { mulberry32, int, type Rng } from "./rng.js";
import { THEMES, pickName } from "./names.js";
export type PlanetKind = "rocky" | "gas_giant" | "ice_giant" | "dwarf";
export type GeneratedMoon = { name: string; orbit_index: number };
export type GeneratedPlanet = { name: string; orbit_index: number; kind: PlanetKind; moons: GeneratedMoon[] };
export type GeneratedSystem = { seed: number; theme: string; planets: GeneratedPlanet[]; belt_after_orbit: 5 };
const OUTER: PlanetKind[] = ["gas_giant", "gas_giant", "ice_giant", "ice_giant"]; // then dwarf forever

export function generateSystem(seed: number, theme = "classic"): GeneratedSystem {
  const rng = mulberry32(seed); const t = THEMES[theme] ?? THEMES["classic"]!;
  const usedP = new Set<string>(), usedM = new Set<string>();
  const planets: GeneratedPlanet[] = [];
  for (let i = 0; i < 6; i++) {
    const moons: GeneratedMoon[] = [];
    const n = int(rng, 1, 4);
    const name = pickName(rng, t.planets, usedP);
    for (let j = 0; j < n; j++) moons.push({ name: pickName(rng, t.moons, usedM), orbit_index: j });
    planets.push({ name, orbit_index: i, kind: "rocky", moons });
  }
  return { seed, theme, planets, belt_after_orbit: 5 };
}
// Discovery is deterministic in (seed, what already exists): derive a sub-seed from the seed and the count.
function subRng(seed: number, salt: number): Rng { return mulberry32((seed ^ (salt * 0x9e3779b9)) >>> 0); }
export function discoverPlanet(seed: number, theme: string, existing: { name: string; orbit_index: number }[]): GeneratedPlanet {
  const t = THEMES[theme] ?? THEMES["classic"]!;
  const orbit = Math.max(-1, ...existing.map((e) => e.orbit_index)) + 1;
  const rng = subRng(seed, 1000 + orbit);
  const used = new Set(existing.map((e) => e.name));
  const outerIndex = orbit - 6;
  return { name: pickName(rng, t.planets, used), orbit_index: orbit, kind: OUTER[outerIndex] ?? "dwarf", moons: [] };
}
export function discoverMoon(seed: number, theme: string, planetOrbit: number, existing: { name: string; orbit_index: number }[], usedNames: Set<string>): GeneratedMoon {
  const t = THEMES[theme] ?? THEMES["classic"]!;
  const orbit = Math.max(-1, ...existing.map((e) => e.orbit_index)) + 1;
  const rng = subRng(seed, 2000 + planetOrbit * 100 + orbit);
  return { name: pickName(rng, t.moons, new Set(usedNames)), orbit_index: orbit };
}
