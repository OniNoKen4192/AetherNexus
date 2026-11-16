# TASK: moon-only-park-and-log-only-kinds

## Meta
- **Task ID**: V1-SCHEDULER.01
- **Parent plan**: docs/superpowers/plans/2026-11-15-v1-scheduler.md
- **Depends on**: none
- **Estimated scope**: M
- **Model hint**: terra

## Objective
A moon that has no live voyage can be parked (set adrift with a decision for the human) from any state in which the scheduler may fail to act on it, a parked moon can be parked again, and the event log accepts two new kinds, `scheduler.acted` and `config.changed`, that project nothing.

## Context
Aether Nexus is getting a scheduler that sends freighters to moons, has customs inspect them and docks them, by itself. When an automatic step is refused twice in a row the scheduler must stop and hand the moon to a human; this task builds the three small foundations for that. Today `moon.adrift` is legal only from `implementing`, `audited` and `reviewing`, and the only moon-only park is a private closure inside `launchMoon` (`parkMoon` in `src/server/commands/launch.ts`); leave that closure as it is and follow its event sequence. A re-park (`adrift → adrift`, `quarantined → quarantined`) exists so that a moon which was replied to and then refused again gets a fresh decision instead of looping: the new `moon.adrift` event is newer than the reply, which makes `repliedSincePark` false again. Wording rule for comments, messages and test names: places don't move, ships do — a freighter is *sent to* a moon, customs *inspects*, the freighter *docks*, the moon is then *settled*; never "the moon launches / flies / docks". Existing identifiers are not renamed. Affected workflow IDs is `none` because this project has no review suite.

## Files

### Touch
| Path | Action | Notes |
|------|--------|-------|
| `tests/server/scheduler-foundations.test.mjs` | create | the acceptance tests, written first |
| `src/core/transitions.ts` | modify | four more arrows for `moon.adrift` |
| `src/db/reducers/index.ts` | modify | no-op reducers for the two new kinds |
| `src/server/commands/park.ts` | modify | add `parkMoonOnly`; change nothing existing |
| `tests/core/transitions.test.mjs` | modify | only if it fails because it enumerates the legal arrows; add the four new arrows, nothing else |

### Do NOT touch
- `src/server/commands/launch.ts`, `src/server/commands/query.ts`, `src/server/commands/deps.ts` — owned by task V1-SCHEDULER.02
- `src/server/commands/config.ts` — owned by task V1-SCHEDULER.03
- `src/server/http/**`, `src/cli/**`, `src/server/scheduler/**`, `web/**` — owned by later tasks
- `src/db/reducers/moons.ts`, `src/db/statements.ts` — the existing `moon.adrift` reducer already does what is needed
- Any file not listed under Touch. If completing the objective seems to require touching an unlisted file, STOP and report BLOCKED.

**Standing exclusions:**
- Security-routed files, never modified by this lane: `src/core/git.ts`, `src/validate/**`, `src/providers/claude-sdk/gate-hook.ts`, `src/server/dispatch.ts`, `src/db/migrations/**`, `src/server/http/auth.ts`, `src/server/lock.ts`
- Pipeline-owned paths: `docs/superpowers/plans/**`, `docs/superpowers/tasks/**`, `.superpowers/sdd/**`
- `package.json`, `package-lock.json` — no dependency changes

## Interfaces

Produced:

```ts
// src/server/commands/park.ts
/** Park a moon that has no live voyage: moon.adrift + an 'adrift' decision. Legal from emitted, gated, audited, reviewing, adrift, quarantined. */
export function parkMoonOnly(g: Galaxy, p: { taskId: string; reason: string; details: string }): void;
// appends, in this order, both scoped with moonScope(g, moon):
//   { kind: "moon.adrift",      payload: { reason } }
//   { kind: "decision.opened",  payload: { kind: "adrift", target_kind: "moon", target_id: taskId, reasoning: `${reason}: ${details}` } }
// An illegal state surfaces as the TransitionRefused the reducer already throws; add no separate check.

// src/core/transitions.ts — MOON_TRANSITIONS["moon.adrift"] becomes
{ implementing: "adrift", audited: "adrift", reviewing: "adrift", emitted: "adrift", gated: "adrift", adrift: "adrift", quarantined: "quarantined" }

// src/db/reducers/index.ts — registered next to "tree.written", each with a one-line comment saying why nothing is projected
"scheduler.acted": () => {}     // payload { action, task_id, rung }
"config.changed":  () => {}     // payload { key, from, to, pid }
```

Consumed (exact current signatures; do not change them):

```ts
// src/db/events.ts
export function append(db: NexusDb, ev: NexusEvent, precheck?: () => void): EventRow;
// src/server/dispatch.ts  (import only)
export function loadMoon(g: Galaxy, taskId: string): MoonRow;   // MoonRow has status, park_reason, assignment_id, task_id
export function moonScope(g: Galaxy, moon: MoonRow): Pick<NexusEvent, "system_id" | "planet_id" | "moon_id" | "task_id" | "assignment_id">;
// src/server/commands/launch.ts
export function repliedSincePark(g: Galaxy, assignmentId: number): boolean;
// src/server/commands/park.ts
export function replyMoon(g: Galaxy, input: { taskId: string; note: string }): { round: number };
// src/core/transitions.ts
export function nextMoonStatus(from: MoonStatus | "barren", event: string, id: string): MoonStatus;   // throws TransitionRefused
// src/db/reducers/index.ts  (today)
const treeReducers: Record<string, Reducer> = { "tree.written": () => {} };
```

Test helpers: `worldWithMoon(script?)` from `tests/fixtures/world.mjs` → `{ g, dir, git, cleanup, systemId, planetId, moonId }` with one assigned moon `T1` in status `emitted`. `rebuild` from `dist/db/rebuild.js`; for the projection dump follow whatever existing tests use (search the tests for `dumpProjections`).

## Constraints
- Every state change is an appended event with a reducer; after each test scenario `rebuild` must leave the projection dump byte-equal.
- No new SQL statements, no new dependencies. Node ≥ 22.13, ES modules, TypeScript strict.
- `parkMoonOnly` follows the event sequence of the `parkMoon` closure in `src/server/commands/launch.ts`; it does not touch voyages or ships.
- Tests use `node:test` and `node:assert/strict`, import compiled code from `dist/`, and call `cleanup()` in `finally`.

## Acceptance

**Test command (must exit 0):**
```bash
npm test -- "tests/server/scheduler-foundations.test.mjs"
```

**Behavioral criteria** (each must be covered by a test in `tests/server/scheduler-foundations.test.mjs`):
1. `nextMoonStatus("emitted", "moon.adrift", "T1") === "adrift"`, the same for `gated`; `nextMoonStatus("adrift", "moon.adrift", "T1") === "adrift"`; `nextMoonStatus("quarantined", "moon.adrift", "T1") === "quarantined"`; from `merged` and from `dropped` it still throws `TransitionRefused`.
2. After `parkMoonOnly(g, { taskId: "T1", reason: "scheduler_refused", details: "spec body changed" })` on an emitted moon: `loadMoon(g, "T1").status === "adrift"`, `park_reason === "scheduler_refused"`, and `decisions.pendingByTarget` for `T1` has exactly one row, with `kind === "adrift"` and a `reasoning` that includes `"spec body changed"`.
3. A re-park consumes the reply: park, then `replyMoon(g, { taskId: "T1", note: "try again" })` → `repliedSincePark` is `true` and no decision is pending; `parkMoonOnly` again → `repliedSincePark` is `false`, status is still `adrift`, exactly one decision is pending.
4. `scheduler.acted` (scoped to the moon, payload `{ action: "launch", task_id: "T1", rung: "roundabout" }`) and `config.changed` (payload `{ key: "automation.level", from: "manual", to: "verdicts", pid: 1 }`) can each be appended, and the projection dump is byte-equal before and after `rebuild`.

**Affected workflow IDs**: none

**Regression guard (task level — implementer runs this):**
```bash
npm test
```

## Out of Scope
- Do not replace or refactor the `parkMoon` closure in `launch.ts`.
- Do not add a scheduler, a config command or any caller of `parkMoonOnly`.
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
