import fs from "node:fs";
import path from "node:path";
import { append } from "../../db/events.js";
import { discoverMoon, discoverPlanet } from "../../core/bodies.js";
import { SAFE_ID, idError, parseSpec, hashSpec } from "../../validate/spec.js";
import { attentionMatches } from "../../validate/attention.js";
import { normalizePath } from "../../validate/match.js";
import { Refusal } from "../errors.js";
import type { Galaxy } from "../galaxy.js";

type SystemRow = { id: string; seed: number; theme: string; integration_branch: string };
type PlanetRow = { id: string; system_id: string; name: string; orbit_index: number; body_status: string };
type MoonRow = { id: string; name: string; orbit_index: number; body_status: string };

export function assignPlanet(g: Galaxy, input: { systemId: string; streamId: string; mission: string; territory: string[]; dependsOn?: string[]; planetName?: string }): { planetId: string; branch: string; worktree: string; discovered: boolean } {
  const system = g.db.get<SystemRow>("systems.byId", { id: input.systemId });
  if (!system) throw new Refusal(`system '${input.systemId}' does not exist`);
  if (!SAFE_ID.test(input.streamId)) throw new Refusal(idError(input.streamId));

  let planet: PlanetRow | undefined; let discovered = false;
  if (input.planetName !== undefined) {
    planet = g.db.get<PlanetRow>("planets.byId", { id: `${input.systemId}/${input.planetName}` });
    if (!planet) throw new Refusal(`planet '${input.planetName}' does not exist in system '${input.systemId}'`);
    if (planet.body_status !== "barren") throw new Refusal(`planet '${input.planetName}' is not barren`);
  } else {
    planet = g.db.get<PlanetRow>("planets.firstBarrenAny", { system_id: input.systemId });
    if (!planet) {
      const existing = g.db.all<PlanetRow>("planets.bySystem", { system_id: input.systemId });
      const found = discoverPlanet(system.seed, system.theme, existing);
      append(g.db, { kind: "planet.discovered", system_id: input.systemId, payload: { planet: found } });
      planet = g.db.get<PlanetRow>("planets.byId", { id: `${input.systemId}/${found.name}` })!;
      discovered = true;
    }
  }
  const planetId = planet.id; const planetName = planet.name;
  const branch = `system/${input.systemId}/${planetName}`;
  const worktree = `.nexus/worktrees/${input.systemId}/${planetName}`;
  append(g.db, {
    kind: "planet.assigned", system_id: input.systemId, planet_id: planetId,
    payload: { stream_id: input.streamId, mission: input.mission, territory: input.territory, depends_on: input.dependsOn ?? [], branch, worktree },
  }, () => {
    const cur = g.db.get<PlanetRow>("planets.byId", { id: planetId });
    if (!cur || cur.body_status !== "barren") throw new Refusal(`planet '${planetName}' is not barren`);
  });
  // Side effects after commit.
  const integrationSha = g.git.revParse(system.integration_branch);
  if (!g.git.branchExists(branch)) g.git.createBranch(branch, integrationSha);
  g.git.worktreeAdd(path.join(g.repoRoot, worktree), branch, integrationSha);
  return { planetId, branch, worktree, discovered };
}

export function assignMoon(g: Galaxy, input: { planetId: string; specPath: string; moonName?: string }): { moonId: string; taskId: string; discovered: boolean; attention: Record<string, string[]> } {
  const planet = g.db.get<PlanetRow>("planets.byId", { id: input.planetId });
  if (!planet) throw new Refusal(`planet '${input.planetId}' does not exist`);
  if (planet.body_status !== "assigned") throw new Refusal(`planet '${planet.name}' has no stream assigned yet`);
  const system = g.db.get<SystemRow>("systems.byId", { id: planet.system_id })!;

  const tasksDir = normalizePath(path.normalize(g.config.pipeline.tasks_dir)).replace(/\/+$/, "");
  const specRel = normalizePath(path.normalize(input.specPath));
  if (path.isAbsolute(input.specPath) || !specRel.startsWith(tasksDir + "/")) throw new Refusal(`spec '${input.specPath}' is not under the tasks directory '${tasksDir}'`);
  const abs = path.join(g.repoRoot, input.specPath);
  if (!fs.existsSync(abs)) throw new Refusal(`spec '${input.specPath}' does not exist`);
  const text = fs.readFileSync(abs, "utf8");
  const spec = parseSpec(text);
  if (!spec.taskId) throw new Refusal(`spec '${input.specPath}' has no Task ID`);
  const taskId = spec.taskId;
  if (!SAFE_ID.test(taskId)) throw new Refusal(idError(taskId));
  if (spec.touch.length === 0) throw new Refusal(`spec '${input.specPath}' declares no files to touch`);
  const check = (): void => {
    const dup = g.db.get<{ id: string }>("moons.byTask", { task_id: taskId });
    if (dup) throw new Refusal(`task '${taskId}' is already assigned to moon ${dup.id}`);
  };
  check();
  const attention = attentionMatches(spec.touch, g.config.routing.attention);

  const moons = g.db.all<MoonRow>("moons.byPlanet", { planet_id: input.planetId });
  let moon: MoonRow | undefined; let discovered = false;
  if (input.moonName !== undefined) {
    moon = moons.find((m) => m.name === input.moonName);
    if (!moon) throw new Refusal(`moon '${input.moonName}' does not exist on planet '${planet.name}'`);
    if (moon.body_status !== "barren") throw new Refusal(`moon '${input.moonName}' is not barren`);
  } else {
    moon = g.db.get<MoonRow>("moons.firstBarren", { planet_id: input.planetId });
    if (!moon) {
      const used = new Set<string>();
      for (const p of g.db.all<PlanetRow>("planets.bySystem", { system_id: planet.system_id }))
        for (const m of g.db.all<MoonRow>("moons.byPlanet", { planet_id: p.id })) used.add(m.name);
      const found = discoverMoon(system.seed, system.theme, planet.orbit_index, moons, used);
      append(g.db, { kind: "moon.discovered", system_id: planet.system_id, planet_id: input.planetId, payload: { moon: found } });
      moon = g.db.get<MoonRow>("moons.byId", { id: `${input.planetId}/${found.name}` })!;
      discovered = true;
    }
  }
  const moonId = moon.id;
  append(g.db, {
    kind: "moon.assigned", system_id: planet.system_id, planet_id: input.planetId, moon_id: moonId, task_id: taskId,
    payload: { task_id: taskId, spec_path: specRel, spec_sha: hashSpec(text).bodySha, touch: spec.touch, depends_on: spec.dependsOn, tier: spec.modelHint ?? "" },
  }, check);

  const categories = Object.keys(attention);
  if (categories.length) {
    append(g.db, { kind: "moon.gate_failed", system_id: planet.system_id, planet_id: input.planetId, moon_id: moonId, task_id: taskId, payload: { check: "attention", reason: "restricted space", categories } });
    append(g.db, {
      kind: "decision.opened", system_id: planet.system_id, planet_id: input.planetId, moon_id: moonId, task_id: taskId,
      payload: { kind: "restricted", target_kind: "moon", target_id: taskId, reasoning: `task '${taskId}' touches restricted space: ${categories.join(", ")}` },
    });
  }
  return { moonId, taskId, discovered, attention };
}
