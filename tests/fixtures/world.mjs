import { makeGalaxy, writeSpec, read } from "../helpers.mjs";
import { createSystem } from "../../dist/server/commands/system.js";
import { assignPlanet, assignMoon } from "../../dist/server/commands/assign.js";
import { append } from "../../dist/db/events.js";
import { generateSystem } from "../../dist/core/bodies.js";
import { slug } from "../../dist/core/fleet.js";

/**
 * Config for scheduler fuel scenarios. The fixture specs use the `terra` tier.
 * The optional callback deliberately runs last so individual scenarios can
 * adjust one setting without losing the fake-only provider guard.
 */
export function fuelPatch(opts = {}, extra) {
  return (c) => {
    c.providers.fake = {
      ...c.providers.fake,
      adapter: "fake",
      pool: {
        kind: "window",
        reserve_floor: 0.1,
        ...(opts.refuel ? {
          refuel: {
            provider: "spare",
            models: { terra: "m-cheap" },
            min_wait_minutes: opts.refuel.min_wait_minutes,
          },
        } : {}),
      },
    };
    c.providers.spare = { adapter: "fake", pool: { kind: "window", reserve_floor: 0.25 } };
    c.roles = { implement: ["fake"], review: ["fake"] };
    c.routing.security_routed = ["src/auth.ts"];
    c.routing.do_not_touch = [".env"];
    extra?.(c);
  };
}

/**
 * Config for ship scenarios: two fake providers with their own faction and weights. Runs `extra` last.
 *   fake:  adapter "fake", faction "tinkers",   weights { sol: "heavy", terra: "standard", luna: "light" }, pool { kind: "window", reserve_floor: 0.1, refuel? }
 *   spare: adapter "fake", faction "outriders", weights { "m-cheap": "light", default: "heavy" },           pool { kind: "window", reserve_floor: 0.25 }
 *   opts.refuel = { min_wait_minutes } adds fake.pool.refuel = { provider: "spare", models: { terra: "m-cheap" }, min_wait_minutes }
 *   roles { implement: ["fake"], review: ["fake"] }; routing.security_routed ["src/auth.ts"]; routing.do_not_touch [".env"]
 */
export function shipsPatch(opts = {}, extra) {
  return (c) => {
    c.providers.fake = {
      ...c.providers.fake,
      adapter: "fake",
      faction: "tinkers",
      weights: { sol: "heavy", terra: "standard", luna: "light" },
      pool: {
        kind: "window",
        reserve_floor: 0.1,
        ...(opts.refuel ? {
          refuel: {
            provider: "spare",
            models: { terra: "m-cheap" },
            min_wait_minutes: opts.refuel.min_wait_minutes,
          },
        } : {}),
      },
    };
    c.providers.spare = {
      adapter: "fake",
      faction: "outriders",
      weights: { "m-cheap": "light", default: "heavy" },
      pool: { kind: "window", reserve_floor: 0.25 },
    };
    c.roles = { implement: ["fake"], review: ["fake"] };
    c.routing.security_routed = ["src/auth.ts"];
    c.routing.do_not_touch = [".env"];
    extra?.(c);
  };
}

export function seedSystem(db, id = "S-20261013-demo", seed = 42) {
  const gen = generateSystem(seed);
  append(db, { kind: "system.created", system_id: id, payload: { kind: "feature", title: "Demo", brief: "demo brief", base_sha: "0".repeat(40), integration_branch: `system/${id}/integration`, seed, theme: gen.theme, planets: gen.planets } });
  return gen;
}

// A fleet as a galaxy made before ships were commissioned on demand registered it: `ship.registered` events with a class.
// Reducer tests use it to have idle ships without a launch; such ships read as standard weight with a legacy formation.
const LEGACY_NAMES = ["Vigilant", "Slow Thunder", "Pilgrim", "Pale Meridian", "Kindly Keel", "Dawn Treader", "Meridian", "Steadfast", "Far Harbor", "Wayfarer", "Sojourner", "Resolute", "Intrepid", "Concord", "Sentinel"];
export function seedFleet(db, fleets = ["fake"]) {
  const ships = []; let n = 0;
  for (const fleet of fleets) for (const [cls, count] of [["freighter", 2], ["customs", 1], ["carrier", 1], ["surveyor", 1]]) {
    for (let i = 0; i < count; i++) { const name = LEGACY_NAMES[n++]; ships.push({ id: slug(name), name, class: cls, fleet }); }
  }
  for (const ship of ships) append(db, { kind: "ship.registered", ship_id: ship.id, provider: ship.fleet, payload: { ship } });
  return ships;
}

/**
 * An idle ship to raw-append a `voyage.launched` on, for a test that does not run a real launch. Returns the idle ship of
 * this fleet, job and weight when there is one; otherwise commissions one (as a launch would) and returns its row.
 */
export function idleShip(db, fleet = "fake", job = "delivery", weight = "standard") {
  const idle = db.get("ships.pickIdle", { job, fleet, weight });
  if (idle) return idle;
  const n = db.all("ships.all").length + 1;
  const ship = { id: `test-ship-${n}`, name: `Test Ship ${n}`, fleet, job, faction: fleet, weight, formation: { id: "plain", name: "Ship", vessels: [{ hull: "ship", count: 1, role: "lead" }] } };
  append(db, { kind: "ship.commissioned", ship_id: ship.id, provider: fleet, payload: { ship } });
  return db.get("ships.byId", { id: ship.id });
}

/**
 * Write and commit one spec per entry into the galaxy's repo and return their repo-relative paths, in order.
 * deps are task ids for the spec's "Depends on" line; scripts are FAKE-SCRIPT names, each written as its own comment.
 */
export function writeSpecs(w, entries) {
  const template = read("tests/fixtures/specs/good-basic.md");
  const paths = entries.map(({ id, deps = [], scripts = [], tier }) => {
    const comments = scripts.map((name) => `<!-- FAKE-SCRIPT: ${name} -->`).join("\n");
    let body = template.replace(/^- \*\*Depends on\*\*:.*$/m, `- **Depends on**: ${deps.length ? deps.join(", ") : "none"}`);
    if (tier !== undefined) body = body.replace(/^- \*\*Model hint\*\*:.*$/m, `- **Model hint**: ${tier}`);
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
