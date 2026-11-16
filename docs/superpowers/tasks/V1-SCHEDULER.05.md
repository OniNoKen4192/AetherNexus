# TASK: scheduler-decision-function

## Meta
- **Task ID**: V1-SCHEDULER.05
- **Parent plan**: docs/superpowers/plans/2026-11-15-v1-scheduler.md
- **Depends on**: V1-SCHEDULER.04
- **Estimated scope**: M
- **Model hint**: sol

## Objective
A pure function `plan(g, ctx)` reads the current state and the trust rung and returns the list of steps the server should take next — which freighters to send, which to have inspected, which to dock, which dead voyages to park — in the order they should be taken, never more than the configured limits allow, and writes nothing.

## Context
Aether Nexus runs work on *moons* (tasks): a freighter is sent to a moon to implement it, customs inspects the result, the freighter docks (merges), and the moon is then settled. Until now a human triggers each step. A loop in the server (the next task, not this one) will call `plan` whenever the event log moves and execute what it returns through the existing command functions. Keeping the decision in a pure function is the point of this task: every rule is testable without timers or a server. The rung decides how far the server goes by itself: at `manual` nothing; at `verdicts` everything *after* a human has sent the first freighter; at `roundabout` also the first freighter to every ready moon. `availableActions` already knows which step is legal for a moon in each state — build on it, do not re-derive legality. A step that cannot run right now (no free ship, a limit reached) is simply not returned; the loop will ask again. Planets with dependencies get no automatic first freighter because nothing can satisfy a planet dependency yet. Wording rule for comments and test names: places don't move, ships do — a freighter is *sent to* a moon, customs *inspects*, the freighter *docks*, the moon is *settled*; never "the moon launches". Existing identifiers (action `"launch"`, `launchMoon`) are not renamed. Affected workflow IDs is `none` because this project has no review suite.

## Files

### Touch
| Path | Action | Notes |
|------|--------|-------|
| `tests/server/scheduler-plan.test.mjs` | create | the acceptance tests, written first |
| `src/server/scheduler/plan.ts` | create | `effectiveRung`, `plan` (the directory holds only a `.gitkeep` so far; leave that file alone) |

### Do NOT touch
- `src/server/commands/**` — owned by tasks V1-SCHEDULER.01–.04 (merged); import from them, change nothing. In particular `availableActions` and `dependencyState` are used as they are.
- `src/server/scheduler/loop.ts`, `src/server/http/**` — owned by the next task (KEEP lane)
- `src/db/statements.ts` — no new statements are needed
- `src/core/fleet.ts` — use `pickIdleShip` / `ShipRow` as they are
- `tests/fixtures/**`, `tests/helpers.mjs` — use them, do not edit them (task V1-SCHEDULER.07 owns `tests/fixtures/world.mjs`)
- `web/**` — owned by tasks V1-SCHEDULER.08 and .09
- Any file not listed under Touch. If completing the objective seems to require touching an unlisted file, STOP and report BLOCKED.

**Standing exclusions:**
- Security-routed files, never modified by this lane: `src/core/git.ts`, `src/validate/**`, `src/providers/claude-sdk/gate-hook.ts`, `src/server/dispatch.ts`, `src/db/migrations/**`, `src/server/http/auth.ts`, `src/server/lock.ts`
- Pipeline-owned paths: `docs/superpowers/plans/**`, `docs/superpowers/tasks/**`, `.superpowers/sdd/**`
- `package.json`, `package-lock.json` — no dependency changes

## Interfaces

Produced:

```ts
// src/server/scheduler/plan.ts
export type Rung = "manual" | "verdicts" | "roundabout";
/** highways and autopilot behave as roundabout until their slices land. Anything unrecognised is manual. */
export function effectiveRung(level: string): Rung;
export type PlannedAction = {
  action: "dock" | "park_stale" | "inspect" | "launch";
  taskId: string;
  /** true when this would be the first freighter sent to the moon under its current assignment */
  first: boolean;
};
export type PlanCtx = {
  ownPid: number;
  tracks?: (voyageId: string) => boolean;
  /** task ids that already have a scheduler action running; never planned */
  busy?: ReadonlySet<string>;
  /** plan as if at this rung; default effectiveRung(g.config.automation.level) */
  rung?: Rung;
};
export function plan(g: Galaxy, ctx: PlanCtx): PlannedAction[];
// `first` is true only for a "launch" on a moon whose dependencyState(...).visited is false; false for every other action.
```

Consumed (exact current signatures; do not change them):

```ts
// src/server/commands/query.ts
export type Action = "launch" | "inspect" | "dock" | "reply" | "drop" | "park_stale" | "cancel" | "answer";
export function availableActions(g: Galaxy, taskId: string, ctx: { ownPid: number; tracks?: (voyageId: string) => boolean }): Action[];
// returns, by state:  pending main-tree question → ["answer", ...maybe "drop"]
//   emitted|gated → ["launch"]
//   implementing|reviewing with a voyage in flight → ["cancel"] (this server's), ["park_stale"] (owner process gone), [] (another live process)
//   audited → ["inspect"] when the latest freighter is holding; ["launch"] when the last verdict is FIX; else []
//   reviewing with an APPROVE verdict and a cleared/en_route/docked freighter → ["dock"]
//   adrift|quarantined → ["reply", "drop", ...("launch" only after a human reply newer than the park)]
// src/server/commands/deps.ts
export type DependencyState = { visited: boolean; waitingOn: string[]; waitingOnPlanets: string[] };
export function dependencyState(g: Galaxy, taskId: string): DependencyState;
// src/server/dispatch.ts  (import only)
export function loadMoon(g: Galaxy, taskId: string): MoonRow;     // .status, .assignment_id, .task_id
export const shipClassFor = (role: Role): ShipClass => (role === "implement" ? "freighter" : "customs");
// src/core/fleet.ts
export type ShipClass = "freighter" | "customs" | "carrier" | "surveyor";
export type ShipRow = { id: string; name: string; class: ShipClass; fleet: string; status: string; voyage_count: number; last_event_id: number };   // fleet = provider id; status 'idle' is free
// named statements (src/db/statements.ts), all SELECT *:
//   "systems.all"   "planets.bySystem" { system_id }   "moons.byPlanet" { planet_id }  (rows with task_id NULL are unassigned: skip them)
//   "voyages.inFlight"  → voyages with status launched|working; each row has .provider
//   "ships.all"         → ShipRow[]
// g.config.roles: { implement: string[]; review: string[] }            provider order per role
// g.config.scheduler: { max_concurrent_ships: number; per_provider_max: Record<string, number>; ... }   a provider absent from per_provider_max has no own limit
// g.config.automation.level;   g.adapters: Record<string, ProviderAdapter>   (a provider not in g.adapters is not configured)
```

Test references: `tests/server/launch.test.mjs`, `tests/server/review.test.mjs` and `tests/server/park.test.mjs` show how to reach each moon state with the fake adapter and the real command functions (`launchMoon`, `inspectMoon`, `dockMoon`, `replyMoon`, `parkMoonOnly`), including a FIX verdict and a stale voyage. `worldWithMoon(script, patchConfig, patchSpec)` and `worldWithTwoMoons` are in `tests/fixtures/world.mjs`; `makeGalaxy(patchConfig)` lets a test set `scheduler.max_concurrent_ships`, `scheduler.per_provider_max` and `fleet` counts. Set the rung in tests by passing `ctx.rung`.

## Constraints

`plan` writes nothing: no event, no file, no config change. For every assigned moon whose task id is not in `ctx.busy`, take `availableActions(g, taskId, { ownPid: ctx.ownPid, tracks: ctx.tracks })` and keep at most one action, by this table:

| `availableActions` contains | moon status | further condition | planned at |
|---|---|---|---|
| `dock` | `reviewing` | — | `verdicts`, `roundabout` |
| `park_stale` | `implementing` / `reviewing` | — | `verdicts`, `roundabout` |
| `inspect` | `audited` | — | `verdicts`, `roundabout` |
| `launch` | `audited` | — (a FIX verdict is on record) | `verdicts`, `roundabout` |
| `launch` | `adrift` / `quarantined` | `visited` | `verdicts`, `roundabout` |
| `launch` | `adrift` / `quarantined` | not `visited`; `waitingOn` and `waitingOnPlanets` both empty | `roundabout` |
| `launch` | `emitted` / `gated` | `waitingOn` and `waitingOnPlanets` both empty | `roundabout` |

- At `manual` the result is always `[]`.
- `cancel`, `reply`, `drop` and `answer` are never planned. A moon whose `availableActions` starts with `answer` gets nothing.
- **Capacity.** A `launch` or `inspect` is returned only if it can run now. Start with `free = max_concurrent_ships − (number of voyages in flight)`. For each such action, walk the role's provider order (`roles.implement` for `launch`, `roles.review` for `inspect`) and take the first provider that (1) is in `g.adapters`, (2) is under its `per_provider_max`, counting voyages in flight plus voyages already planned for it in this pass, and (3) still has an idle ship of the class (`freighter` for `launch`, `customs` for `inspect`) not already claimed in this pass. If there is none, or `free` is 0, skip the moon. Otherwise decrement the counters and include the action. `dock` and `park_stale` consume nothing and are never skipped for capacity.
- **Order of the result:** all `dock`, then all `park_stale`, then all `inspect`, then `launch` with `first: false`, then `launch` with `first: true`; within a group, ascending `assignment_id`. Capacity is handed out in this same order.
- A dependency cycle needs no special handling: both moons have a non-empty `waitingOn`, so neither is planned, and the function returns.
- No new SQL and no new dependencies. Node ≥ 22.13, ES modules, TypeScript strict.
- Tests use `node:test` and `node:assert/strict`, import compiled code from `dist/`, and clean up in `finally`.

## Acceptance

**Test command (must exit 0):**
```bash
npm test -- "tests/server/scheduler-plan.test.mjs"
```

**Behavioral criteria** (each must be covered by a test in `tests/server/scheduler-plan.test.mjs`):
1. `effectiveRung`: `manual → manual`, `verdicts → verdicts`, and `roundabout`, `highways`, `autopilot` → `roundabout`.
2. `manual` plans nothing, for an emitted moon, for an audited moon with a holding freighter, and for a moon with an APPROVE verdict.
3. An emitted moon: `[]` at `verdicts`; `[{ action: "launch", taskId: "T1", first: true }]` at `roundabout`.
4. A holding freighter is inspected at `verdicts` and at `roundabout` (`[{ action: "inspect", taskId: "T1", first: false }]`).
5. An approved freighter is docked at `verdicts` and at `roundabout`.
6. After a FIX verdict the next freighter is planned at `verdicts` and at `roundabout`, with `first: false`.
7. A parked moon that was visited and has been replied to gets a freighter at `verdicts` and at `roundabout`, with `first: false`.
8. A parked moon that was never visited (parked with `parkMoonOnly` while `emitted`) and has been replied to gets a freighter only at `roundabout`, with `first: true`; `[]` at `verdicts`.
9. A stale voyage (`ctx.ownPid` equal to the launching pid, `tracks: () => false`) is planned as `park_stale` at `verdicts` and at `roundabout`.
10. An adrift moon with no reply gets nothing; a quarantined moon with no reply gets nothing.
11. A pending main-tree question blocks every action for that moon (see `tests/server/tree.test.mjs` for how one arises).
12. B depends on A, both emitted: only A's `launch` is planned at `roundabout`.
13. A depends on B and B depends on A: `plan` returns `[]`.
14. A planet assigned with `dependsOn: ["P0"]`: its emitted moon gets `[]` at `roundabout`; after a manual `launchMoon` for it, `inspect` is planned.
15. Three ready moons with `max_concurrent_ships: 2` and none in flight → exactly two `launch`.
16. `per_provider_max` is respected: with `{ fake: 1 }` and three ready moons → exactly one `launch`.
17. A fleet with 2 freighters and 3 ready moons (limits high enough) → exactly two `launch`.
18. A `dock` is planned even when `max_concurrent_ships` is already reached by voyages in flight.
19. Order: with one moon ready to dock, one holding freighter, one FIX round pending and one emitted moon, the result's actions are in the order `dock`, `inspect`, `launch` (`first: false`), `launch` (`first: true`); two emitted moons come out in ascending `assignment_id`.
20. A task id in `ctx.busy` is never in the result.
21. `plan` writes nothing: the `events.maxId` value is the same before and after a call.

**Affected workflow IDs**: none

**Regression guard (task level — implementer runs this):**
```bash
npm test
```

## Out of Scope
- No loop, no timers, no execution of the returned actions, no events (the next task).
- Do not change `availableActions`, `dependencyState` or any command function.
- Do not add fuel, priority (gravity) or provider preference beyond the role order.
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
