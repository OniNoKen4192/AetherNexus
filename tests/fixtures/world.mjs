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
