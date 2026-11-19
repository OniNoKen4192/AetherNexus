# TASK: config-faction-weights

## Meta
- **Task ID**: SHIP-CATALOGUE.02
- **Parent plan**: docs/superpowers/plans/2026-11-19-ship-catalogue.md
- **Depends on**: SHIP-CATALOGUE.01 (the catalogue module)
- **Estimated scope**: M
- **Model hint**: sol

## Objective
A provider in `.nexus/config.json` can declare a `faction` and a `weights` map; two pure functions answer "which faction flies for this provider" and "what weight is this trip"; and an opened galaxy carries the merged catalogue, refusing to open when the catalogue file is invalid or the config names a weight the catalogue does not list.

## Context
Aether Nexus shows automated development work as space traffic. This plan gives each ship a *weight* (how strong the model is: `light`, `standard`, `heavy`) and a *faction* (one per provider). SHIP-CATALOGUE.01 (merged) added the catalogue module `src/core/catalogue/`. This task adds the configuration that maps a provider to a faction and a model or tier to a weight, and loads the catalogue when a galaxy is opened. Nothing reads the weight yet: later KEEP tasks use `weightFor` inside the launch. The design is `docs/superpowers/specs/2026-11-19-ship-catalogue-design.md` §7.5 — read it. A "tier" is the name a moon's spec asks for (`sol`, `terra`, `luna`); it describes the delivery, not the reviewer, which is why a review ignores it. Vocabulary rule for every identifier, comment and test name: the job is a *delivery*; do not use `freighter` or `carrier` for it. Affected workflow IDs is `none` because this project has no review suite.

## Files

### Touch
| Path | Action | Notes |
|------|--------|-------|
| `tests/config/faction-weights.test.mjs` | create | schema, defaults, `weightFor`, `factionOf` |
| `tests/server/galaxy-catalogue.test.mjs` | create | the galaxy carries the catalogue; refusals |
| `src/core/weight.ts` | create | `factionOf`, `weightFor` |
| `src/config/schema.ts` | modify | `faction`, `weights` on `ProviderConfig`; validation; normalization; defaults |
| `src/server/galaxy.ts` | modify | `Galaxy.catalogue`; load and check in `openGalaxy` |
| `templates/config.example.md` | modify | one new section at the end |

### Do NOT touch
- `src/core/catalogue/**` — owned by SHIP-CATALOGUE.01; consumed as it is
- `tests/config/schema.test.mjs`, `tests/config/pool-refuel.test.mjs`, `tests/conformance.test.mjs` and every other existing test — they must keep passing unchanged
- `templates/config.example.json`, `tests/helpers.mjs`
- `src/core/fleet.ts`, `src/server/commands/**`, `src/server/limiter/**`, `src/db/**`, `web/**` — owned by later tasks
- Any file not listed under Touch. If completing the objective seems to require touching an unlisted file, STOP and report BLOCKED.

**Standing exclusions:**
- Security-routed files, never modified by this lane: `src/core/git.ts`, `src/validate/**`, `src/providers/claude-sdk/gate-hook.ts`, `src/server/dispatch.ts`, `src/db/migrations/**`, `src/server/http/auth.ts`, `src/server/lock.ts`
- Pipeline-owned paths: `docs/superpowers/plans/**`, `docs/superpowers/tasks/**`, `.superpowers/sdd/**`
- `package.json`, `package-lock.json` — no dependency changes

## Interfaces

Produced:

```ts
// src/config/schema.ts — ProviderConfig gains two optional keys
faction?: string;                       // after normalizeConfig: always present; default = the provider id
weights?: Record<string, string>;       // keys: a model id, a tier name, or "default"; values: a weight name
// PROVIDER_KEYS gains "faction" and "weights"

// src/server/galaxy.ts — Galaxy gains
catalogue: Catalogue;                   // import type { Catalogue } from "../core/catalogue/types.js"

// src/core/weight.ts
import type { NexusConfig } from "../config/schema.js";
import type { Role } from "../providers/adapter.js";
export function factionOf(config: NexusConfig, provider: string): string;
//   config.providers[provider].faction, or the provider id when the provider or the key is missing
export function weightFor(config: NexusConfig, provider: string, q: { role: Role; model?: string; tier?: string | null }): string;
```

Consumed (exact current code):

```ts
// src/core/catalogue/load.ts (SHIP-CATALOGUE.01)
export function loadCatalogue(nexusDir: string): Catalogue;   // BUILTIN merged with <nexusDir>/catalogue.json; throws Error naming the file when it is invalid
// src/core/catalogue/builtin.ts
export const BUILTIN: Catalogue;                              // BUILTIN.weights is ["light", "standard", "heavy"]
// src/providers/adapter.ts
export type Role = "implement" | "review";
// src/server/errors.ts
export class Refusal extends Error
// src/config/schema.ts
const PROVIDER_KEYS = ["adapter", "auth", "api_key_env", "models", "tiers", "ratelimit_signal", "pool", "command", "endpoint", "max_budget_usd", "max_turns"];
export function validateConfig(cfg: unknown): string[];
export function normalizeConfig(cfg: unknown): NexusConfig;   // throws Error(errors.join("; "))
export const DEFAULT_CONFIG: NexusConfig;
// src/server/galaxy.ts — current body of openGalaxy
export function openGalaxy(repoRoot: string, opts: { scriptsDir?: string } = {}): Galaxy {
  if (!fs.existsSync(path.join(repoRoot, ".nexus", "config.json"))) throw new Refusal(".nexus/config.json not found — run 'nexus init' first");
  let config: NexusConfig;
  try { config = loadConfig(repoRoot); } catch (err) { throw new Refusal((err as Error).message); }
  const paths = galaxyPaths(repoRoot, config);
  const db = openDb(paths.dbFile, { stats: config.db.stats });
  const git = new Git(repoRoot);
  const adapters = buildAdapters(config, { scriptsDir: opts.scriptsDir ?? defaultScriptsDir(repoRoot) });
  return { repoRoot, config, db, git, adapters, now: () => Date.now(), paths, close: () => db.close() };
}
```

## Constraints
- `weightFor` lookup over `config.providers[provider].weights` (treat a missing provider or map as empty), first hit wins:
  1. `weights[q.model]` when `q.model` is given;
  2. `weights[q.tier]` only when `q.role === "implement"`, `q.model` is not given and `q.tier` is a string;
  3. `weights.default`;
  4. the string `"standard"`.
  Use own-property lookups (`Object.hasOwn`), so a tier named `constructor` cannot hit the prototype.
- Validation, in the existing style of the provider loop in `validateConfig`: `faction`, when present, must be a non-empty string → `'providers.<id>.faction' must be a non-empty string`; `weights`, when present, must be an object whose values are all non-empty strings → `'providers.<id>.weights' must be an object mapping a model id, a tier name or "default" to a weight name`.
- `normalizeConfig` sets `faction` to the provider id when absent. It does not add a `weights` map.
- `DEFAULT_CONFIG`: `codex` gains `faction: "openai"`, `weights: { sol: "heavy", terra: "standard", luna: "light" }`; `claude` gains `faction: "anthropic"`, `weights: { default: "heavy", "claude-haiku-5-5": "light" }`; `fake` is unchanged in the literal (it normalizes to faction `"fake"`).
- `openGalaxy`: load the catalogue from `paths.nexusDir` and check every provider's `weights` values against `catalogue.weights` **before** the database is opened, so a refusal leaves no handle open. Both failures throw `Refusal`: an invalid catalogue file with `loadCatalogue`'s message; an unknown weight with a message naming the provider, the key and the weight, for example `'providers.codex.weights.sol' names weight 'huge', which the catalogue does not list (light, standard, heavy)`. All unknown weights are reported in one message.
- The schema keeps accepting `fleet.freighters`, `fleet.customs`, `fleet.carriers`, `fleet.surveyors` unchanged.
- `templates/config.example.md`: append one section headed ``## AetherNexus: `providers.<id>.faction` and `weights`  (`.nexus/config.json`, schema v2)`` after the existing `pool` section: what the two keys mean, the lookup order, the defaults, that a weight must be listed in the catalogue, and that `.nexus/catalogue.json` (optional) adds formations, cargo and name rules and is read when the galaxy is opened. Under 40 lines. Change nothing else in the file.
- No new dependencies. Tests use `node:test` and `node:assert/strict` and import from `dist/` (the test command builds first). Follow `tests/config/pool-refuel.test.mjs` for schema tests. For galaxy tests use `makeGalaxy` from `tests/helpers.mjs` (it returns `{ dir, g, cleanup }`; always pin `c.roles = { implement: ["fake"], review: ["fake"] }` in the config patch); to test a refusal, close that galaxy, write `.nexus/catalogue.json` or edit `.nexus/config.json` in `dir`, and call `openGalaxy(dir, …)` from `dist/server/galaxy.js` again. No test dispatches a voyage.

## Acceptance

**Test command (must exit 0):**
```bash
npm test -- "tests/config/faction-weights.test.mjs" "tests/server/galaxy-catalogue.test.mjs"
```
The first two Touch entries create these tests.

**Behavioral criteria** (each covered by a test in the two new files):
1. `weightFor`, one test per rung: a model id hit; a tier hit for `implement` with no model; a tier name is ignored when a model is given (falls to `default`); a tier name is ignored for `role: "review"`; `default`; `"standard"` when the map is empty or absent; an unknown provider gives `"standard"`; `tier: null` is skipped.
2. With `normalizeConfig(DEFAULT_CONFIG)`: `factionOf` gives `openai`, `anthropic`, `fake` for `codex`, `claude`, `fake`; `weightFor` gives `heavy` / `standard` / `light` for codex deliveries at tiers `sol` / `terra` / `luna`, `heavy` for a claude review, `light` for claude with `model: "claude-haiku-5-5"`, `standard` for `fake`.
3. `normalizeConfig` fills `faction` with the provider id when absent and keeps an explicit one; `validateConfig(DEFAULT_CONFIG)` is empty.
4. Each malformed value is rejected with its path: `faction` of `""`, `7`; `weights` of `[]`, `"heavy"`, `{ sol: 7 }`, `{ sol: "" }`.
5. A galaxy opened with no catalogue file has `g.catalogue` deep-equal to `BUILTIN`; with an owner file adding one formation, `g.catalogue.formations` contains it beside the built-in ones.
6. `openGalaxy` throws a `Refusal` naming `catalogue.json` for a file that is not valid JSON and for one with an unknown job; it throws a `Refusal` naming provider, key and weight when the config has `weights: { sol: "huge" }`. After each refusal the database file can be opened and closed again by a correct galaxy (no handle left open), and `.nexus/nexus.db` can be renamed on disk.
7. A weight added by the owner's catalogue (`"weights": ["light", "standard", "heavy", "colossal"]`) is accepted in a provider's `weights`.

**Affected workflow IDs**: none

**Regression guard (task level — implementer runs this):**
```bash
npm test
```

## Out of Scope
- Do not call `weightFor` or `factionOf` from the dispatcher, the limiter or any command.
- Do not change how the fleet is created or picked; do not remove the `fleet.*` count keys.
- Do not reload the catalogue when the config is reloaded by a running server.
- Do not edit `templates/config.example.json`.
- Do not fix unrelated failing tests — report them instead.

## Report Format
Return exactly this structure:

```
STATUS: IMPLEMENTED | IMPLEMENTED_WITH_DEVIATIONS | BLOCKED | BACKEND_FAILURE | RATE_LIMITED
FILES_CHANGED: <list with one-line summary each>
TEST_OUTPUT: <last 20 lines of the acceptance command>
DEVIATIONS: <anything done differently than specified, and why — or "none".
  IMPLEMENTED requires "none"; IMPLEMENTED_WITH_DEVIATIONS requires a
  non-empty list>
BLOCKED_REASON: <only if BLOCKED: what was needed that the spec didn't provide>
```
