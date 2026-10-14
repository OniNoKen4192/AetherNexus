import { append } from "../../db/events.js";
import type { Row } from "../../db/open.js";
import { generateSystem } from "../../core/bodies.js";
import { SAFE_ID, idError } from "../../validate/spec.js";
import { Refusal } from "../errors.js";
import type { Galaxy } from "../galaxy.js";

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

export function createSystem(g: Galaxy, input: { slug: string; kind?: "feature" | "bug"; title: string; brief: string; seed?: number }): { systemId: string; baseSha: string; planets: number; moons: number } {
  if (!SAFE_ID.test(input.slug)) throw new Refusal(idError(input.slug));
  const systemId = `S-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${input.slug}`;
  const baseSha = g.git.headSha();
  const integration = `system/${systemId}/integration`;
  const seed = input.seed ?? fnv1a(systemId);
  const theme = g.config.fleet.name_theme;
  const gen = generateSystem(seed, theme);
  append(g.db, {
    kind: "system.created", system_id: systemId,
    payload: { kind: input.kind ?? "feature", title: input.title, brief: input.brief, base_sha: baseSha, integration_branch: integration, seed, theme, planets: gen.planets },
  }, () => { if (g.db.get("systems.byId", { id: systemId })) throw new Refusal(`system '${systemId}' already exists`); });
  // Side effect after commit; tolerate a branch left by a crashed earlier run.
  if (!g.git.branchExists(integration)) g.git.createBranch(integration, baseSha);
  return { systemId, baseSha, planets: gen.planets.length, moons: gen.planets.reduce((n, p) => n + p.moons.length, 0) };
}

export function showSystem(g: Galaxy, systemId: string): { system: Row; planets: (Row & { moons: Row[] })[] } {
  const system = g.db.get("systems.byId", { id: systemId });
  if (!system) throw new Refusal(`system '${systemId}' does not exist`);
  const planets = g.db.all("planets.bySystem", { system_id: systemId }).map((p) => ({ ...p, moons: g.db.all("moons.byPlanet", { planet_id: p["id"] }) }));
  return { system, planets };
}
