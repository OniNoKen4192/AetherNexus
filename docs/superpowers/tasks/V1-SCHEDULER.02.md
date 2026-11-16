# TASK: moon-dependencies

## Meta
- **Task ID**: V1-SCHEDULER.02
- **Parent plan**: docs/superpowers/plans/2026-11-15-v1-scheduler.md
- **Depends on**: V1-SCHEDULER.01
- **Estimated scope**: M
- **Model hint**: sol

## Objective
A first freighter cannot be sent to a moon whose dependencies are not settled, and the snapshot and the moon detail read say what each moon is waiting on.

## Context
A spec's `- **Depends on**:` line is stored on the moon (`moons.depends_on`, JSON text) and a planet's `dependsOn` is stored on the planet (`planets.depends_on`, JSON text of stream ids), but nothing reads either today. A scheduler is coming that sends freighters by itself, so the order must be enforced where every caller passes: in `launchMoon`. The rule is deliberately narrow. Only the *first* freighter to a moon under its current assignment is held; once a freighter has been sent (a FIX round, a reply after a voyage) the moon is never re-checked, so work in progress cannot be stranded by a later change to a neighbour. Planet-level dependencies are only *reported* in this task: no merge of one planet into another exists yet, so they cannot become satisfied; a later task makes the scheduler hold on them, while a human may still send a freighter by hand. Wording rule for comments, messages and test names: places don't move, ships do — a freighter is *sent to* a moon, the moon is then *settled* (status `merged`); never "the moon launches". Existing identifiers (`launchMoon`, action `"launch"`) are not renamed. Affected workflow IDs is `none` because this project has no review suite.

## Files

### Touch
| Path | Action | Notes |
|------|--------|-------|
| `tests/server/deps.test.mjs` | create | the acceptance tests, written first |
| `src/server/commands/deps.ts` | create | `dependencyState` |
| `src/server/commands/launch.ts` | modify | one precheck in `launchMoon`, after the state precheck; nothing else |
| `src/server/commands/query.ts` | modify | `waiting_on`, `waiting_on_planets` on snapshot moon rows and `MoonDetail.moon` |

### Do NOT touch
- `src/core/transitions.ts`, `src/db/reducers/index.ts`, `src/server/commands/park.ts` — owned by task V1-SCHEDULER.01 (merged)
- `src/server/commands/config.ts` — owned by task V1-SCHEDULER.03
- `src/server/http/**`, `src/cli/**`, `src/server/scheduler/**`, `web/**` — owned by later tasks
- `src/db/statements.ts` — no new statements are needed
- `src/server/commands/system.ts` (`showSystem`) — add the fields in `snapshot`, not there
- In `query.ts`: `availableActions` — its results must not change in this task
- Any file not listed under Touch. If completing the objective seems to require touching an unlisted file, STOP and report BLOCKED. Exception: if an existing test sends a freighter to a moon whose spec lists unsettled dependencies and now fails, report it under DEVIATIONS with the test's name and the smallest change to that test's spec that fixes it; do not weaken the check.

**Standing exclusions:**
- Security-routed files, never modified by this lane: `src/core/git.ts`, `src/validate/**`, `src/providers/claude-sdk/gate-hook.ts`, `src/server/dispatch.ts`, `src/db/migrations/**`, `src/server/http/auth.ts`, `src/server/lock.ts`
- Pipeline-owned paths: `docs/superpowers/plans/**`, `docs/superpowers/tasks/**`, `.superpowers/sdd/**`
- `package.json`, `package-lock.json` — no dependency changes

## Interfaces

Produced:

```ts
// src/server/commands/deps.ts
export type DependencyState = {
  /** A freighter has been sent to this moon under its current assignment (an implement voyage exists). */
  visited: boolean;
  /** Task ids in the moon's depends_on that are not settled on the same planet. */
  waitingOn: string[];
  /** Stream ids in the planet's depends_on. In this slice every one of them counts as unmet. */
  waitingOnPlanets: string[];
};
export function dependencyState(g: Galaxy, taskId: string): DependencyState;
// Throws the same Refusal loadMoon throws for an unknown task id.

// src/server/commands/launch.ts — in launchMoon, directly after "Precheck 1: state"
// if (!visited && waitingOn.length > 0) throw new Refusal(`moon ${taskId} is waiting on ${waitingOn.join(", ")} — a freighter can be sent once they are settled`);

// src/server/commands/query.ts
// every assigned moon row in Snapshot.systems[].planets[].moons[] and MoonDetail.moon gain:
//   waiting_on: string[];  waiting_on_planets: string[];
// (rows are typed Row = Record<string, unknown>; no type change is needed beyond what you choose to document)
```

Consumed (exact current signatures; do not change them):

```ts
// src/server/dispatch.ts  (import only)
export type MoonRow = { id: string; planet_id: string; task_id: string; assignment_id: number; status: string | null; round: number; spec_path: string; spec_sha: string; park_reason: string | null; tier: string | null; touch?: string | null };
export function loadMoon(g: Galaxy, taskId: string): MoonRow;
// named statements (src/db/statements.ts), all SELECT *:
//   "moons.byTask" { task_id }        "moons.byPlanet" { planet_id }        "planets.byId" { id }
//   "voyages.latestByAssignmentRole" { assignment_id, role }   → latest voyage row or undefined
// columns: moons.depends_on TEXT (JSON array of task ids, or NULL), planets.depends_on TEXT (JSON array of stream ids, or NULL), moons.status ('merged' = settled)
// src/server/errors.ts
export class Refusal extends Error { constructor(message: string, details?: Record<string, unknown>) }
// src/server/commands/query.ts
export function snapshot(g: Galaxy, ctx: OwnerCtx & { failures: Failure[] }): Snapshot;      // ctx: { ownPid: number; tracks?: (voyageId: string) => boolean; failures: Failure[] }
export function moonDetail(g: Galaxy, taskId: string, ctx: OwnerCtx): MoonDetail;
// src/server/commands/assign.ts
export function assignPlanet(g: Galaxy, input: { systemId: string; streamId: string; mission: string; territory: string[]; dependsOn?: string[]; planetName?: string }): { planetId: string; branch: string; worktree: string; discovered: boolean };
export function assignMoon(g: Galaxy, input: { planetId: string; specPath: string; moonName?: string }): { moonId: string; taskId: string; discovered: boolean; attention: Record<string, string[]> };
// src/server/commands/launch.ts / review.ts / dock.ts
export async function launchMoon(g: Galaxy, input: { taskId: string; provider?: string; ... }): Promise<{ voyageId: string; audit: AuditReport | null; moonStatus: MoonStatus }>;
export async function inspectMoon(g, input: { taskId: string; provider?: string; ... });
export function dockMoon(g: Galaxy, input: { taskId: string }): { mergeSha: string | null; planetBranch: string; moonStatus: "merged" | "adrift" };
```

Test helpers: `makeGalaxy`, `writeSpec(dir, taskId, body?)`, `read` from `tests/helpers.mjs`; `createSystem` from `dist/server/commands/system.js`; see `worldWithTwoMoons` in `tests/fixtures/world.mjs` for how to build a planet with several moons. Give a spec dependencies by inserting a `- **Depends on**: A` line into the Meta block of `tests/fixtures/specs/good-basic.md` (see `tests/fixtures/specs/good-deps.md` for the line's form). Each moon's spec needs its own Touch paths if two are worked in one test; if the fixture's shared paths cause a refusal, give each spec a distinct file under `src/lib/`.

## Constraints
- A dependency id is settled only when a moon on the **same planet** has that `task_id` and status `merged`. Not assigned anywhere, `dropped`, `adrift`, `quarantined`, any other status, or settled on another planet → it stays in `waitingOn`. Order follows the spec's `depends_on` order.
- `depends_on` that is NULL, empty, unparseable or not an array of strings reads as `[]`; nothing throws.
- `visited` means an implement voyage exists for the moon's current `assignment_id`.
- Read rows through the named statements with a local row type. Do not edit `MoonRow` / `PlanetRow`.
- `launchMoon` enforces only `waitingOn`, only when `!visited`. `waitingOnPlanets` is never enforced in `launchMoon`.
- Reads: for an assigned moon that is not visited, `waiting_on` / `waiting_on_planets` carry the two lists; for a visited moon both are `[]`. Unassigned (barren) moon rows are left as they are.
- The refusal message is exact: `moon <taskId> is waiting on <id>, <id> — a freighter can be sent once they are settled`.
- No new SQL, no new dependencies, no event appended by any of this. Node ≥ 22.13, ES modules, TypeScript strict.
- Tests use `node:test` and `node:assert/strict`, import compiled code from `dist/`, and clean up in `finally`.

## Acceptance

**Test command (must exit 0):**
```bash
npm test -- "tests/server/deps.test.mjs"
```

**Behavioral criteria** (each must be covered by a test in `tests/server/deps.test.mjs`):
1. A moon with no dependencies: `dependencyState` deep-equals `{ visited: false, waitingOn: [], waitingOnPlanets: [] }`.
2. B depends on A, both assigned on one planet → `dependencyState(g, "B").waitingOn` deep-equals `["A"]`.
3. B depends on `NOPE`, which is never assigned → `waitingOn` deep-equals `["NOPE"]`; `snapshot(...)` and `moonDetail(g, "B", ...)` return without throwing and B's row carries `waiting_on: ["NOPE"]`.
4. After A is taken through `launchMoon`, `inspectMoon`, `dockMoon` (status `merged`) → `dependencyState(g, "B").waitingOn` deep-equals `[]`.
5. A is assigned on planet P1 and settled, B on planet P2 depends on A → `waitingOn` deep-equals `["A"]`.
6. With the rung at its default (`manual`): `await assert.rejects(launchMoon(g, { taskId: "B" }), /is waiting on A/)`; B is still `emitted`; no `voyage.launched` event exists for B.
7. A visited moon is not re-checked: a moon that has a FIX verdict on record is sent its next freighter although a dependency is unsettled. Construction: take a moon with no dependencies through a first freighter and a FIX verdict (fake script `fix-round` with a review steered to `review-fix`, as `tests/server/review.test.mjs` does), then set its stored dependencies directly in the test with `g.db.raw.prepare("UPDATE moons SET depends_on = ? WHERE task_id = ?").run('["NOPE"]', "T1")`. Assert `dependencyState(g, "T1")` deep-equals `{ visited: true, waitingOn: ["NOPE"], waitingOnPlanets: [] }`, that `launchMoon(g, { taskId: "T1" })` resolves, and that the moon's `waiting_on` in the snapshot is `[]`. (This test does not call `rebuild`: the direct write is not in the log.)
8. A planet assigned with `dependsOn: ["P0"]` and one moon → `waitingOnPlanets` deep-equals `["P0"]`, the moon's `waiting_on_planets` in the snapshot matches, and `launchMoon` for that moon succeeds.

**Affected workflow IDs**: none

**Regression guard (task level — implementer runs this):**
```bash
npm test
```

## Out of Scope
- No scheduler, no change to `availableActions`, no page changes.
- Do not make planet dependencies block `launchMoon`.
- Do not add dependency-cycle detection: a cycle simply leaves both moons waiting.
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
