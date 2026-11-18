# TASK: fuel-commands-meet-the-limiter-fix1

## Meta
- **Task ID**: V1-FUEL.09-FIX1
- **Parent plan**: docs/superpowers/plans/2026-11-15-v1-fuel.md
- **Depends on**: V1-FUEL.09 round 0 (the work as it stands on base 36560ca)
- **Estimated scope**: S
- **Model hint**: sol

## Objective
Superseding a voyage that ended out of fuel never frees a ship. Dropping a moon whose cargo awaits pickup, or replying to a moon that still has an `out_of_fuel` voyage on record, leaves every ship that is flying or holding another round `assigned`. Five rules that round 0 implemented correctly but no test protects each get a named test.

## Context
Round 0 passed its twenty criteria and is otherwise approved; do not rework it. It made two paths reachable: `dropMoon` on an `awaiting_pickup` moon, and a pickup that is later parked and replied to. Both go through `releaseMoonVoyages`, which appends `ship.released` for every superseded voyage whose ship is not idle. That is right for `holding`, `cleared`, `en_route`, `adrift` and `quarantined` voyages, which still hold their ship. It is wrong for `out_of_fuel`: `endOutOfFuel` released that ship when the voyage ended, and the ship may since have been sent to another moon. The `ship.released` reducer sets the ship idle whatever it was doing, so the next launch can take a ship another voyage still holds. The voyage must still be superseded; only the release is wrong. Wording rule for messages, comments and test names: a ship runs out of fuel or hits the wall, a moon never does; the moon's cargo awaits pickup; `adrift` means only "needs a person".

## Files

### Touch
| Path | Action | Notes |
|------|--------|-------|
| `tests/server/park-fuel.test.mjs` | create | criteria 21–28 |
| `src/server/commands/park.ts` | modify | `releaseMoonVoyages` only |

### Do NOT touch
- The other round-0 files stay byte-identical: `src/server/commands/launch.ts`, `src/server/commands/review.ts`, `src/server/commands/query.ts`, `src/server/http/commands.ts`, `src/cli/run.ts`, `tests/server/launch-fuel.test.mjs`, `tests/server/review-fuel.test.mjs`, `tests/http/commands-fuel.test.mjs`.
- In `park.ts`, everything except `releaseMoonVoyages`: `SUPERSEDABLE`, `requireParked`, `requireDroppable`, `replyMoon`, `dropMoon`, every message.
- `src/db/reducers/**`, `src/db/statements.ts`, `src/core/transitions.ts`, `src/server/limiter/**`, `src/server/scheduler/**`, `web/**`.
- Existing test files. If one fails, STOP and report it (name the test and the assertion).
- Any file not listed under Touch. If the objective seems to need one, STOP and report BLOCKED.

**Standing exclusions:**
- Security-routed, never modified by this lane: `src/core/git.ts`, `src/validate/**`, `src/providers/claude-sdk/gate-hook.ts`, `src/server/dispatch.ts`, `src/db/migrations/**`, `src/server/http/auth.ts`, `src/server/lock.ts`
- Pipeline-owned: `docs/superpowers/plans/**`, `docs/superpowers/tasks/**`, `.superpowers/sdd/**`
- `package.json`, `package-lock.json` — no dependency changes

## Interfaces

Produced (signature unchanged):

```ts
// src/server/commands/park.ts
export function releaseMoonVoyages(g: Galaxy, moon: MoonRow, outcome: "reply" | "drop"): void;
// For every voyage of the assignment whose status is in SUPERSEDABLE, in the present order:
//   append voyage.superseded                      — unchanged, out_of_fuel included
//   append ship.released { voyage_id, outcome }   — only if the voyage's status was NOT "out_of_fuel"
//                                                   and its ship is neither idle nor retired (the present test)
```

Consumed (exact current code):

```ts
// src/server/limiter/wall.ts — endOutOfFuel, when it does not park, appends voyage.out_of_fuel and then
//   ship.released { voyage_id, outcome: "out_of_fuel" }; the ship is idle from then on and belongs to no voyage.
// src/db/reducers/ships.ts — "ship.released" sets the ship idle unconditionally.
// tests/fixtures/world.mjs — worldWithMoon(script, patchConfig); worldWithTwoMoons(scriptA, scriptB, patchConfig): T1 and T2 on one planet.
// src/server/commands/query.ts — availableActions(g, taskId, { ownPid: process.pid }): Action[]
// src/server/dispatch.ts — loadMoon(g, taskId), moonScope(g, moon)
```

## Constraints
- One behaviour change only: no `ship.released` for a voyage whose status was `out_of_fuel`. Nothing else in `park.ts` changes.
- Tests import from `dist/` and build worlds as `tests/server/launch-fuel.test.mjs` does: `c.providers.fake.pool = { kind: "window", reserve_floor: 0.1 }`, `c.roles`, `c.fleet.freighters`, level `manual`.
- "Low" is a `fuel.reading` event for `fake` with `used: 0.95`. "Dry" is a `fuel.exhausted` event for `fake` whose `until` is an hour ahead.
- After a ship hit the wall the pool is dry for at least a minute, so later launches in the same test pass `override: true`.
- Each test's name starts with its criterion number (`21.` … `28.`).
- No new dependencies.

## Acceptance

**Test command (must exit 0):**
```bash
npm test -- "tests/server/park-fuel.test.mjs" && npm test -- "tests/server/*.test.mjs" "tests/http/commands*.test.mjs"
```

**Behavioral criteria** (each a named test in `tests/server/park-fuel.test.mjs`):

21. **Drop.** One freighter (`c.fleet.freighters = 1`); T1 script `wall`, T2 `happy`.
    - Launch T1 → `awaiting_pickup`.
    - Launch T2 with `override: true` → `audited`; its voyage is `holding` on the ship T1's voyage used, and that ship is `assigned`.
    - `dropMoon(T1)`: T1's voyage is `superseded`, T2's voyage is still `holding`, the ship is still `assigned`.
    - `rebuild` leaves `dumpProjections` byte-equal.
22. **Reply.** Two freighters; T1 `wall-twice`, T2 `happy`.
    - Launch T1 → `awaiting_pickup` on ship A.
    - Launch T2 with override → `holding` on ship A.
    - Launch T1 with override → `adrift`, on a different ship B.
    - `replyMoon(T1, note)`: both T1 voyages are `superseded`, ship B is `idle`, ship A is still `assigned`.
    - `rebuild` byte-equal.
23. **Nothing held, nothing released.** One moon, `wall`; launch → `awaiting_pickup`; `dropMoon`: the voyage is `superseded`, every ship is `idle`, and the number of `ship.released` events in the log is the same before and after the drop. `rebuild` byte-equal.
24. **A rerouted freighter carries no model.** `fake` low, `probe` ok (`probe: { adapter: "fake", pool: { kind: "window", reserve_floor: 0.1 } }`), implement order `["fake", "probe"]`. After the launch:
    - the voyage row's `model` is null;
    - the `voyage.launched` payload has neither `model` nor `refuel_for`;
    - no `voyage.event` text starts with `fake: model`;
    - in the moon's events `moon.gated` comes before `limiter.rerouted`, and `limiter.rerouted` is the event immediately before `voyage.launched`.
25. **Actions under a main-tree question.** An `awaiting_pickup` moon with a pending decision — append `decision.opened` in the moon's scope with payload `{ kind: "main_tree_changed", target_kind: "moon", target_id: "T1", reasoning: "{}" }` — has `availableActions` `["answer", "drop"]`.
26. **Refusal wording.** `dropMoon` on an `emitted` moon throws a message ending `only an adrift or quarantined moon, or one whose cargo awaits pickup, can be dropped`. `replyMoon` on an `awaiting_pickup` moon throws a message ending `only an adrift or quarantined moon can be replied to`.
27. **A held customs says until when.** Audited moon, `fake` dry: `inspectMoon` rejects with a message matching `/^moon T1 is waiting on fake fuel \(dry\), resets /` and ending with the exhaustion's `until`; `details` deep-equals `{ provider: "fake", reason: "dry", until: <that until>, can_refuel: null }`.
28. **A quarantined moon still needs a reply.** `happy` launch, inspect with `reviewScript: "review-reject"` → `quarantined`; `launchMoon` rejects matching `/quarantined.*reply/`, and again with `override: true`.

Criteria 21 and 22 fail on the round-0 tree (`'idle' !== 'assigned'`). Criteria 23–28 pass there and stay passing; they exist so the rules they name cannot regress unnoticed.

**Affected workflow IDs**: none

**Regression guard (task level — implementer runs this):**
```bash
npm test
```

## Out of Scope
- Do not add a ship-ownership check to the reducer or change `ships.release`; do not change `SUPERSEDABLE` or the transition tables.
- Do not change the carry-over refusal wording for a pickup, the CLI's refusal output, or anything in the scheduler.
- Do not strengthen or edit the round-0 tests; the new file is the only place tests are added.
- Do not update documentation. Do not fix unrelated failing tests — report them (known flake: `tests/server/follow.test.mjs` under load).

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
