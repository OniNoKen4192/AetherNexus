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

// A galaxy with one system, one planet and one assigned moon (task T1) whose spec names the fake implement script.
export async function worldWithMoon(script = "happy", patch) {
  const w = await makeGalaxy(patch); const { systemId } = createSystem(w.g, { slug: "s", title: "t", brief: "b", seed: 1 });
  const { planetId } = assignPlanet(w.g, { systemId, streamId: "P1", mission: "m", territory: ["src/**"] });
  const text = read("tests/fixtures/specs/good-basic.md").replace("# TASK: thing-add-x", `# TASK: thing-add-x\n<!-- FAKE-SCRIPT: ${script} -->`);
  const spec = writeSpec(w.dir, "T1", text); w.git("add", "-A"); w.git("commit", "-qm", "spec");
  const { moonId } = assignMoon(w.g, { planetId, specPath: spec });
  return { ...w, systemId, planetId, moonId };
}
