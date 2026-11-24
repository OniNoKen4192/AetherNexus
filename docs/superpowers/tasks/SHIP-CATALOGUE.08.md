# TASK: e2e-ships

## Meta
- **Task ID**: SHIP-CATALOGUE.08
- **Parent plan**: docs/superpowers/plans/2026-11-19-ship-catalogue.md
- **Depends on**: SHIP-CATALOGUE.01, .02, .05, .06 (merged) and plan Tasks 3, 4, 7 (KEEP, landed)
- **Estimated scope**: M
- **Model hint**: sol

## Objective
A new end-to-end test file proves, through a running `nexus serve` at the `roundabout` rung with nobody clicking, that ships are commissioned by weight and faction, reused after a dock, never capped by fleet size, and shaped by the owner's catalogue file.

## Context
Aether Nexus shows automated development work as space traffic: a provider's model does a job at a *moon* (a task) and is shown as a ship flying there. Ships are now commissioned on demand inside the launch: when a voyage starts and no idle ship of the same *fleet* (provider), *job* (`delivery` or `customs`) and *weight* exists, a `ship.commissioned` event creates one, immediately followed by `voyage.launched`. The weight comes from config (`providers.<id>.weights`, keyed by a model id, a tier name or `default`; a moon's tier is its spec's `Model hint` line); the *faction* is `providers.<id>.faction`; the *formation* is picked from the catalogue (`src/core/catalogue/builtin.ts`, extended by an optional `.nexus/catalogue.json` read when the galaxy is opened); a delivery's *cargo* is drawn per trip and stored on the voyage. There is no cap on how many deliveries are open: a delivery ship stays assigned after it returns until customs has inspected and the cargo has docked, and more ships are commissioned for other moons meanwhile. The only limits are `scheduler.max_concurrent_ships` (voyages in flight at once), `scheduler.per_provider_max`, dependencies between moons, and fuel. All of that is implemented and unit-tested (`tests/server/commission.test.mjs`); this task adds the scenarios that run the whole server. It adds tests only: no source file changes. Design: `docs/superpowers/specs/2026-11-19-ship-catalogue-design.md` §7.2, §7.5, §7.9 and §9. Wording rule for test names, comments and identifiers: the job is a *delivery*; `freighter` and `carrier` are hull or formation names in catalogue data and nothing else; a moon does not move, a ship does. Affected workflow IDs is `none` because this project has no review suite.

## Files

### Touch
| Path | Action | Notes |
|------|--------|-------|
| `tests/e2e/ships.test.mjs` | create | the scenarios below |
| `tests/fixtures/world.mjs` | modify | add `shipsPatch` beside `fuelPatch`; let `writeSpecs` entries carry an optional `tier` |

### Do NOT touch
- Everything under `src/`, `web/`, `prompts/`, `templates/` — this task changes no source. If a scenario fails because of what looks like a source defect, STOP and report BLOCKED with the evidence; do not work around it in the test.
- `tests/e2e/fuel.test.mjs`, `tests/e2e/scheduler*.test.mjs`, `tests/http/helpers.mjs`, `tests/helpers.mjs`, `tests/server/commission.test.mjs` and every other existing test — they must keep passing unchanged. In `tests/fixtures/world.mjs`, existing exports keep their behaviour for existing callers (`writeSpecs` without `tier` writes exactly what it writes now).
- `tests/fixtures/scripts/**` — use the existing fake scripts
- Any file not listed under Touch. If completing the objective seems to require touching an unlisted file, STOP and report BLOCKED.

**Standing exclusions:**
- Security-routed files, never modified by this lane: `src/core/git.ts`, `src/validate/**`, `src/providers/claude-sdk/gate-hook.ts`, `src/server/dispatch.ts`, `src/db/migrations/**`, `src/server/http/auth.ts`, `src/server/lock.ts`
- Pipeline-owned paths: `docs/superpowers/plans/**`, `docs/superpowers/tasks/**`, `.superpowers/sdd/**`
- `package.json`, `package-lock.json` — no dependency changes

## Interfaces

Produced (in `tests/fixtures/world.mjs`):

```js
/**
 * Config for ship scenarios: two fake providers with their own faction and weights. Runs `extra` last.
 *   fake:  adapter "fake", faction "tinkers",   weights { sol: "heavy", terra: "standard", luna: "light" }, pool { kind: "window", reserve_floor: 0.1, refuel? }
 *   spare: adapter "fake", faction "outriders", weights { "m-cheap": "light", default: "heavy" },           pool { kind: "window", reserve_floor: 0.25 }
 *   opts.refuel = { min_wait_minutes } adds fake.pool.refuel = { provider: "spare", models: { terra: "m-cheap" }, min_wait_minutes }
 *   roles { implement: ["fake"], review: ["fake"] }; routing.security_routed ["src/auth.ts"]; routing.do_not_touch [".env"]
 */
export function shipsPatch(opts = {}, extra) { /* returns (config) => void, like fuelPatch */ }

// writeSpecs(w, entries): an entry may carry `tier` ("sol" | "terra" | "luna"); when present the spec's "- **Model hint**: terra" line is written with that tier.
```

Consumed (exact current code; read these files before writing):

```js
// tests/http/helpers.mjs
export async function startWorld(script, patchConfig, opts = {})   // one system, one planet, one assigned moon T1 running fake script `script`; returns { w, srv, api, close }
export function readFeed(srv, { since, lastEventId } = {})
// tests/fixtures/world.mjs
export function fuelPatch(opts = {}, extra)
export function writeSpecs(w, entries)        // entries: [{ id, deps = [], scripts = [] }] → repo-relative spec paths, committed
// tests/e2e/fuel.test.mjs — NOT exported: copy the small helpers you need into the new file (until, post, snapshot, moons, findMoon,
// events, reading, exhausted, movePast, assign, setRoundabout, finish, scenario, and FAST = { server: { pollMs: 20, schedulerTickMs: 100 } }).
// `scenario(script, patch, body)` starts the world, runs `body(x, feed)`, then closes the server and asserts
// `rebuild` leaves `dumpProjections` byte-equal — keep that in every scenario.
// The database of the running server: x.w.g.db  (`x.w.g.db.all("ships.all")`, `x.w.g.db.all("events.since", { id: 0 }).map(rowToEvent)`,
// `x.w.g.db.get("voyages.byId", { id })`); the repo directory: x.w.dir.
// Commands over HTTP: post(x, "moon.assign", { planetId: x.w.planetId, specPath }), post(x, "config.automation", { level: "roundabout" }).
// Fake scripts (tests/fixtures/scripts/*.json): "happy" (returns at once), "slow" (takes a few seconds), "wall", "wall-then-spare", …
```

Events and rows the scenarios read:

```text
ship.commissioned   payload { ship: { id, name, fleet, job, faction, weight, formation: { id, name, vessels: [{ hull, count, role }] } } }
voyage.launched     payload { role: "implement" | "review", round, provider, model?, refuel_for?, ship_id, cargo?: { id, label }, … }
ships row           { id, name, job, fleet, faction, weight, formation /* JSON text */, status: "idle" | "assigned" | …, voyage_count }
voyages row         { id, ship_id, task_id, role, provider, model, status, cargo /* JSON text or null */ }
moon statuses       emitted → gated → implementing → audited → reviewing → merged
```

## Constraints
- Every assertion about what happened reads the event log or the projections from the database (`x.w.g.db`) or the HTTP snapshot — never the SSE buffer.
- Real time only where the server needs it (the scheduler tick); no scenario waits longer than 15 s for one condition; use the `until` polling helper, never a fixed sleep as a wait for a state.
- Roles stay pinned to the fake providers `fake` and `spare` in every config; no test sets `NEXUS_LIVE`; no test calls a real provider.
- The owner's catalogue file for scenario 5 is written to `<x.w.dir>/.nexus/catalogue.json` **before the galaxy that the server uses is opened**. `startWorld` opens the galaxy itself, so if it offers no hook for that, start the scenario's own galaxy and server the way `startWorld` does (read `tests/http/helpers.mjs`) after writing the file — without changing `tests/http/helpers.mjs`.
- To make customs unavailable in scenario 2, give customs its own provider with a dry pool: an extra fake provider `inspector` (`adapter: "fake"`, `pool: { kind: "window", reserve_floor: 0.1 }`), `roles.review: ["inspector"]`, and a `fuel.exhausted` event for `inspector` with `until` an hour ahead, appended before the rung is raised. A dry pool holds customs; it never parks a moon.
- Each scenario ends with the server closed and `rebuild` leaving `dumpProjections` byte-equal (criterion 6).
- Tests use `node:test` and `node:assert/strict` and import from `dist/` (the test command builds first). No new dependencies.

## Acceptance

**Test command (must exit 0):**
```bash
npm test -- "tests/e2e/ships.test.mjs"
```
The first Touch entry creates this test.

**Behavioral criteria** (each one scenario in `tests/e2e/ships.test.mjs`, run through the server at `roundabout`):
1. **Weight and faction.** Three independent moons with tiers `luna`, `terra`, `sol` on provider `fake`: three delivery ships are commissioned, with weights `light`, `standard`, `heavy`, each with faction `tinkers` and fleet `fake`; each ship's formation id is one the built-in catalogue offers for a delivery of that weight; each delivery voyage's cargo id is one the built-in catalogue offers for that weight; every `ship.commissioned` event is immediately followed (next event id) by the `voyage.launched` that names that ship. All three moons reach `merged` with nobody clicking.
2. **No cap on open deliveries.** With customs unavailable (see Constraints) and `scheduler.max_concurrent_ships` 3, seven independent moons on `fake` plus an eighth that depends on the first: all seven get a delivery, each on its own ship (seven delivery ships, seven distinct names, all `assigned` while their cargo waits for customs), no more than three voyages are ever in flight at once (check the launch and return order in the log), the eighth moon gets no delivery while the first is unmerged, no moon is parked (`moon.adrift` count 0), and no customs ship is commissioned.
3. **Reuse after a dock.** Two moons on `fake`, the second depending on the first, same tier: after the first merges, the second's delivery flies the same ship; at the end that ship has `voyage_count` 2 and only one delivery ship exists.
4. **Refuel.** With `shipsPatch({ refuel: { min_wait_minutes: 0 } })` and `fake`'s pool low (a `fuel.reading` of `used: 0.95` with a reset an hour ahead, appended before the rung is raised), the held delivery is refuelled on `spare`: its voyage has `provider: "spare"`, `model: "m-cheap"`, and its ship has fleet `spare`, faction `outriders`, weight `light`; the `voyage.launched` payload has `refuel_for: "fake"`.
5. **The owner's catalogue.** With a `.nexus/catalogue.json` that adds one heavy delivery formation limited to faction `tinkers` (`"factions": ["tinkers"]`, a new id) and replaces every built-in heavy delivery formation by id so that it no longer lists `heavy` in its `weights` (so the new entry is the only heavy delivery formation): a `sol` moon on `fake` flies a ship whose formation id is the new one; a `sol` delivery flown by `spare` (make `spare` the implement provider for that moon by config, with `spare` weights `{ sol: "heavy" }` in that scenario) gets the plain formation (`id: "plain"`), never the `tinkers` one.
6. After every scenario the server is closed and `rebuild` leaves `dumpProjections` byte-equal.

**Affected workflow IDs**: none

**Regression guard (task level — implementer runs this):**
```bash
npm test
```

## Out of Scope
- No source changes of any kind, including "small fixes" found on the way: report them.
- No page or browser checks; a later KEEP task walks the page.
- Do not move the helpers out of `tests/e2e/fuel.test.mjs` into a shared module.
- Do not add fake scripts.
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
