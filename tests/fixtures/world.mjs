import { append } from "../../dist/db/events.js";
import { generateSystem } from "../../dist/core/bodies.js";

export function seedSystem(db, id = "S-20261013-demo", seed = 42) {
  const gen = generateSystem(seed);
  append(db, { kind: "system.created", system_id: id, payload: { kind: "feature", title: "Demo", brief: "demo brief", base_sha: "0".repeat(40), integration_branch: `system/${id}/integration`, seed, theme: gen.theme, planets: gen.planets } });
  return gen;
}
