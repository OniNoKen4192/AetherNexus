// tests/config/schema.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateConfig, normalizeConfig, DEFAULT_CONFIG } from "../../dist/config/schema.js";

const VALID = {
  schema_version: 2,
  project: { app_subdir: "myapp", command_prefix: "cd myapp &&" },
  commands: { test: "pnpm vitest run", lint: "pnpm eslint", typecheck: "pnpm tsc --noEmit", acceptance_runner: "pnpm vitest run" },
  providers: {
    codex: { adapter: "codex-mcp", tiers: ["sol", "terra", "luna"], ratelimit_signal: ["usage-cap", "429", "rate limit"], pool: { kind: "window", reserve_floor: 0.1 } },
    claude: { adapter: "claude-sdk", auth: "login", models: { frontier: "claude-opus-5-5" }, pool: { kind: "window", reserve_floor: 0.25 } },
    fake: { adapter: "fake" },
  },
  roles: { implement: ["codex", "fake"], review: ["claude", "fake"] },
  routing: { security_routed: ["src/auth.ts", "prisma/migrations/**"], do_not_touch: ["pnpm-lock.yaml", ".env"] },
  pipeline: { plans_dir: ".nexus/plans", tasks_dir: ".nexus/specs", ledger: "docs/nexus/manifest.md" },
};

// [label, mutate(clone), expected error substring | null]
const VECTORS = [
  // --- carried over from the v1 vectors where the key survives
  ["valid config", () => {}, null],
  ["review_suite present", (c) => { c.review_suite = { suite_command: "pnpm test:ux", id_pattern: "<id>-", id_index: "docs/workflows.md", route_map: { "src/app/admin/**": ["a1", "a2"] } }; }, null],
  ["empty lint allowed", (c) => { c.commands.lint = ""; }, null],
  ["empty routing lists allowed", (c) => { c.routing.security_routed = []; c.routing.do_not_touch = []; }, null],
  ["misspelled key", (c) => { c.routing.securty_routed = c.routing.security_routed; delete c.routing.security_routed; }, "unknown key"],
  ["unknown top-level key", (c) => { c.extra = 1; }, "unknown key 'extra'"],
  ["schema_version as string", (c) => { c.schema_version = "2"; }, "schema_version"],
  ["schema_version v1 names the migration", (c) => { c.schema_version = 1; }, "Lanes v1 config"],
  ["missing required block", (c) => { delete c.providers; }, "required block 'providers'"],
  ["empty test command", (c) => { c.commands.test = ""; }, "commands.test"],
  ["route_map value not an array", (c) => { c.review_suite = { suite_command: "x", id_pattern: "<id>-", id_index: "y", route_map: { "a/**": "a1" } }; }, "route_map"],
  ["automation manual", (c) => { c.automation = { level: "manual" }; }, null],
  ["automation verdicts", (c) => { c.automation = { level: "verdicts" }; }, null],
  ["automation roundabout with cap", (c) => { c.automation = { level: "roundabout", max_fix_rounds: 3 }; }, null],
  ["automation absent is valid", (c) => { delete c.automation; }, null],
  ["automation bad level", (c) => { c.automation = { level: "yolo" }; }, "automation.level"],
  ["automation missing level", (c) => { c.automation = { max_fix_rounds: 2 }; }, "required field 'automation.level'"],
  ["automation unknown key", (c) => { c.automation = { level: "manual", turbo: true }; }, "unknown key 'automation.turbo'"],
  ["automation zero cap", (c) => { c.automation = { level: "roundabout", max_fix_rounds: 0 }; }, "integer >= 1"],
  ["automation string cap", (c) => { c.automation = { level: "roundabout", max_fix_rounds: "2" }; }, "integer >= 1"],
  ["automation highways", (c) => { c.automation = { level: "highways" }; }, null],
  ["automation autopilot (new rung)", (c) => { c.automation = { level: "autopilot" }; }, null],
  ["automation legacy conveyor names the rename", (c) => { c.automation = { level: "conveyor" }; }, 'renamed to "roundabout"'],
  ["attention empty map", (c) => { c.routing.attention = {}; }, null],
  ["attention valid map", (c) => { c.routing.attention = { billing: ["src/billing/**"], schema: ["prisma/migrations/**"] }; }, null],
  ["attention not an object", (c) => { c.routing.attention = ["src/billing/**"]; }, "routing.attention"],
  ["attention category not an array", (c) => { c.routing.attention = { billing: "src/billing/**" }; }, "routing.attention"],
  ["attention non-string glob", (c) => { c.routing.attention = { billing: [1] }; }, "routing.attention"],
  // --- v1 backend.* vectors, re-pointed at providers.*
  ["tiers wrong type", (c) => { c.providers.codex.tiers = "sol"; }, "array of strings"],
  ["tiers empty", (c) => { c.providers.codex.tiers = []; }, "non-empty"],
  ["ratelimit_signal wrong type", (c) => { c.providers.codex.ratelimit_signal = "429"; }, "array of strings"],
  // --- v2-only
  ["providers empty", (c) => { c.providers = {}; }, "at least one provider"],
  ["provider unknown adapter", (c) => { c.providers.x = { adapter: "gpt" }; }, "providers.x.adapter"],
  ["provider unknown key", (c) => { c.providers.codex.turbo = true; }, "unknown key 'providers.codex.turbo'"],
  ["claude bad auth", (c) => { c.providers.claude.auth = "magic"; }, "providers.claude.auth"],
  ["auth on non-claude adapter", (c) => { c.providers.codex.auth = "login"; }, "only valid for adapter 'claude-sdk'"],
  ["pool bad kind", (c) => { c.providers.codex.pool = { kind: "big" }; }, "pool.kind"],
  ["pool floor out of range", (c) => { c.providers.codex.pool = { kind: "window", reserve_floor: 1.5 }; }, "reserve_floor"],
  ["roles name unknown provider", (c) => { c.roles.implement = ["gemini"]; }, "roles.implement names unknown provider 'gemini'"],
  ["roles missing review", (c) => { delete c.roles.review; }, "required field 'roles.review'"],
  ["roles absent is valid (defaults to all providers)", (c) => { delete c.roles; }, null],
  ["db stats not boolean", (c) => { c.db = { stats: "yes" }; }, "db.stats"],
  ["fleet counts must be posint", (c) => { c.fleet = { freighters: 0 }; }, "fleet.freighters"],
  ["scheduler accepted", (c) => { c.scheduler = { max_concurrent_ships: 6, max_concurrent_systems: 1, per_provider_max: { codex: 4 } }; }, null],
  ["intake/idle/gravity accepted as objects", (c) => { c.intake = { bridge: true }; c.idle = { cosmetic: true }; c.gravity = { gate_above: 8 }; }, null],
  ["intake not an object", (c) => { c.intake = "github"; }, "'intake' must be a JSON object"],
];

for (const [label, mutate, want] of VECTORS) {
  test(`schema v2: ${label}`, () => {
    const cfg = structuredClone(VALID); mutate(cfg);
    const errors = validateConfig(cfg);
    if (want === null) assert.deepEqual(errors, []);
    else assert.ok(errors.some((e) => e.includes(want)), `expected an error containing ${JSON.stringify(want)}, got ${JSON.stringify(errors)}`);
  });
}

test("normalizeConfig fills defaults", () => {
  const n = normalizeConfig(structuredClone(VALID));
  assert.deepEqual(n.automation, { level: "manual", max_fix_rounds: 2 });
  assert.deepEqual(n.routing.attention, {});
  assert.deepEqual(n.db, { stats: false });
  assert.deepEqual(n.fleet, { freighters: 6, customs: 2, carriers: 1, surveyors: 1, name_theme: "classic" });
  assert.deepEqual(n.scheduler, { max_concurrent_ships: 6, max_concurrent_systems: 1, per_provider_max: {} });
  assert.equal(n.providers.claude.auth, "login");
  assert.equal(n.providers.claude.api_key_env, "ANTHROPIC_API_KEY");
});

test("normalizeConfig throws with all errors joined", () => {
  assert.throws(() => normalizeConfig({ schema_version: 2 }), /required block 'project'.*required block 'commands'/s);
});

test("DEFAULT_CONFIG validates and names fake, codex, claude", () => {
  assert.deepEqual(validateConfig(DEFAULT_CONFIG), []);
  assert.deepEqual(Object.keys(DEFAULT_CONFIG.providers).sort(), ["claude", "codex", "fake"]);
});
