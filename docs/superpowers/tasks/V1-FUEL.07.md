# TASK: fuel-the-wall

## Meta
- **Task ID**: V1-FUEL.07
- **Parent plan**: docs/superpowers/plans/2026-11-15-v1-fuel.md
- **Depends on**: V1-FUEL.06
- **Estimated scope**: S
- **Model hint**: sol

## Objective
One function ends a voyage whose provider ran out of allowance mid-run: it records when the pool is expected back, releases the ship, and leaves the moon's cargo awaiting pickup (or, for customs, the moon ready to be inspected again) with no decision for a person — unless it is the second time in a row on that provider, in which case the moon is parked as today.

## Context
Slice 2 of v1. Today a rate-limited voyage is parked: the moon goes `adrift`, the ship is left adrift and a decision waits for a person. That is wrong for a pool that simply refills: nobody needs to look. From now on `adrift` means only "needs a person". A voyage that hits the wall ends `out_of_fuel`, its ship is **released** (a ship left adrift would never come back, because nobody replies to a moon that is merely waiting), and the moon is `awaiting_pickup` — the work stays in the worktree and a later freighter picks it up. The one case a person should see is a second wall hit in a row on the same provider: then the reset time was wrong or the pool is being drained elsewhere. This task only adds the function; the dispatcher (security-routed, a KEEP task) and the commands call it later. Wording rule for comments and test names: a *ship* runs out of fuel or hits the wall; a moon never does; the moon's *cargo awaits pickup*. Affected workflow IDs is `none` because this project has no review suite.

## Files

### Touch
| Path | Action | Notes |
|------|--------|-------|
| `tests/server/limiter-wall.test.mjs` | create | |
| `src/server/limiter/wall.ts` | create | |

### Do NOT touch
- `src/server/dispatch.ts` — security-routed; import `loadMoon`, `moonScope`, `parkVoyage` from it, never edit it. (It will import this module back in a later task; use its exports only inside function bodies, never at module top level, so the import cycle is harmless.)
- `src/server/limiter/pool.ts`, `src/server/limiter/limiter.ts` — owned by V1-FUEL.06; import `poolReadings`
- `src/core/transitions.ts`, `src/db/reducers/**` — owned by V1-FUEL.02
- `src/server/commands/**`, `src/server/scheduler/**` — callers are wired in later tasks
- Any file not listed under Touch. If completing the objective seems to require touching an unlisted file, STOP and report BLOCKED.

**Standing exclusions:**
- Security-routed files, never modified by this lane: `src/core/git.ts`, `src/validate/**`, `src/providers/claude-sdk/gate-hook.ts`, `src/server/dispatch.ts`, `src/db/migrations/**`, `src/server/http/auth.ts`, `src/server/lock.ts`
- Pipeline-owned paths: `docs/superpowers/plans/**`, `docs/superpowers/tasks/**`, `.superpowers/sdd/**`
- `package.json`, `package-lock.json` — no dependency changes

## Interfaces

Produced:

```ts
// src/server/limiter/wall.ts
export function endOutOfFuel(g: Galaxy, p: {
  taskId: string; voyageId: string; shipId: string; role: Role; provider: string; model?: string;
  resetsAt?: string; modelFamily?: string; details: string;
}): { parked: boolean; until: string };
```

Consumed (exact current code):

```ts
// src/server/dispatch.ts
export function loadMoon(g: Galaxy, taskId: string): MoonRow                       // { id, planet_id, task_id, assignment_id, status, round, … }
export function moonScope(g: Galaxy, moon: MoonRow): Pick<NexusEvent, "system_id" | "planet_id" | "moon_id" | "task_id" | "assignment_id">
/** Park sequence: voyage.adrift, ship.adrift, moon.adrift, then decision.opened (kind "adrift"). */
export function parkVoyage(g: Galaxy, p: { taskId: string; voyageId: string; shipId: string; reason: string; details?: string }): void
// src/server/limiter/pool.ts (V1-FUEL.06)
export function poolReadings(g: Galaxy, provider: string): Reading[]               // Reading { window, used, resets_at?, model_family?, ts }
// src/server/galaxy.ts (V1-FUEL.06):  g.now(): number
// src/db/statements.ts:  "voyages.byAssignment" (rows: id, role, round, provider, status, launched_ts — ordered by launch), "events.byAssignment"
// Events and arrows from V1-FUEL.02:
//   voyage.out_of_fuel   launched | working | holding → out_of_fuel
//   ship.released        payload { voyage_id, outcome }  → ship idle
//   moon.awaiting_pickup implementing | audited → awaiting_pickup
//   moon.review_abandoned reviewing → audited
//   fuel.exhausted       log-only; envelope provider; payload { until, voyage_id, model_family? }
```

## Constraints
The function does these in order; each append is its own transaction, as in `parkVoyage`:

1. **`until`** = `p.resetsAt` when it parses as a date; else the **earliest** `resets_at` among `poolReadings(g, p.provider)` (the shortest window is the likeliest wall); else `g.now()` + 30 minutes. Then, whatever the source: never earlier than `g.now()` + 60 seconds — a past or nonsense time must not leave the pool looking available at once. `until` is an ISO string.
2. Append **`fuel.exhausted`** with the moon's scope, `voyage_id`, envelope `provider: p.provider`, payload `{ until, voyage_id, ...(modelFamily ? { model_family } : {}) }`. Always, including on a second hit.
3. **Second hit:** look at the voyages of this assignment with the same role and the same provider, in launch order, excluding the current one. If the most recent of them has a `voyage.out_of_fuel` event in the log (use the log, not the voyage's current status — an out-of-fuel voyage is later `superseded`), call `parkVoyage(g, { taskId, voyageId, shipId, reason: "rate_limited", details })` and return `{ parked: true, until }`. Voyages on other providers in between neither trigger nor reset this.
4. **Otherwise** append `voyage.out_of_fuel` (scope + `voyage_id` + `ship_id`, payload `{ reason: "out_of_fuel", details }`), then `ship.released` (payload `{ voyage_id, outcome: "out_of_fuel" }`), then for role `implement` `moon.awaiting_pickup {}` or for role `review` `moon.review_abandoned {}`. Open no decision. Return `{ parked: false, until }`.
- Time is `g.now()`, never `Date.now()`. `p.model` is accepted for callers' symmetry and is not used in any rule here.
- No new dependencies. Tests import from `dist/`; bring a moon into each starting state with the real commands (`launchMoon`, `inspectMoon` from `dist/server/commands/`) wrapped so the voyage is still in flight when the function is called — `runVoyage`'s `onLaunched`/a hanging fake adapter, or by appending the launch events directly as `tests/db/work-reducers.test.mjs` does; whichever is simpler, but the ship and voyage rows must be real.

## Acceptance

**Test command (must exit 0):**
```bash
npm test -- "tests/server/limiter-wall.test.mjs"
```

**Behavioral criteria** (each a named test):
1. `until` from `resetsAt` when it is a valid future time; the `fuel.exhausted` event carries it, the provider in the envelope, the voyage id, and `model_family` only when `modelFamily` was given.
2. `resetsAt` absent and two live readings with resets 10 minutes and 3 days ahead → `until` is the 10-minute one.
3. No `resetsAt`, no readings → `until` is `g.now()` + 30 minutes.
4. `resetsAt` in the past, and `resetsAt: "soon"` (unparseable, no readings) → the first gives `g.now()` + 60 s, the second `g.now()` + 30 min. A `resetsAt` 5 s ahead → `g.now()` + 60 s.
5. First hit, freighter in flight (moon `implementing`): voyage `out_of_fuel`, ship `idle` with `voyage_count` unchanged, moon `awaiting_pickup` with no `park_reason`, no pending decision, returns `{ parked: false }`.
6. First hit, freighter already returned and `holding` with the moon `audited` (the report said the provider was rate-limited): voyage `out_of_fuel`, ship `idle`, moon `awaiting_pickup`.
7. First hit for customs (moon `reviewing`): customs voyage `out_of_fuel`, customs ship `idle`, moon `audited`, its round unchanged, the freighter voyage still `holding` and its ship still assigned.
8. Second hit on the same provider: returns `{ parked: true }`, moon `adrift` with `park_reason` `rate_limited`, one pending decision, the ship `adrift`, and a second `fuel.exhausted` exists.
9. A wall hit on provider A, then one on provider B, then one on A again: the first two are not parked; the third is (the previous voyage *on A* ran out of fuel). And: hit on A, a voyage on A that returned normally, hit on A again → not parked.
10. After every scenario, `rebuild` leaves `dumpProjections` byte-equal.

**Affected workflow IDs**: none

**Regression guard (task level — implementer runs this):**
```bash
npm test
```

## Out of Scope
- Do not call `endOutOfFuel` from anywhere (V1-FUEL.08 and .09 do).
- Do not change `parkVoyage` or any existing park behaviour.
- Do not update documentation. Do not fix unrelated failing tests — report them instead.

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
