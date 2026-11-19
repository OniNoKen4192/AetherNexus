# TASK: fuel-end-to-end

## Meta
- **Task ID**: V1-FUEL.13
- **Parent plan**: docs/superpowers/plans/2026-11-15-v1-fuel.md
- **Depends on**: V1-FUEL.12
- **Estimated scope**: L
- **Model hint**: sol

## Objective
End-to-end scenarios prove, through a running server and its scheduler, that fuel holds, the wall, pickup after a reset, refuelling and the contraband park behave as designed with nobody clicking anything.

## Context
Slice 2 of v1. Everything these scenarios exercise is already built (limiter, wall, commands, scheduler, reads); this task adds tests and test fixtures only — **no file under `src/` changes**. If a scenario cannot pass without a `src/` change, that is a finding: STOP and report BLOCKED with the scenario, what you observed and the events in the log. The scenarios run as `tests/e2e/scheduler.test.mjs` does: `startWorld` (a real server on a loopback port with the scheduler running), the level set to `roundabout` or `verdicts`, then waiting for the log and `/api/snapshot` to reach a state. Wording rule for comments and test names: a *ship* runs out of fuel or hits the wall, a moon never does; a moon *waits on fuel*; its *cargo awaits pickup*; `adrift` means only "needs a person". Affected workflow IDs is `none` because this project has no review suite.

Facts about the system that the scenarios depend on (all verified in the code at the base commit):
- **Reset floor.** When a ship hits the wall, the pool's `until` is never earlier than `g.now()` + 60 s, whatever the script's `resets_in_ms` says. Scenarios must not sleep through it: move the galaxy's clock instead — the server runs on `x.w.g`, so `x.w.g.now = () => Date.now() + offsetMs` moves the limiter's clock for the running scheduler. Event timestamps keep the real clock.
- **A dry pool clears** when the clock passes `until`, or when a voyage on that provider returns after the exhaustion. A voyage on another provider does not clear it.
- **Second hit.** A second wall hit in a row for the same role on the same provider parks the moon (`adrift`, `park_reason` `rate_limited`, one decision). Voyages on other providers in between neither trigger nor reset this.
- **Customs and rounds.** A customs voyage that hits the wall leaves the moon `audited` with its round unchanged, so a review script's `rounds` redirect never fires for the retry. To make only the *first* review of a moon hit the wall, wrap `x.w.g.adapters.fake` as `tests/e2e/scheduler.test.mjs` and `tests/e2e/bridge.test.mjs` do (prefix that one job's prompt with `FAKE-SCRIPT: review-wall`).
- **Low holds freighters only.** A low pool holds a freighter; customs flies on a low pool and is held only by a dry one.
- **Fake scripts** may redirect by provider and by round: `"providers": { "<adapter id>": "<script>" }` wins over `"rounds": { "<round>": "<script>" }`; a pickup or a FIX round flies with the moon's round + 1. A job that carries a model emits a first text event `fake: model <name>`.
- **`waiting_on_fuel` needs an idle ship.** The read reports a hold only while the held provider has an idle ship of the class and is under its cap. The default fleet has two freighters and one customs ship per fleet; do not shrink it in scenarios that assert the field.
- **Refuel-only providers have no entry in `snapshot.pools`** (only providers named in the roles do).
- **Real adapters.** The default config names `codex` and `claude` ahead of `fake`. `makeGalaxy` makes every non-fake adapter throw, so a scenario that forgets to pin the roles fails loudly instead of spending the owner's pools — but every config patch here must still set `c.roles` to fake providers only.

## Files

### Touch
| Path | Action | Notes |
|------|--------|-------|
| `tests/e2e/fuel.test.mjs` | create | all scenarios |
| `tests/fixtures/world.mjs` | modify | add `fuelPatch`; every existing export unchanged |
| `tests/fixtures/scripts/wall-then-spare.json` | create | see Interfaces |

### Do NOT touch
- Anything under `src/`, `web/`, `bin/`.
- `tests/helpers.mjs`, `tests/http/helpers.mjs`, every existing test file and every existing fixture script — import from them, never edit them.
- Any file not listed under Touch. If completing the objective seems to require touching an unlisted file (for example another fixture script), STOP and report BLOCKED.

**Standing exclusions:**
- Security-routed files, never modified by this lane: `src/core/git.ts`, `src/validate/**`, `src/providers/claude-sdk/gate-hook.ts`, `src/server/dispatch.ts`, `src/db/migrations/**`, `src/server/http/auth.ts`, `src/server/lock.ts`
- Pipeline-owned paths: `docs/superpowers/plans/**`, `docs/superpowers/tasks/**`, `.superpowers/sdd/**`
- `package.json`, `package-lock.json` — no dependency changes

## Interfaces

Produced:

```js
// tests/fixtures/world.mjs
/**
 * A config patch for fuel scenarios: providers `fake` (pool window, reserve_floor 0.1) and `spare`
 * (adapter "fake", pool window, reserve_floor 0.25); roles implement ["fake"], review ["fake"];
 * routing.security_routed ["src/auth.ts"], routing.do_not_touch [".env"]. `extra(c)` runs last.
 * With `refuel: { min_wait_minutes }` it also sets
 *   c.providers.fake.pool.refuel = { provider: "spare", models: { <the fixture spec's tier>: "m-cheap" }, min_wait_minutes }.
 */
export function fuelPatch(opts = {}, extra) // → (config) => void, for startWorld(script, fuelPatch(...), { server })
```

```json
// tests/fixtures/scripts/wall-then-spare.json — on `fake` in round 1 the ship hits the wall with a reset an hour away;
// on `spare` the run is happy; from round 3 on, `fake` is happy too.
{ "name": "wall-then-spare", "role": "implement", "steps": [
  { "text": "Starting work." },
  { "error": { "classification": "rate_limited", "message": "usage limit reached", "resets_in_ms": 3600000 } }
], "providers": { "spare": "happy" }, "rounds": { "3": "happy" } }
```

Consumed (exact current code):

```js
// tests/http/helpers.mjs
export async function startWorld(script, patchConfig, opts = {})   // → { w, srv, webRoot, origin, api, close }; opts.server = { pollMs, schedulerTickMs }
export function readFeed(srv, { since, lastEventId } = {})
// tests/fixtures/world.mjs
export function writeSpecs(w, entries)   // entries: { id, deps?, scripts? } → repo-relative spec paths; each script is a FAKE-SCRIPT comment
// tests/e2e/scheduler.test.mjs — patterns to copy (not import): until(), post(), snapshot(), findMoon(), moonDetail(), assign(), finish()
// dist: append, rowToEvent (db/events.js); dumpProjections, rebuild (db/rebuild.js); startServer (server/http/server.js)
// Existing scripts: happy, wall (round 2 → happy), wall-twice (always the wall), review-wall, review-fix, review-approve, fix-round
// Events: fuel.reading { window, used, resets_at?, source } and fuel.exhausted { until, voyage_id } carry the provider in the envelope;
//   limiter.held { task_id, role, provider, reason, until? }; limiter.refuelled { task_id, from, to, model, reason };
//   voyage.launched payload { role, round, provider, model?, refuel_for?, … }; scheduler.acted { action, task_id, rung }
// GET /api/snapshot: pools[], systems[].planets[].moons[] with waiting_on_fuel / can_refuel / park_reason / status / round,
//   voyages[] with refuel_for, decisions[]; GET /api/moons/<taskId>
```

## Constraints
- Server options for every scenario: `{ pollMs: 20, schedulerTickMs: 100 }`.
- "Zero commands": after the specs are assigned and the level is set, the scenario sends no command over HTTP and calls no command function, unless the scenario says otherwise. Appending `fuel.reading` / `fuel.exhausted` events, moving the clock, wrapping the fake adapter and writing a file into a worktree are stimuli, not commands.
- Level `roundabout` unless stated. Each scenario asserts on the event log **and** on `/api/snapshot` (and `/api/moons/<id>` where it names the detail).
- Every scenario ends with the server closed and `rebuild` leaving `dumpProjections` byte-equal (the `finish` pattern), in a `finally` that also closes the world.
- "No freighter is sent" style assertions wait at least 400 ms (four ticks) before asserting absence.
- Each test's name starts with its scenario label exactly as below (`1.`, `2.`, … `14.`, `focus:`, `done-when:`). Scenario 8 does not exist (the design dropped it); keep the numbering.
- No new dependencies. Tests import from `dist/` and the helpers above. The whole file should finish in under two minutes.

## Acceptance

**Test command (must exit 0):**
```bash
npm test -- "tests/e2e/fuel.test.mjs"
```

**Behavioral criteria** (each a named test):
1. **A low pool holds, a recovered pool sends.** A `fuel.reading` of 0.95 for `fake` (reset an hour ahead): no `voyage.launched`; exactly one `limiter.held` for the moon; the snapshot's moon has `waiting_on_fuel` `{ provider: "fake", reason: "low", until }` and the `fake` pool's `state` is `low`. Appending a reading of 0.2 sends the freighter and the moon is `merged`; `waiting_on_fuel` is `null`.
2. **The wall, then pickup.** Script `wall`: one `fuel.exhausted`; the moon `awaiting_pickup`; the voyage `out_of_fuel`; no decision pending and no `moon.adrift` / `voyage.adrift` event; every ship `idle`; the snapshot's `fake` pool is `dry` and the moon's `waiting_on_fuel.reason` is `dry`. After the clock passes `until`: a second freighter is sent, the moon is `merged`, its round is 2.
3. **A second hit needs a person.** Script `wall-twice`, the clock moved past the first `until`: after the second hit the moon is `adrift` with `park_reason` `rate_limited`, exactly one decision is pending, and after a further 400 ms with the clock moved past the second `until` nothing more is launched and no `scheduler_refused` park exists.
4. **Customs hits the wall.** `happy` freighter, first review steered into `review-wall`: the moon is back to `audited`, the customs voyage `out_of_fuel`, the customs ship `idle`, no decision. After the clock passes `until`, customs is sent again, the moon is `merged`, and its round is 1.
5. **Refuel.** `fuelPatch({ refuel: { min_wait_minutes: 0 } })`, script `wall-then-spare`, the first review after the refuelled round steered into `review-fix`:
   - the second freighter flies on `spare` with model `m-cheap` (its `voyage.launched` payload has `provider` `spare`, `model` `m-cheap`, `refuel_for` `fake`; a `fake: model m-cheap` text event exists);
   - exactly one `limiter.refuelled` with `{ from: "fake", to: "spare", model: "m-cheap" }` for the moon;
   - in the snapshot, that voyage has `refuel_for` `"fake"` and **every other voyage of the moon — the first freighter and the customs voyages — has `refuel_for` `null`**;
   - with the clock moved past `fake`'s `until`, customs returns FIX and the next freighter (round 3) flies on `fake` with no model and no `refuel_for`; the moon ends `merged`.
6. **Not worth refuelling.** As 5 but `min_wait_minutes: 30` and script `wall` (its reset is floored to a minute): no `limiter.refuelled`, no voyage on `spare`; the moon waits with `can_refuel` `null`; after the clock passes `until` it is `merged` on `fake`.
7. **The refuel pool is low.** As 5 with a `fuel.reading` of 0.9 for `spare`: no `limiter.refuelled`, no voyage on `spare`; the moon is `awaiting_pickup` with `waiting_on_fuel.reason` `dry` and `can_refuel` `null`.
9. **A wall hit is not a fix round.** `c.automation.max_fix_rounds = 2`; script `wall`; reviews steered FIX, then APPROVE (second review): the moon is `merged`, and no `moon.adrift` event carries reason `max_fix_rounds`.
10. **Restart while dry.** A `fuel.exhausted` for `fake` appended with `until` 1.5 s ahead (real clock, no clock move); the server is closed and started again on the same galaxy (as `tests/e2e/scheduler.test.mjs` restarts it) inside that window: no `voyage.launched` exists while `Date.now()` is before `until`; the moon is `merged` afterwards.
11. **No pool block.** `fake` without a `pool` block, script `wall`: the pool reads `dry` in the snapshot with `kind` `free`; no second freighter is launched in 400 ms; after the clock passes `until` it is, and the moon is `merged`.
12. **The third hit.** Refuel declared (`min_wait_minutes: 0`), script `wall-twice`: the ship on `fake` hits the wall, the refuelled ship on `spare` hits the wall, and — with the clock moved past both `until`s — the next ship on `fake` hits the wall and the moon is parked `rate_limited` on that third hit (three `fuel.exhausted`, one decision). The hit on `spare` did not park it.
13. **Customs ships come back.** Three moons, each `happy` with its first review steered into `review-wall`, the clock moved past each `until` as needed: all three end `merged`, never `adrift`; after every customs wall hit and at the end every customs ship in the fleet is `idle`.
14. **Contraband in the cargo.** Script `wall`; once the moon is `awaiting_pickup`, write a file outside `src/**` into the moon's worktree and move the clock past `until`: the scheduler sends the pickup, the moon is `adrift` with `park_reason` `carryover_violations`, exactly one decision is pending and its `reasoning` starts with `contraband in the cargo awaiting pickup`; no park with reason `scheduler_refused` exists; nothing further is launched in 400 ms; the snapshot's moon has `waiting_on_fuel` `null`.
- **focus: two ships at the wall.** Two moons, both `wall`, `c.scheduler.max_concurrent_ships = 2`: both `awaiting_pickup`; after the clock passes the later `until` both are `merged`; neither was ever `adrift`.
- **done-when: three moons, nobody clicks.** Refuel declared (`min_wait_minutes: 0`); moons `happy`, `wall` and `wall-then-spare`; the clock is moved only when nothing is in flight and at least one moon waits on fuel: all three end `merged` with zero commands, at least one `limiter.refuelled` exists, and no moon was ever `adrift`.

**Affected workflow IDs**: none

**Regression guard (task level — implementer runs this):**
```bash
npm test
```

## Out of Scope
- Do not change anything under `src/` to make a scenario pass — report it.
- Do not weaken a scenario to make it pass: if the system does something else, report what it does (BLOCKED, or IMPLEMENTED_WITH_DEVIATIONS with the scenario left failing-as-written described precisely).
- Do not add page or browser tests (V1-FUEL.14, .15, .17).
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
- **Original sha256**: 5e2b68ac87db2746eadf5d7ca2be4ceb38ea0d310084ee078842d91cdd99a460
- **Verdict ref**: FIX (review of round 0), task V1-FUEL.13, lanes-reviewer
- **Deviation**: Scenario 9 adds a stimulus the criterion did not name: the fake adapter wrapper prefixes the moon's round-3 implement job with `FAKE-SCRIPT: happy`, so the FIX-round freighter does not hit the wall.
- **Reason accepted**: script `wall` redirects only round 2 to `happy`. As written, the FIX round (round 3) flies `wall` again: the ship hits the wall and the cargo awaits pickup (not parked — the previous freighter on `fake` returned normally), and the round-4 pickup is a second hit in a row, so the moon is parked `rate_limited`. The reviewer observed both; both are the designed behaviour, so the scenario as written cannot reach `merged`. Wrapping the fake adapter is a stimulus under the Constraints. The scenario still goes red when a wall hit is counted as a fix round (mutant: park when `moon.round >= max_fix_rounds`).
- **Affected paths**: tests/e2e/fuel.test.mjs
- **Acceptance criteria**: criterion 9 becomes: "**A wall hit is not a fix round.** `c.automation.max_fix_rounds = 2`; script `wall`; reviews steered FIX, then APPROVE (second review); the round-3 freighter (the FIX round) steered onto `happy` through the fake adapter wrapper: the moon is `merged`, and no `moon.adrift` event carries reason `max_fix_rounds`."

### A2 — 2026-11-18 — accepted deviation
- **Original sha256**: 5e2b68ac87db2746eadf5d7ca2be4ceb38ea0d310084ee078842d91cdd99a460
- **Verdict ref**: APPROVE (review of fix round 1), task V1-FUEL.13 / V1-FUEL.13-FIX1, lanes-reviewer
- **Deviation**: the Constraint "in a `finally` that also closes the world" is met without a literal `finally`: the wrapper catches the body's error, runs feed close, `finish` (server close plus rebuild byte-equal) and world close as three unconditional steps, then rethrows the body's error with any cleanup failure as its `cause`.
- **Reason accepted**: see A1 on V1-FUEL.13-FIX1; verified by failure injection.
- **Affected paths**: tests/e2e/fuel.test.mjs
- **Acceptance criteria**: the Constraint becomes: "Every scenario ends with the server closed, `rebuild` leaving `dumpProjections` byte-equal, and the world closed, each step run unconditionally; a body failure is reported as itself."
