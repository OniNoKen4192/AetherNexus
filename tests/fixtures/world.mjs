import { makeGalaxy, writeSpec, read } from "../helpers.mjs";
import { createSystem } from "../../dist/server/commands/system.js";
import { assignPlanet, assignMoon } from "../../dist/server/commands/assign.js";
import { append } from "../../dist/db/events.js";
import { generateSystem } from "../../dist/core/bodies.js";
import { generateFleet } from "../../dist/core/fleet.js";

export function seedSystem(db, id = "S-20261013-demo", seed = 42) {
  const gen = generateSystem(seed);
  append(db, { kind: "system.created", system_id: id, payload: { kind: "feature", title: "Demo", brief: "demo brief", base_sha: "0".repeat(40), integration_branch: `system/${id}/integration`, seed, theme: gen.theme, planets: gen.planets } });
  return gen;
}

export function seedFleet(db, fleets = ["fake"]) {
  const ships = generateFleet(1, "classic", { freighters: 2, customs: 1, carriers: 1, surveyors: 1 }, fleets);
  for (const ship of ships) append(db, { kind: "ship.registered", ship_id: ship.id, provider: ship.fleet, payload: { ship } });
  return ships;
}

/**
 * Write and commit one spec per entry into the galaxy's repo and return their repo-relative paths, in order.
 * deps are task ids for the spec's "Depends on" line; scripts are FAKE-SCRIPT names, each written as its own comment.
 */
export function writeSpecs(w, entries) {
  const template = read("tests/fixtures/specs/good-basic.md");
  const paths = entries.map(({ id, deps = [], scripts = [] }) => {
    const comments = scripts.map((name) => `<!-- FAKE-SCRIPT: ${name} -->`).join("\n");
    let body = template.replace(/^- \*\*Depends on\*\*:.*$/m, `- **Depends on**: ${deps.length ? deps.join(", ") : "none"}`);
    if (comments) body = body.replace("# TASK: thing-add-x", `# TASK: thing-add-x\n${comments}`);
    return writeSpec(w.dir, id, body);
  });
  w.git("add", "-A");
  w.git("commit", "-qm", "specs");
  return paths;
}

// A galaxy with one system, one planet and one assigned moon (task T1) whose spec names the fake implement script.
export async function worldWithMoon(script = "happy", patch, patchSpec) {
  const w = await makeGalaxy(patch); const { systemId } = createSystem(w.g, { slug: "s", title: "t", brief: "b", seed: 1 });
  const { planetId } = assignPlanet(w.g, { systemId, streamId: "P1", mission: "m", territory: ["src/**"] });
  let text = read("tests/fixtures/specs/good-basic.md").replace("# TASK: thing-add-x", `# TASK: thing-add-x\n<!-- FAKE-SCRIPT: ${script} -->`);
  if (patchSpec) text = patchSpec(text);
  const spec = writeSpec(w.dir, "T1", text); w.git("add", "-A"); w.git("commit", "-qm", "spec");
  const { moonId } = assignMoon(w.g, { planetId, specPath: spec });
  return { ...w, systemId, planetId, moonId };
}

// Two moons (T1, T2) on the same planet; each spec names its own fake implement script.
export async function worldWithTwoMoons(scriptA = "happy", scriptB = "happy", patch) {
  const w = await makeGalaxy(patch); const { systemId } = createSystem(w.g, { slug: "s", title: "t", brief: "b", seed: 1 });
  const { planetId } = assignPlanet(w.g, { systemId, streamId: "P1", mission: "m", territory: ["src/**"] });
  const mk = (id, script) => writeSpec(w.dir, id, read("tests/fixtures/specs/good-basic.md").replace("# TASK: thing-add-x", `# TASK: thing-add-x\n<!-- FAKE-SCRIPT: ${script} -->`));
  const s1 = mk("T1", scriptA), s2 = mk("T2", scriptB); w.git("add", "-A"); w.git("commit", "-qm", "specs");
  assignMoon(w.g, { planetId, specPath: s1 }); assignMoon(w.g, { planetId, specPath: s2 });
  return { ...w, systemId, planetId };
}
