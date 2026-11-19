# TASK: fuel-contraband-and-raids

## Meta
- **Task ID**: V1-FUEL.19
- **Parent plan**: docs/superpowers/plans/2026-11-15-v1-fuel.md
- **Depends on**: V1-FUEL.09
- **Estimated scope**: S
- **Model hint**: sol

## Objective
When a freighter comes to pick up cargo and the audit of that cargo fails, the moon goes `adrift` with the reason and a decision for a person, instead of the launch being refused while the moon sits `awaiting_pickup` with nothing to draw attention to it.

## Context
Slice 2 of v1. A freighter that hits the wall mid-flight is never audited; its work stays in the worktree and the moon is `awaiting_pickup`. The next freighter audits that cargo before it flies (the carry-over audit). Today a failed carry-over audit on a pickup throws a refusal: the moon stays `awaiting_pickup`, no decision is opened, and the scheduler eventually parks it under the generic `scheduler_refused`. The owner decided (2026-11-18) that this must stand out from the normal flow. `adrift` already means "needs a person", and the arrow `awaiting_pickup → adrift` already exists, so no new status is added. The two reasons keep their existing codes and get owner-chosen wording: `carryover_violations` is **contraband in the cargo** (files outside the task's allowed paths, whoever put them there); `baseline_tampered` is a **raid** (the gate's own record of the starting point was altered). Wording rule: a ship runs out of fuel or hits the wall, a moon never does; the moon's cargo awaits pickup; `adrift` means only "needs a person". Affected workflow IDs is `none` because this project has no review suite.

## Files

### Touch
| Path | Action | Notes |
|------|--------|-------|
| `tests/server/launch-contraband.test.mjs` | create | |
| `src/server/commands/launch.ts` | modify | the `parkMoon` helper inside `launchMoon` only |

### Do NOT touch
- `src/server/commands/park.ts`, `review.ts`, `query.ts`, `src/server/http/commands.ts`, `src/cli/run.ts` — owned by V1-FUEL.09
- `src/server/scheduler/**` — owned by V1-FUEL.10 and .11
- `src/core/transitions.ts`, `src/db/reducers/**`, `src/server/limiter/**`
- Existing test files. If one fails, STOP and report it (name the test and the assertion).
- Any file not listed under Touch. If completing the objective seems to require touching an unlisted file, STOP and report BLOCKED.

**Standing exclusions:**
- Security-routed files, never modified by this lane: `src/core/git.ts`, `src/validate/**`, `src/providers/claude-sdk/gate-hook.ts`, `src/server/dispatch.ts`, `src/db/migrations/**`, `src/server/http/auth.ts`, `src/server/lock.ts`
- Pipeline-owned paths: `docs/superpowers/plans/**`, `docs/superpowers/tasks/**`, `.superpowers/sdd/**`
- `package.json`, `package-lock.json` — no dependency changes

## Interfaces

Produced (signature unchanged):

```ts
// src/server/commands/launch.ts
export async function launchMoon(g, input, deps?): Promise<{ voyageId: string; audit: AuditReport | null; moonStatus: MoonStatus }>
// New outcome, only when the moon's status was "awaiting_pickup" and the carry-over audit fails:
//   resolves { voyageId: "", audit: <the carry report, or null for baseline_tampered>, moonStatus: "adrift" }
//   after appending, in this order, in the moon's scope:
//     moon.adrift      payload { reason }                      reason: "carryover_violations" | "baseline_tampered"
//     decision.opened  payload { kind: "adrift", target_kind: "moon", target_id: taskId, reasoning }
```

Consumed (exact current code, inside `launchMoon`):

```ts
const status = moon.status;
const relaunch = status === "adrift" || status === "quarantined" || status === "awaiting_pickup";
// ...
const parkMoon = (reason: string, details: Record<string, unknown>): { voyageId: string; audit: AuditReport | null; moonStatus: MoonStatus } => {
  // A moon that is already parked cannot go adrift again: refuse and leave it as it is (fix the worktree, then relaunch).
  if (relaunch) throw new Refusal(`carry-over audit refused the parked worktree (${reason})`, details);
  // The previous freighter voyage is already superseded (cannot go adrift), so park the moon itself.
  append(g.db, { kind: "moon.adrift", ...scope, payload: { reason } });
  append(g.db, { kind: "decision.opened", ...scope, payload: { kind: "adrift", target_kind: "moon", target_id: taskId, reasoning: `round ${moon.round} work changed after its audit (${reason}): ${JSON.stringify(details)}` } });
  return { voyageId: "", audit: null, moonStatus: "adrift" };
};
// callers:  return parkMoon("baseline_tampered", { message: err.message });
//           return { ...parkMoon("carryover_violations", details), audit: carry };   // details { out_of_scope, forbidden, error? }
// src/core/transitions.ts:  "moon.adrift": { …, awaiting_pickup: "adrift" }   (the reducer stores payload.reason as park_reason)
// tests/fixtures/world.mjs: worldWithMoon(script, patchConfig) — script "wall" ends the first freighter out of fuel;
//   the moon's worktree is path.join(w.g.paths.worktrees, "T1"); the fixture spec's Touch is src/**.
// src/server/commands/park.ts: replyMoon(g, { taskId, note }), dropMoon(g, { taskId, … })
```

## Constraints
- In `parkMoon`, the refusal applies only when `status` is `adrift` or `quarantined` (a moon a person has already been asked about). When `status` is `awaiting_pickup` it parks: the two appends above, then the return.
- The decision's `reasoning` depends on how the moon got here:
  - pickup, `carryover_violations`: `contraband in the cargo awaiting pickup: ` followed by `JSON.stringify(details)`
  - pickup, `baseline_tampered`: `raided: the gate baseline changed while the cargo awaited pickup: ` followed by `JSON.stringify(details)`
  - FIX round (status `audited`): today's text, byte for byte.
- The refusal message for an `adrift` or `quarantined` moon stays byte for byte.
- A pickup that parks launches nothing: no `voyage.launched`, no `moon.gated`, no `limiter.*` event, no ship leaves `idle`, the moon's `round` does not change, and nothing in the worktree is committed, reverted or deleted.
- Everything else in `launch.ts` stays as it is. No new dependencies. Tests import from `dist/`.
- In tests the pool is dry for at least a minute after a ship hits the wall, so every later launch passes `override: true`.
- Each test's name starts with its criterion number (`1.` … `7.`). Every world a test builds ends with a helper that asserts `dumpProjections` is equal before and after `rebuild` (as `finish(w)` in `tests/server/dispatch-fuel.test.mjs`).

## Acceptance

**Test command (must exit 0):**
```bash
npm test -- "tests/server/launch-contraband.test.mjs" && npm test -- "tests/server/*.test.mjs"
```

**Behavioral criteria** (each a named test in `tests/server/launch-contraband.test.mjs`):
1. **Contraband parks the moon.** `wall` launch → `awaiting_pickup`. Write a file outside `src/**` into the worktree (for example `README-extra.md`). `launchMoon` with `override: true` resolves with `voyageId: ""`, `moonStatus: "adrift"` and an `audit` whose `verdict` is `"violations"`. Then: the moon is `adrift` with `park_reason` `carryover_violations`; exactly one decision is pending, kind `adrift`, target the moon, its `reasoning` starts with `contraband in the cargo awaiting pickup: ` and contains the file's path; `moon.adrift` comes immediately before `decision.opened` in the moon's events.
2. **Nothing flew.** In the same scenario, compared with just before the second launch: the number of `voyage.launched`, `moon.gated` and `limiter.rerouted`/`limiter.refuelled` events is unchanged, every ship is `idle`, the moon's `round` is unchanged, and the contraband file is still in the worktree.
3. **A raid parks the moon.** `wall` launch → `awaiting_pickup`. Alter the gate's state file for the task (as `tests/server/launch.test.mjs` test "I4b" does). `launchMoon` with `override: true` resolves with `moonStatus: "adrift"` and `audit: null`; `park_reason` is `baseline_tampered`; the one pending decision's `reasoning` starts with `raided: the gate baseline changed while the cargo awaited pickup: `.
4. **Now it needs a reply.** After 1, `launchMoon` with `override: true` rejects matching `/adrift.*reply/`. After `replyMoon` with the contraband still there, `launchMoon` rejects matching `/carry-over audit refused the parked worktree \(carryover_violations\)/`, the moon is still `adrift`, and no second `moon.adrift` event was appended by that refusal.
5. **Cleared by hand, it flies.** After 1: delete the contraband file, `replyMoon`, then `launchMoon` with `override: true` (the `wall` fixture's round 2 is `happy`, and the parked pickup did not advance the round) → `audited`, and the moon's `round` is one more than before that launch.
6. **It can be dropped.** After 1, `dropMoon` → the moon is `dropped`, every ship `idle`, no decision pending.
7. **A FIX round keeps its wording.** Audited moon with a FIX verdict (`reviewScript: "review-fix"`), a file outside `src/**` written into the worktree, then `launchMoon`: the moon parks `carryover_violations` and the decision's `reasoning` starts with `round ` and contains `work changed after its audit (carryover_violations)`.

Criteria 1, 2, 3, 5 and 6 fail before the change (the pickup rejects instead of resolving); 4's second half and 7 pass before and after.

**Affected workflow IDs**: none

**Regression guard (task level — implementer runs this):**
```bash
npm test
```

## Out of Scope
- Do not add a moon status, a transition or a migration.
- Do not rename the reason codes `carryover_violations` and `baseline_tampered`, and do not change how other paths (`dock.ts`, the mid-flight audit) use them.
- Do not change the Bridge page or the reads; the labels are shown by V1-FUEL.12, .14 and .15.
- Do not restore or clean the worktree automatically.
- Do not update documentation. Do not fix unrelated failing tests — report them instead (known flake: `tests/server/follow.test.mjs` under load).

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

## Amendments

### A1 — 2026-11-18 — accepted deviation
- **Original sha256**: 4a375fea8b01c447574a1c9226865b81f6051faddafa4895da3c1828dfccb63b
- **Verdict ref**: APPROVE, V1-FUEL.19 round 0, lanes-reviewer
- **Deviation**: test 6 does not assert a `dropped` status. It asserts the moon's row reads `body_status` `barren` and that exactly one `moon.dropped` event is in the moon's events.
- **Reason accepted**: `dropMoon` appends `moon.dropped` and then `moon.cleared` in one call, and `moons.clear` sets `status` to NULL. The reviewer read the row after `dropMoon`: `status` null, `body_status` `barren`, `task_id` null. A `dropped` status is never readable on the stored row, so the original wording could not be asserted. Same form as the existing drop test in `tests/server/park.test.mjs`.
- **Affected paths**: tests/server/launch-contraband.test.mjs
- **Acceptance criteria**: criterion 6 reads: "After 1, `dropMoon` → exactly one `moon.dropped` event in the moon's events and the moon's row reads `body_status` `barren`; every ship `idle`; no decision pending."

### A2 — 2026-11-18 — accepted deviation
- **Original sha256**: 4a375fea8b01c447574a1c9226865b81f6051faddafa4895da3c1828dfccb63b
- **Verdict ref**: APPROVE, V1-FUEL.19 round 0, lanes-reviewer
- **Deviation**: tests 3 and 5 assert the moon's status on the value `launchMoon` resolves with (`moonStatus`), not on the stored moon. Test 3 also asserts the stored `park_reason`; test 5 also asserts the stored `round`.
- **Reason accepted**: criterion 3 already says "resolves with `moonStatus: "adrift"`", and two mutants that return `adrift` without storing it turn test 3 red through `park_reason`. On criterion 5's path the returned value is `loadMoon(g, taskId).status`, read from the store in a line this task does not change; the existing relaunch tests use the same form.
- **Affected paths**: tests/server/launch-contraband.test.mjs
- **Acceptance criteria**: criterion 3 unchanged. Criterion 5's ending reads: "→ `launchMoon` resolves with `moonStatus: "audited"`, and the moon's stored `round` is one more than before that launch."

### A3 — 2026-11-18 — accepted deviation
- **Original sha256**: 4a375fea8b01c447574a1c9226865b81f6051faddafa4895da3c1828dfccb63b
- **Verdict ref**: APPROVE, V1-FUEL.19 round 0, lanes-reviewer
- **Deviation**: the implementer could not run the new tests against the old code, so "criteria 1, 2, 3, 5 and 6 fail before the change" was reported from reading only.
- **Reason accepted**: the reviewer ran it, replacing the compiled `launch.js` in memory with the old `if (relaunch) throw` line (worktree unchanged): tests 1, 2, 3, 4, 5 and 6 fail with `carry-over audit refused the parked worktree (…)`, test 7 passes. Test 4 fails as a whole because its setup is criterion 1's park; its second half is behaviour that existed before.
- **Affected paths**: tests/server/launch-contraband.test.mjs
- **Acceptance criteria**: unchanged
