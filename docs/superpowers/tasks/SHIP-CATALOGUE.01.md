# TASK: catalogue-module

## Meta
- **Task ID**: SHIP-CATALOGUE.01
- **Parent plan**: docs/superpowers/plans/2026-11-19-ship-catalogue.md
- **Depends on**: none
- **Estimated scope**: M
- **Model hint**: sol

## Objective
A pure module `src/core/catalogue/` exists that holds the built-in catalogue of ship weights, formations, cargo kinds and name rules, validates and merges an owner's `.nexus/catalogue.json` into it, and makes seeded picks of a formation, a cargo kind and a ship name.

## Context
Aether Nexus shows automated development work as space traffic: a provider's model does a job and the Bridge shows it as a ship flying to a moon. Today every ship is the same. This plan gives each ship a lasting identity: a *weight* (how strong the model is: `light`, `standard`, `heavy`), a *faction* (one per provider, so a person can tell the provider by looking), and a *formation* (what the ship looks like: a mining vessel, a carrier group with escorts, …) taken from a catalogue the owner can extend. This task builds only the catalogue: data, validation, merging and picking. Nothing calls it yet; later tasks wire it into config, the database and the launch. The design is `docs/superpowers/specs/2026-11-19-ship-catalogue-design.md` §7.3, §7.4, §7.6 — read those sections. Vocabulary rule for every identifier, comment and test name: the job a ship does is a *delivery*; `freighter` and `carrier` are hull or formation names inside catalogue data and nothing else. Affected workflow IDs is `none` because this project has no review suite.

## Files

### Touch
| Path | Action | Notes |
|------|--------|-------|
| `tests/core/catalogue.test.mjs` | create | all behavioral criteria |
| `src/core/catalogue/types.ts` | create | the types below |
| `src/core/catalogue/builtin.ts` | create | `BUILTIN`, `PLAIN_FORMATION` |
| `src/core/catalogue/load.ts` | create | `validateCatalogue`, `mergeCatalogue`, `loadCatalogue` |
| `src/core/catalogue/pick.ts` | create | `pickFormation`, `pickCargo`, `shipName` |

### Do NOT touch
- `src/core/rng.ts`, `src/core/names.ts` — consumed as they are
- `src/core/fleet.ts`, `src/db/**`, `src/server/**`, `src/config/**`, `web/**` — owned by later tasks (SHIP-CATALOGUE.02 and the KEEP tasks 3–7)
- Any file not listed under Touch. If completing the objective seems to require touching an unlisted file, STOP and report BLOCKED.

**Standing exclusions:**
- Security-routed files, never modified by this lane: `src/core/git.ts`, `src/validate/**`, `src/providers/claude-sdk/gate-hook.ts`, `src/server/dispatch.ts`, `src/db/migrations/**`, `src/server/http/auth.ts`, `src/server/lock.ts`
- Pipeline-owned paths: `docs/superpowers/plans/**`, `docs/superpowers/tasks/**`, `.superpowers/sdd/**`
- `package.json`, `package-lock.json` — no dependency changes

## Interfaces

Produced (exact names and shapes; later tasks import them):

```ts
// src/core/catalogue/types.ts
export type ShipJob = "delivery" | "customs" | "transfer" | "survey";
export type Vessel = { hull: string; count: number; role: "lead" | "escort" | "cargo" };
export type Formation = { id: string; name: string; job: ShipJob; weights?: string[]; factions?: string[]; vessels: Vessel[]; art?: string | null };
export type ShipFormation = { id: string; name: string; vessels: Vessel[]; art?: string | null };   // the copy a ship keeps
export type CargoKind = { id: string; label: string; weights?: string[] };
export type NameRules = { pools: Record<string, string[]>; patterns: string[] };
export type Catalogue = { weights: string[]; formations: Formation[]; cargo: CargoKind[]; names: Record<string, NameRules> };

// src/core/catalogue/builtin.ts
export const BUILTIN: Catalogue;
export const PLAIN_FORMATION: ShipFormation;   // exactly { id: "plain", name: "Ship", vessels: [{ hull: "ship", count: 1, role: "lead" }] }

// src/core/catalogue/load.ts
export function validateCatalogue(value: unknown, source: string): string[];
//   Checks one file's content (a partial catalogue is valid: every top-level key is optional).
//   Returns error strings; each names `source` and the entry (for example its id or its index). Empty array = valid.
//   Weight references are checked against value.weights when the file has one, otherwise against BUILTIN.weights.
export function mergeCatalogue(base: Catalogue, extra: Partial<Catalogue>): Catalogue;   // never mutates base or extra
export function loadCatalogue(nexusDir: string): Catalogue;
//   BUILTIN when <nexusDir>/catalogue.json does not exist; otherwise BUILTIN merged with that file.
//   Throws Error when the file is not valid JSON (message names the file path) or fails validation
//   (one message listing every validation error, each naming the file path).

// src/core/catalogue/pick.ts
export function pickFormation(c: Catalogue, q: { job: ShipJob; weight: string; faction: string }, rng: Rng): ShipFormation;
export function pickCargo(c: Catalogue, weight: string, rng: Rng): { id: string; label: string } | null;
export function shipName(c: Catalogue, q: { faction: string; theme: string }, rng: Rng, used: Set<string>): string;   // adds the name to `used`
```

Consumed (exact current code, do not change):

```ts
// src/core/rng.ts
export type Rng = () => number;
export function mulberry32(seed: number): Rng;
export function pick<T>(rng: Rng, items: readonly T[]): T;
// src/core/names.ts
export const THEMES: Record<string, { planets: string[]; moons: string[]; ships: string[] }>;   // keys "classic", "pulp"
export function pickName(rng: Rng, pool: readonly string[], used: Set<string>): string;
//   picks a free name from pool; when none is free appends "-II" … "-X", then a random number, until unique; adds the result to `used`
```

The owner's file has this shape (every key optional):

```jsonc
{
  "weights": ["light", "standard", "heavy"],
  "formations": [
    { "id": "carrier-group", "name": "Carrier group", "job": "delivery", "weights": ["heavy"],
      "vessels": [ { "hull": "carrier", "count": 1, "role": "lead" }, { "hull": "frigate", "count": 4, "role": "escort" } ],
      "factions": [], "art": null }
  ],
  "cargo": [ { "id": "diplomat", "label": "a diplomat", "weights": ["heavy"] } ],
  "names": { "<faction>": { "pools": { "<pool>": ["..."] }, "patterns": ["{adjective} {noun}"] } }
}
```

## Constraints
- Pure module: no database, no config, no clock, no `Math.random`; the only file read is `<nexusDir>/catalogue.json` in `loadCatalogue`. ESM imports with `.js` suffixes, as in `src/core/names.ts`.
- Merge rules: `formations` and `cargo` merge by `id` (an extra entry with a base id replaces it in place; a new id is appended); an extra `weights` list replaces the base list whole; an extra `names.<faction>` replaces that faction's rules whole, other factions stay.
- An entry's `weights` empty or absent means every weight; `factions` empty or absent means every faction.
- `pickFormation` candidates match job, weight and faction; it returns a deep copy holding only `id`, `name`, `vessels` and, when the entry has one, `art`. No candidate → a copy of `PLAIN_FORMATION`. There is no nearest-weight fallback.
- `pickCargo` returns `{ id, label }` of one entry matching the weight, or `null`.
- `shipName`: when `c.names[q.faction]` exists, fill one of its patterns — each `{pool}` placeholder replaced by a word picked from that pool — and make the result unique against `used`; when a generated name is taken, try again a bounded number of times, then fall back to `pickName`'s suffix rule. When the faction has no rules, use `pickName(rng, THEMES[q.theme].ships, used)`; an unknown theme uses `classic`. The returned name is always added to `used` and is never already in it.
- `validateCatalogue` reports: a top-level value that is not an object, or a key of the wrong type; an unknown `job`; a weight that is not in the weight list; a duplicate `id` within `formations` or within `cargo`; a formation with no vessel of role `lead`; a vessel whose `count` is not a positive integer or whose `role` is not one of the three; an empty or non-string `id`, `name`, `label` or `hull`; a pattern naming a pool that does not exist; an empty `patterns` list or an empty pool.
- `BUILTIN` content: weights `["light", "standard", "heavy"]`. Delivery formations — light: mining vessel, courier; standard: freighter, freighter with escort; heavy: carrier group, freighter convoy, heavy freighter with military escort. Customs: one customs cutter with no `weights` (every weight). No built-in formation has `factions`. Cargo — light: ore samples, spare parts; standard: trade goods, machine tools; heavy: a diplomat, precious cargo, relief supplies. Name rules for factions `openai` and `anthropic`, with different word pools so the two sound different, each able to produce at least 400 distinct names. Ids are lower-case kebab-case.
- No new dependencies. Tests use `node:test` and `node:assert/strict` and import from `dist/` (the test command builds first), as `tests/core/fleet.test.mjs` does; a test that needs a catalogue file writes it into a temp directory made with `fs.mkdtempSync`.

## Acceptance

**Test command (must exit 0):**
```bash
npm test -- "tests/core/catalogue.test.mjs"
```
The first Touch entry creates this test.

**Behavioral criteria** (each covered by a test in `tests/core/catalogue.test.mjs`):
1. `validateCatalogue(BUILTIN, "builtin")` is empty; `BUILTIN` has at least one delivery formation for each of `light`, `standard`, `heavy`, a customs formation matching every weight, and cargo for each weight; `PLAIN_FORMATION` deep-equals the literal above.
2. `pickFormation` over 200 seeds only returns entries matching job, weight and faction; with a catalogue holding a formation limited to `["anthropic"]`, it is never returned for faction `openai` and is returned for `anthropic`.
3. The same seed gives the same formation, cargo and name; two different seeds can give different ones.
4. No matching formation → deep-equal to `PLAIN_FORMATION`; `pickCargo` with no match → `null`; a catalogue with empty `formations` and `cargo` still answers both.
5. Merge: a same-id formation replaces, a new id adds, the same for cargo; `weights` replaces whole; `names.<faction>` replaces whole and leaves other factions; neither argument is mutated.
6. `loadCatalogue` on a directory with no file returns a catalogue deep-equal to `BUILTIN`; with a valid file, the merged result; with invalid JSON, throws naming the path; with a file holding two bad entries (an unknown job and an unknown weight), throws one error naming the path and both entries.
7. Each validation rule listed in Constraints rejects a minimal bad input with an error naming the source.
8. 500 calls of `shipName` for one faction with rules against one growing `used` set give 500 distinct names, and the same for a faction without rules (theme list, suffix rule).
9. A faction with no rules gets a name from `THEMES.classic.ships` when the theme is `classic` or unknown, and from `THEMES.pulp.ships` when the theme is `pulp`.
10. The returned formation is a copy: mutating it and its vessels does not change the catalogue or `PLAIN_FORMATION`.

**Affected workflow IDs**: none

**Regression guard (task level — implementer runs this):**
```bash
npm test
```

## Out of Scope
- Do not call the catalogue from any other module, the config, the database or the page.
- Do not change `names.ts`, `rng.ts` or `fleet.ts`.
- Do not add images or read the `art` field.
- Do not update documentation.
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
