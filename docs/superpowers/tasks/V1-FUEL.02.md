# TASK: fuel-states-and-log-kinds

## Meta
- **Task ID**: V1-FUEL.02
- **Parent plan**: docs/superpowers/plans/2026-11-15-v1-fuel.md
- **Depends on**: V1-FUEL.01 (landed: migration 002)
- **Estimated scope**: M
- **Model hint**: terra

## Objective
The state machine and the projections know two new states — a moon whose cargo is `awaiting_pickup` and a voyage that ended `out_of_fuel` — and five new log-only event kinds can be appended and rebuilt.

## Context
This is slice 2 of v1: fuel readings and a limiter. When a ship's provider runs out of allowance mid-voyage, the system will no longer park the moon as `adrift` (which means "needs a person" and nothing else). Instead the voyage ends `out_of_fuel`, the ship is released, and the moon's cargo is `awaiting_pickup` until a freighter can be sent again; a review that runs dry puts the moon back to `audited` (`moon.review_abandoned`). Migration 002 (already merged) lets the two status values into the database; this task adds the arrows, reducers and event kinds. Nothing emits these events yet — later tasks do. Wording rule for every comment and test name: places don't move, appear or vanish; a *ship* runs out of fuel, a moon never does; the work at a moon is its *cargo*. Affected workflow IDs is `none` because this project has no review suite.

## Files

### Touch
| Path | Action | Notes |
|------|--------|-------|
| `tests/core/transitions-fuel.test.mjs` | create | arrows table test |
| `tests/db/reducers-fuel.test.mjs` | create | reducers, ship release, rebuild |
| `src/core/transitions.ts` | modify | statuses and arrows below |
| `src/db/reducers/moons.ts` | modify | two reducers |
| `src/db/reducers/voyages.ts` | modify | one reducer |
| `src/db/reducers/index.ts` | modify | five log-only kinds |
| `src/server/commands/park.ts` | modify | the `SUPERSEDABLE` set only |

### Do NOT touch
- `src/db/reducers/ships.ts` — `ship.released` already leaves the ship `idle` and only raises `voyage_count` for outcomes `docked` and `superseded`; test that, do not change it
- `tests/core/transitions.test.mjs`, `tests/db/*.test.mjs` (existing) — they must keep passing unchanged
- `src/db/statements.ts`, `src/server/**` other than the one set in `park.ts` — owned by later tasks (V1-FUEL.06, .07, .09)
- `src/providers/**` — owned by V1-FUEL.03–.05
- Any file not listed under Touch. If completing the objective seems to require touching an unlisted file, STOP and report BLOCKED.

**Standing exclusions:**
- Security-routed files, never modified by this lane: `src/core/git.ts`, `src/validate/**`, `src/providers/claude-sdk/gate-hook.ts`, `src/server/dispatch.ts`, `src/db/migrations/**`, `src/server/http/auth.ts`, `src/server/lock.ts`
- Pipeline-owned paths: `docs/superpowers/plans/**`, `docs/superpowers/tasks/**`, `.superpowers/sdd/**`
- `package.json`, `package-lock.json` — no dependency changes

## Interfaces

Produced (additions to the existing tables in `src/core/transitions.ts`; every existing arrow stays):

```ts
export type MoonStatus = /* existing nine */ | "awaiting_pickup";
export type VoyageStatus = /* existing nine */ | "out_of_fuel";

// MOON_TRANSITIONS
"moon.awaiting_pickup":  { implementing: "awaiting_pickup", audited: "awaiting_pickup" },
"moon.review_abandoned": { reviewing: "audited" },
"moon.gated":   { /* existing */, awaiting_pickup: "gated" },
"moon.adrift":  { /* existing */, awaiting_pickup: "adrift" },
"moon.dropped": { /* existing */, awaiting_pickup: "dropped" },

// VOYAGE_TRANSITIONS
"voyage.out_of_fuel": { launched: "out_of_fuel", working: "out_of_fuel", holding: "out_of_fuel" },
"voyage.superseded":  { /* existing */, out_of_fuel: "superseded" },
```

```ts
// src/db/reducers/moons.ts — both use the existing transitionMoon(db, ev.moon_id, key, ev.id) with no park reason, so park_reason becomes NULL
"moon.awaiting_pickup", "moon.review_abandoned"
// src/db/reducers/voyages.ts — status only, through the existing set(key) helper
"voyage.out_of_fuel"
// src/db/reducers/index.ts — no-op reducers beside "scheduler.acted", each with a one-line comment in the same style
"fuel.reading", "fuel.exhausted", "limiter.held", "limiter.rerouted", "limiter.refuelled"
// src/server/commands/park.ts
const SUPERSEDABLE = new Set(["holding", "cleared", "en_route", "adrift", "quarantined", "out_of_fuel"]);
```

Consumed (exact current code, do not change):

```ts
// src/db/reducers/moons.ts
export function transitionMoon(db: NexusDb, moonId: string | null | undefined, key: string, lastEventId: number, parkReason: string | null = null): MoonStatus
// src/db/events.ts
export function append(db: NexusDb, ev: NexusEvent, precheck?: () => void): EventRow
// src/db/rebuild.ts
export function rebuild(db: NexusDb): { events: number };  export function dumpProjections(db: NexusDb): string
// src/db/reducers/ships.ts — "ship.released" payload { voyage_id, outcome }; voyage_count rises only for outcome "docked" | "superseded"
```

## Constraints
- Every state change is an appended event with a reducer; after any scenario `rebuild` must leave `dumpProjections` byte-equal.
- SQL lives only in `src/db/statements.ts`; this task adds no SQL.
- No new dependencies. Tests use `node:test` and `node:assert/strict` and import from `dist/` (the test command builds first).
- Follow the existing patterns in `tests/core/transitions.test.mjs` and `tests/db/work-reducers.test.mjs` (how a moon and a voyage are brought into a given state by appending events).

## Acceptance

**Test command (must exit 0):**
```bash
npm test -- "tests/core/*.test.mjs" "tests/db/*.test.mjs"
```

**Behavioral criteria** (each covered by a test in the two new files):
1. Every arrow listed under Interfaces is accepted by `nextMoonStatus` / `nextVoyageStatus` and gives the listed status.
2. For the new event keys, and for `moon.gated`, `moon.adrift`, `moon.dropped`, `voyage.superseded`, every source status **not** in the table (taken over all ten moon statuses plus `barren`, all ten voyage statuses) is refused with `TransitionRefused`. In particular `awaiting_pickup` does not accept `voyage.launched:implement` (a freighter is sent only after `moon.gated`) and `out_of_fuel` accepts nothing but `voyage.superseded`.
3. Appending `voyage.out_of_fuel`, `ship.released { voyage_id, outcome: "out_of_fuel" }`, `moon.awaiting_pickup {}` to a moon with a freighter in flight leaves: voyage `out_of_fuel`, ship `idle` with `voyage_count` unchanged, moon `awaiting_pickup` with `park_reason` NULL.
4. Appending `voyage.out_of_fuel`, `ship.released`, `moon.review_abandoned {}` for a customs voyage on a `reviewing` moon leaves the moon `audited`, its round unchanged, the customs ship `idle`, and the freighter voyage still `holding`.
5. `moon.awaiting_pickup` clears a `park_reason` set earlier (moon parked `adrift` with a reason, re-gated, freighter sent, then `moon.awaiting_pickup`).
6. An event of each of the five log-only kinds can be appended and changes no projection row other than nothing at all (`dumpProjections` equal before and after).
7. After each scenario above, `rebuild` leaves `dumpProjections` byte-equal.

**Affected workflow IDs**: none

**Regression guard (task level — implementer runs this):**
```bash
npm test
```

## Out of Scope
- Do not emit the new events from any command, the dispatcher or the scheduler.
- Do not rename existing identifiers or events (`moon.dropped`, `moon.adrift`, …).
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
