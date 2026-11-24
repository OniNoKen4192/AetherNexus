# Ship catalogue — ships with a lasting identity, formations by weight, factions by provider — Implementation Plan

> **For agentic workers:** this plan is lane-tagged for Lanes (`.lanes/config.json`). Run it with `/lanes-run`: DELEGATE tasks are emitted as specs and dispatched; KEEP tasks use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a ship is a permanent record (name, faction, job, weight, formation) commissioned on demand; a delivery's weight comes from its model, its look from a catalogue the owner can extend, its cargo is drawn per trip; the Bridge and CLI show all of it in words.

**Architecture:** A pure catalogue module (`src/core/catalogue/`) holds weights, formations, cargo and name rules, merged from built-in data and `.nexus/catalogue.json`. Migration 003 turns ship `class` into `job` and adds `faction`, `weight`, `formation`; voyages gain `cargo`. `runVoyage` picks an idle ship of the right fleet, job and weight or commissions one (`ship.commissioned`) in the same transaction as `voyage.launched`. Everything a projection shows is copied into the event, so `rebuild` never reads the catalogue or the config.

**Tech Stack:** Node ≥ 22.13, TypeScript, `node:sqlite`; Preact + Vite for the page; tests with `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-19-ship-catalogue-design.md` (read it first; section numbers below refer to it).

## Global Constraints

- **Vocabulary (spec §2).** The job is a *delivery*. `freighter` and `carrier` are hull or formation names in the catalogue and nothing else: no identifier, message, comment or test name added by this plan uses them for the job. Places don't move; ships do.
- No new dependencies of any kind. No model call anywhere in this plan.
- Every state change is an appended event with a reducer; after any test scenario `rebuild` must leave `dumpProjections` byte-equal. A reducer never reads the catalogue, the config or the clock.
- A trip is never refused or delayed because of the catalogue (spec §5): a missing entry falls back to the plain formation; missing cargo is simply absent.
- An edit to the catalogue never changes an existing ship or a flown voyage: the ship carries a full copy of its formation.
- SQL lives only in `src/db/statements.ts` (see `tests/db/registry.test.mjs`).
- Picks are seeded (`mulberry32`) from `fleet.seed` and database state read inside the transaction; no `Math.random`, no clock.
- No numeric cap on open deliveries (spec §7.9). The only limits are `scheduler.max_concurrent_ships`, `scheduler.per_provider_max`, dependencies and fuel.
- No test calls a real provider: `makeGalaxy` guards it, and a config patch pins `c.roles` to fake providers.
- Security-routed files are edited only in the KEEP tasks that name them: `src/db/migrations/003.sql` (Task 3) and `src/server/dispatch.ts` (Tasks 3, 4, 7). Those tasks stop for the owner's go before they start.
- Tests import from `dist/`; `npm test` builds first. One area: `npm test -- "tests/<dir>/*.test.mjs"`. Never two `npm test` at once in one tree.
- Each task lands as one commit on branch `design/ship-catalogue`. End commit messages with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.

**Before the run:** set `pipeline.ledger` in `.lanes/config.json` to `.superpowers/sdd/2026-11-19-ship-catalogue/progress.md`. PR #6 (the command rename) must be merged and this branch rebased on `main`.

## Task/Lane Map

| task | lane | tier | depends-on |
|---|---|---|---|
| 1 Catalogue module: types, built-in data, load, merge, picks | DELEGATE | sol | — |
| 2 Config: `faction`, `weights`, weight lookup; galaxy carries the catalogue | DELEGATE | sol | 1 |
| 3 Migration 003, ship job, `ship.commissioned`, voyage cargo | KEEP | — | 2 |
| 4 Commission on demand in `runVoyage`; idle-ship prechecks removed | KEEP | — | 3 |
| 5 Reads and CLI: ship fields, voyage cargo, `nexus fleet` columns | DELEGATE | terra | 4 |
| 6 Page: fleet panel and the voyage sentence | DELEGATE | terra | 5 |
| 7 Wording sweep: "freighter" as the job becomes "delivery" | KEEP | — | 6 |
| 8 End-to-end scenarios | DELEGATE | sol | 7 |
| 9 Browser walkthrough | KEEP | — | 8 |
| 10 Documentation | KEEP | — | 9 |

KEEP reasons: 3 and 4 edit security-routed files and are cross-cutting; 7 is cross-cutting and touches `dispatch.ts`; 9 needs a browser; 10 edits project instructions. The chain is linear because neighbouring tasks edit the same files (`fleet.ts`, `query.ts`, the page's `types.ts`).

## Review Focus

Inputs the spec implies that are most likely to bite, each pinned by a test in the task named:

1. **More ships than names.** A faction's patterns run out. Expected: the suffix rule (`-II`, …) gives a new unique name; the launch does not fail. (Task 1, and a 70-ship case in Task 4.)
2. **Two processes commission at once** (CLI and server on one database). Expected: the name is generated inside the launch transaction, so both succeed with different names; no UNIQUE failure reaches the user. (Task 4.)
3. **An owner's catalogue entry that names an unknown job or weight, or is not valid JSON.** Expected: the galaxy refuses to open, naming `.nexus/catalogue.json` and the entry; nothing is half-loaded. (Task 1, Task 2.)
4. **A provider whose faction has no name rules and no formations limited to it.** Expected: names from `name_theme`, formations from the any-faction entries. (Task 1.)
5. **A ship that is adrift, quarantined or retired.** Expected: never picked; a new one is commissioned; a retired ship's name is never given out again. (Task 4.)

---

### Task 1: Catalogue module (LANE: DELEGATE, tier sol)

**Files:**
- Create: `src/core/catalogue/types.ts`, `src/core/catalogue/builtin.ts`, `src/core/catalogue/load.ts`, `src/core/catalogue/pick.ts`
- Test: `tests/core/catalogue.test.mjs`

**Interfaces:**
- Consumes: `mulberry32`, `pick`, `type Rng` from `src/core/rng.ts`; `THEMES`, `pickName(rng, pool, used)` from `src/core/names.ts` (unchanged).
- Produces:

```ts
export type ShipJob = "delivery" | "customs" | "transfer" | "survey";
export type Vessel = { hull: string; count: number; role: "lead" | "escort" | "cargo" };
export type Formation = { id: string; name: string; job: ShipJob; weights?: string[]; factions?: string[]; vessels: Vessel[]; art?: string | null };
export type ShipFormation = { id: string; name: string; vessels: Vessel[]; art?: string | null };   // the copy a ship keeps
export type CargoKind = { id: string; label: string; weights?: string[] };
export type NameRules = { pools: Record<string, string[]>; patterns: string[] };
export type Catalogue = { weights: string[]; formations: Formation[]; cargo: CargoKind[]; names: Record<string, NameRules> };

export const BUILTIN: Catalogue;
export const PLAIN_FORMATION: ShipFormation;   // { id: "plain", name: "Ship", vessels: [{ hull: "ship", count: 1, role: "lead" }] }
export function validateCatalogue(value: unknown, source: string): string[];            // error strings, each naming source and entry
export function mergeCatalogue(base: Catalogue, extra: Partial<Catalogue>): Catalogue;
export function loadCatalogue(nexusDir: string): Catalogue;                             // BUILTIN merged with <nexusDir>/catalogue.json if present; throws Error listing every validation error
export function pickFormation(c: Catalogue, q: { job: ShipJob; weight: string; faction: string }, rng: Rng): ShipFormation;
export function pickCargo(c: Catalogue, weight: string, rng: Rng): { id: string; label: string } | null;
export function shipName(c: Catalogue, q: { faction: string; theme: string }, rng: Rng, used: Set<string>): string;
```

**Constraints:**
- Merge rules (spec §7.3): `formations` and `cargo` merge by `id`, an extra entry replacing a base one; an extra `weights` list replaces the base list whole; an extra `names.<faction>` replaces that faction's rules whole.
- An entry's `weights` empty or absent means every weight; `factions` empty or absent means every faction.
- `pickFormation` returns `PLAIN_FORMATION` when nothing matches; it returns a copy holding only `id`, `name`, `vessels`, `art`.
- `shipName`: a faction with rules fills one of its patterns (`{pool}` placeholders) from its pools; a faction without rules uses `THEMES[theme].ships` (unknown theme → `classic`). Uniqueness against `used` follows `pickName`'s existing suffix rule.
- Validation covers: unknown job; a weight not in the catalogue's (merged) weight list; duplicate ids within one file; a pattern naming a pool that does not exist; `count` not a positive integer; a formation with no `lead` vessel.
- Starter content as listed in spec §7.3, plus distinct starter name rules for factions `openai` and `anthropic`.

**Behavioral criteria:**
1. `BUILTIN` validates with no errors and has at least one delivery formation for each of `light`, `standard`, `heavy`, one customs formation for every weight, and cargo for each weight.
2. `pickFormation` only returns entries matching job, weight and faction; a formation limited to `["anthropic"]` is never returned for `openai`.
3. Same rng seed → same formation, cargo and name.
4. No match → `PLAIN_FORMATION`; `pickCargo` with no match → `null`.
5. Merge: same-id replaces, new id adds, `weights` replaces whole, `names.<faction>` replaces whole.
6. `loadCatalogue` with no file returns `BUILTIN`; with an invalid file throws an error naming the file path and each bad entry; with invalid JSON throws naming the path.
7. Review Focus 1: 500 calls of `shipName` against one growing `used` set give 500 distinct names.
8. Review Focus 4: a faction with no rules gets a name from the theme list.
9. The returned formation is a copy: mutating it does not change the catalogue.

**Acceptance:** `npm test -- "tests/core/catalogue.test.mjs"`

Commit: `feat(catalogue): weights, formations, cargo and name rules as data`

---

### Task 2: Config and galaxy (LANE: DELEGATE, tier sol)

**Files:**
- Create: `src/core/weight.ts`
- Modify: `src/config/schema.ts`, `src/server/galaxy.ts`, `templates/config.example.md`
- Test: `tests/config/faction-weights.test.mjs`, `tests/server/galaxy-catalogue.test.mjs`

**Interfaces:**
- Consumes: Task 1's `Catalogue`, `loadCatalogue`; `ProviderConfig`, `PROVIDER_KEYS`, `normalizeConfig`, `DEFAULT_CONFIG` in `schema.ts`; `openGalaxy`, `Galaxy` in `galaxy.ts`.
- Produces:

```ts
// schema.ts — ProviderConfig gains:
faction?: string;                       // normalized: always present, default = the provider id
weights?: Record<string, string>;       // keys: a model id, a tier name, or "default"
// galaxy.ts — Galaxy gains:
catalogue: Catalogue;
// weight.ts
export function factionOf(config: NexusConfig, provider: string): string;
export function weightFor(config: NexusConfig, provider: string, q: { role: Role; model?: string; tier?: string | null }): string;
```

**Constraints:**
- `weightFor` lookup, first hit wins (spec §7.5): `weights[q.model]` when `q.model` is given; `weights[q.tier]` only when `q.role === "implement"` and `q.model` is not given; `weights.default`; `"standard"`.
- Defaults in `DEFAULT_CONFIG`: `codex` `faction: "openai"`, `weights: { sol: "heavy", terra: "standard", luna: "light" }`; `claude` `faction: "anthropic"`, `weights: { default: "heavy", "claude-haiku-5-5": "light" }`; `fake` gets neither (faction normalizes to `"fake"`).
- Schema validation: `faction` a non-empty string; `weights` an object of non-empty strings. Error strings follow the file's existing `'providers.<id>.<key>' must …` style.
- `openGalaxy` loads the catalogue from `paths.nexusDir` and refuses (throws, like an invalid config) when any provider's `weights` names a weight the catalogue does not list, naming provider, key and weight.
- `fleet.freighters|customs|carriers|surveyors` stay accepted by the schema, unchanged.
- `templates/config.example.md` gains a short section on `faction`, `weights` and `.nexus/catalogue.json`.

**Behavioral criteria:**
1. Lookup order as above, one test per rung, including: a tier name is ignored when a model is given; a tier name is ignored for `role: "review"`.
2. `normalizeConfig` fills `faction` with the provider id when absent; `DEFAULT_CONFIG` normalizes with the defaults above.
3. Each malformed `faction` / `weights` value is rejected with its path.
4. A galaxy opened with no catalogue file has `g.catalogue` deep-equal to `BUILTIN`; with an owner file, the merged result.
5. Review Focus 3: a config weight unknown to the catalogue, and an invalid catalogue file, each make `openGalaxy` throw naming the cause; no database handle is left open.

**Acceptance:** `npm test -- "tests/config/faction-weights.test.mjs" "tests/server/galaxy-catalogue.test.mjs"`

Commit: `feat(config): provider faction and weights; the galaxy carries the catalogue`

---

### Task 3: Migration 003, ship job, `ship.commissioned`, voyage cargo (LANE: KEEP)

Stops for the owner's go (security-routed: `src/db/migrations/003.sql`, `src/server/dispatch.ts`).

**Files:**
- Create: `src/db/migrations/003.sql`
- Modify: `src/db/statements.ts`, `src/db/reducers/ships.ts`, `src/db/reducers/voyages.ts`, `src/core/fleet.ts`, `src/server/dispatch.ts`, `src/server/limiter/limiter.ts`, `src/server/commands/delivery.ts`, `src/server/commands/customs.ts`, `src/cli/format.ts`, `web/src/components/Fleet.tsx`
- Test: `tests/db/migration-003.test.mjs`, `tests/db/ship-reducers.test.mjs`, `tests/core/fleet.test.mjs`

**Interfaces — Produces:**

```ts
// fleet.ts
export type ShipRecord = { id: string; name: string; fleet: string; job: ShipJob; faction: string; weight: string; formation: ShipFormation };
export type ShipRow = { id: string; name: string; job: ShipJob; fleet: string; faction: string; weight: string; formation: string /* JSON */; status: string; voyage_count: number; last_event_id: number };
export function jobFor(role: Role): ShipJob;                         // implement → delivery, review → customs, carry → transfer, plan → survey
export function legacyShip(old: { id: string; name: string; class: string; fleet: string }): ShipRecord;   // class → job; faction = fleet; weight "standard"; formation legacy-<job>
export function pickIdleShip(db: NexusDb, job: ShipJob, fleet: string, weight: string): ShipRow | undefined;
```

- Event `ship.commissioned`, payload `{ ship: ShipRecord }`: reducer inserts the ship `idle`.
- `ship.registered` reducer inserts `legacyShip(payload.ship)`.
- `voyage.launched` payload may carry `cargo: { id, label }`; its reducer stores it in `voyages.cargo`.

- [ ] **Step 1:** write `tests/db/migration-003.test.mjs` on the pattern of `migration-002.test.mjs`: a schema-2 database with ships of all four classes in mixed statuses and voyages; after opening, every ship keeps id, name, fleet, status, `voyage_count`, `last_event_id`; `job` is mapped; `faction` = `fleet`; `weight` = `standard`; `formation` = `legacy-<job>`; `voyages.cargo` is null; row order kept; a failure injected mid-migration leaves schema 2. Then `rebuild` → `dumpProjections` byte-equal to the migrated database (this pins the reducer to the SQL).
- [ ] **Step 2:** run it; expect failure (no 003).
- [ ] **Step 3:** write `003.sql` with 002's set-aside-and-refill method: rebuild `ships` (`job` CHECK in `delivery|customs|transfer|survey`, `faction`, `weight`, `formation` NOT NULL with `json_valid`), with `voyages` set aside and refilled around it because of its foreign key; add `voyages.cargo TEXT CHECK (cargo IS NULL OR json_valid(cargo))`.
- [ ] **Step 4:** statements (`ships.insert` with the new columns, `ships.pickIdle` by job, fleet, weight; `ships.all` ordered `fleet, job, weight, name`; voyage insert with cargo), reducers, `fleet.ts`. `generateFleet` stays for now and returns legacy-shaped ships.
- [ ] **Step 5:** callers compile against the new names with no behaviour change: `shipClassFor` → `jobFor`, every `pickIdleShip` call passes weight `"standard"`, `ship.class` → `ship.job` in `limiter.ts`, `format.ts`, `Fleet.tsx`.
- [ ] **Step 6:** `ship-reducers` tests: `ship.commissioned` inserts every field; `ship.registered` gives `legacyShip`; cargo round-trips; `rebuild` byte-equal.
- [ ] **Step 7:** full suite green. Commit: `feat(db): migration 003 — ship job, faction, weight, formation; voyage cargo`

---

### Task 4: Commission on demand (LANE: KEEP)

Stops for the owner's go (security-routed: `src/server/dispatch.ts`).

**Files:**
- Modify: `src/db/events.ts`, `src/server/dispatch.ts`, `src/server/limiter/limiter.ts`, `src/server/commands/delivery.ts`, `src/server/commands/customs.ts`, `src/server/commands/init.ts`, `src/server/scheduler/plan.ts`, `src/core/fleet.ts`, `tests/helpers.mjs`
- Test: `tests/server/commission.test.mjs`, plus existing tests that assert the old refusal or a pre-built fleet

**Interfaces — Produces:**

```ts
// events.ts — several events in one transaction; build() runs inside it and may read the database
export function appendAll(db: NexusDb, build: () => NexusEvent[]): EventRow[];
// limiter.ts — Choice "fly" loses shipId; Capacity loses claimed
```

- [ ] **Step 1:** tests first, in `tests/server/commission.test.mjs` (spec §9 items 3–8, 10–13 at command level): no idle ship → `ship.commissioned` then `voyage.launched`, same transaction; the ship has the provider's faction and the resolved weight; after dock the next delivery of that weight reuses it; a heavy ship is not taken for a light job; two held at once → two ships; same seed and history → same formation, name and cargo; a launch refused by `max_concurrent_ships` leaves no `ship.commissioned`; a refuel flies the refuel provider's faction and the refuel model's weight; an empty catalogue still flies with the plain formation; a catalogue edit after commissioning leaves the ship unchanged; Review Focus 2 (two `openGalaxy` handles on one file commission different names — pin roles to fake and note the guard does not cover the second handle) and 5 (adrift, quarantined, retired ships are skipped; a retired name is not reused); 70 ships commissioned in one galaxy all have distinct names.
- [ ] **Step 2:** `appendAll` in `events.ts`, with a test that a throwing `build` or reducer rolls every event back.
- [ ] **Step 3:** `runVoyage`: inside the launch transaction resolve `weightFor(g.config, provider, { role, model: input.model ?? configured models[tier], tier: moon.tier })`, take `pickIdleShip(db, jobFor(role), provider, weight)` or build a `ShipRecord` (`pickFormation`, `shipName` with `used` = every name in `ships`, seed from `fleet.seed` and the ship count), draw cargo for `implement` (seed from `fleet.seed` and the voyage count), and append `ship.commissioned` (when new) and `voyage.launched` together. The voyage id is built inside the transaction. The existing cap checks stay where they are.
- [ ] **Step 4:** remove the idle-ship prechecks: `delivery.ts`, `customs.ts`, the limiter's `available` (a provider is available when it is configured and under `per_provider_max`), `Choice.shipId`, `Capacity.claimed`, and the "all … are assigned" message. Add the total `max_concurrent_ships` check to `sendDelivery`'s precheck 3, beside `refuseIfAtCap`, so a full fleet refuses before any commit or gate.
- [ ] **Step 5:** `initGalaxy` registers no ships; delete `generateFleet`; `init` reports `ships: 0`.
- [ ] **Step 6:** fix the tests that relied on a pre-built fleet or the old refusal; each changed assertion is listed in the commit body.
- [ ] **Step 7:** full suite green. Commit: `feat(ships): commission on demand; fleet size is no longer a limit`

---

### Task 5: Reads and CLI (LANE: DELEGATE, tier terra)

**Files:**
- Modify: `src/server/commands/query.ts`, `src/cli/format.ts`
- Test: `tests/http/reads-ships.test.mjs`, `tests/cli/fleet-table.test.mjs`

**Interfaces:**
- Consumes: `ShipRow` (Task 3); `snapshot`, `MoonDetail`, `fleet(g)` in `query.ts`; `fleetTable` in `format.ts`.
- Produces: every ship row in `Snapshot.fleet` and `fleet(g)` carries `job`, `faction`, `weight` and `formation` as a parsed object (`ShipFormation`), not a JSON string; every voyage row in `Snapshot.voyages` and `MoonDetail` carries `cargo: { id, label } | null` and `ship: { name, faction, weight, formation_name } | null`.

**Constraints:** read-only; no new SQL outside `statements.ts`; a ship row with unparseable `formation` JSON is shown with the plain formation, never a thrown error. `nexus fleet` columns: `name, fleet, faction, job, weight, formation, status, voyages`.

**Behavioral criteria:**
1. After one delivery, the snapshot's ship has the four fields and the voyage has `cargo` and `ship`.
2. A customs voyage has `cargo: null`.
3. A legacy ship (from `ship.registered`) reads as standard weight with its legacy formation name.
4. `fleetTable` prints the eight columns; `--json` output has the same fields.
5. `rebuild` leaves the snapshot identical.

**Acceptance:** `npm test -- "tests/http/reads-ships.test.mjs" "tests/cli/fleet-table.test.mjs"`

Commit: `feat(reads): ship identity and voyage cargo in the snapshot and the fleet table`

---

### Task 6: Page (LANE: DELEGATE, tier terra)

**Files:**
- Create: `web/src/ships.ts`
- Modify: `web/src/types.ts`, `web/src/components/Fleet.tsx`, `web/src/components/SystemView.tsx`, `web/src/components/MoonDetail.tsx`, `web/src/style.css`
- Test: `tests/http/page-ships.test.mjs` (pure module compiled with the tsc CLI, as `tests/http/page-fuel-actions.test.mjs` does)

**Interfaces — Produces** (`web/src/ships.ts`, pure, `import type` only):

```ts
export function formationText(f: { name: string; vessels: { hull: string; count: number; role: string }[] }): string;   // "Carrier group (1 carrier, 4 frigates)"
export function voyageSentence(v: { ship: { name: string; faction: string; formation_name: string } | null; cargo: { label: string } | null }): string | null;
   // "Kestrel — carrier group (anthropic), carrying a diplomat"; no cargo → no ", carrying …"; no ship → null
export function sortShips<T extends { weight: string; name: string }>(ships: T[], weights: string[]): T[];             // by catalogue weight order, then name
```

**Constraints:** text only; no images; the existing Retire control and fuel gauge keep working; plural hulls by adding `s` only when `count > 1`. The fleet panel stays grouped by provider and shows per ship: name, faction, formation name, weight, status, trip count. Wording rules from Global Constraints apply to all copy.

**Behavioral criteria:** one test per function with the exact strings above; the three components import from `../ships`; the built bundle contains `carrying ` and the panel's column copy; no source or bundle text matches `/freighters? in fleet|all freighters/i`.

**Acceptance:** `npm test -- "tests/http/page-ships.test.mjs"`

Commit: `feat(page): ship identity in the fleet panel and on each voyage`

---

### Task 7: Wording sweep (LANE: KEEP)

**Files:** every file under `src/`, `web/src/`, `prompts/` and `tests/` where "freighter" means the job; includes `src/server/dispatch.ts` (comments and `shipsNoun`).

- [ ] **Step 1:** list occurrences with `git grep -n -i freighter -- src web/src prompts tests`; leave catalogue hull and formation names, and historical event payloads in fixtures.
- [ ] **Step 2:** replace the job sense with "delivery" / "delivery ship": refusal and decision text, the rung selector copy in `Header.tsx`, comments, local variable names such as `freighter` for an implement voyage (→ `delivery`), `shipsNoun`, test names. Update the assertions that quote changed text.
- [ ] **Step 3:** add `tests/wording.test.mjs`: outside `src/core/catalogue/`, migrations 001–002 and a short allow-list, no file under `src/` or `web/src/` contains the word `freighter`.
- [ ] **Step 4:** full suite green. Commit: `refactor: "freighter" is a hull, the job is a delivery`

---

### Task 8: End-to-end scenarios (LANE: DELEGATE, tier sol)

**Files:**
- Create: `tests/e2e/ships.test.mjs`
- Modify: `tests/fixtures/world.mjs` (a `shipsPatch` helper beside `fuelPatch`)

**Interfaces — Consumes:** the `nexus serve` harness and `fuelPatch` pattern in `tests/e2e/fuel.test.mjs` and `tests/fixtures/world.mjs`; fake-adapter scripts in `tests/fixtures/scripts/`.

**Constraints:** assertions read the event log from the database, never the SSE buffer; real time only where the server needs it; roles pinned to fake providers; no test waits longer than 15 s for one condition.

**Behavioral criteria (each a scenario through the running server at `roundabout`):**
1. Three independent moons with weights light, standard, heavy on one provider → three ships with those weights and that provider's faction; each voyage has cargo of its weight.
2. Spec §9 item 12: with customs unavailable (review pool dry), seven independent moons on one provider are all sent to, each on its own ship; a moon depending on an unmerged one is not.
3. After a moon docks, the next delivery of the same weight flies the same ship (`voyage_count` 2).
4. A held delivery refuelled on another provider flies a ship of that provider's faction and the refuel model's weight.
5. With an owner `.nexus/catalogue.json` adding one heavy formation limited to one faction and removing the others' weights, that provider's heavy ship has it and the other provider's never does.
6. After every scenario, `rebuild` leaves `dumpProjections` byte-equal.

**Acceptance:** `npm test -- "tests/e2e/ships.test.mjs"`

Commit: `test(e2e): ships commissioned by weight and faction, reused, never capped by fleet size`

---

### Task 9: Browser walkthrough (LANE: KEEP)

- [ ] Run `nexus serve` on a scratch galaxy with fake providers; send a light and a heavy delivery; check the fleet panel, the voyage sentence, a refuelled delivery, a legacy galaxy opened after migration, and a narrow window. Record what was seen in the ledger; fix page defects in place with a test.

### Task 10: Documentation (LANE: KEEP)

- [ ] `CLAUDE.md` fork note (vocabulary, on-demand ships, no fleet cap, catalogue file, `faction` / `weights`), gotchas (ignored `fleet.*` counts; catalogue read at open), the parent design's ship row and schema line marked as superseded, and `README.md` where it describes the fleet. Commit: `docs: ship catalogue`
