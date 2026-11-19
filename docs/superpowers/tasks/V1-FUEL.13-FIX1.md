# TASK: fuel-end-to-end-fix-1

## Meta
- **Task ID**: V1-FUEL.13-FIX1
- **Parent plan**: docs/superpowers/plans/2026-11-15-v1-fuel.md
- **Depends on**: none (same worktree as V1-FUEL.13)
- **Estimated scope**: S
- **Model hint**: sol

## Objective
`npm test -- "tests/e2e/fuel.test.mjs"` passes every time, and scenarios 10, 5, 6 and 12 assert what their criteria say. Today:
1. The file fails intermittently (2 of 4 runs): scenario 2 at line 141 (`1 !== 2`) and scenario 5 at line 191 (`round3` undefined). Assertions read the SSE feed's buffer straight after a snapshot showed a state, and the buffer can be far behind (observed: snapshot `cursor` 119, feed last id 68). The same race lets "no `moon.adrift`" assertions pass without having seen the events.
2. Scenario 10 asserts "no `voyage.launched`" on the feed of the server it has just closed, so nothing from the restarted server can reach it. It stays green when dry pools never hold.
3. Scenario 5 checks "exactly one `limiter.refuelled`" only when the first appears and never asserts the FIX verdict; scenario 12 never asserts that the hit on `spare` did not park the moon; scenario 6 never asserts the moon waits on fuel.

## Context
- The feed is fed by a 20 ms poller in the same process as the server, and fake voyages have no I/O waits, so a whole chain can finish before the feed delivers anything. The database is never behind a snapshot: `x.w.g.db.all("events.since", { id: 0 }).map(rowToEvent)` returns the whole log, oldest first, in the same shape the feed delivers (`id`, `ts`, `kind`, `task_id`, `voyage_id`, `provider`, `payload`).
- Event `ts` is the real clock even when the galaxy clock is moved.
- Scenario 9 keeps its round-3 steering (`{ "T1:3": "happy" }`): amendment A1 on V1-FUEL.13 accepts it. Do not remove it.
- Every Constraint of V1-FUEL.13 still applies: server options, zero commands, `roundabout`, exact name labels, 400 ms absence waits, close + rebuild byte-equal + world close in a `finally`, under two minutes. Wording rule: a ship runs out of fuel or hits the wall, a moon waits on fuel, its cargo awaits pickup, `adrift` means only "needs a person".
- Verified on the base: in scenario 10 the restarted server is up about 1450 ms before `until`, and its snapshot shows pool `fake` `dry` with `until` equal to the appended value and T1 `waiting_on_fuel` `{ provider: "fake", reason: "dry", until }`. In scenario 12, after the hit on `spare` and before the clock moves, T1 is `awaiting_pickup`, `park_reason` null, round 2, `waiting_on_fuel` `{ provider: "fake", reason: "dry", … }`, `can_refuel` null, with no decision.

## Files
### Touch
| Path | Action | Notes |
|------|--------|-------|
| `tests/e2e/fuel.test.mjs` | modify | D1–D7 only |

### Do NOT touch
- `tests/fixtures/world.mjs`, `tests/fixtures/scripts/wall-then-spare.json` (both correct as they are), `tests/helpers.mjs`, `tests/http/helpers.mjs`, every other test and fixture.
- Anything under `src/`, `web/`, `bin/`; `package.json`, `package-lock.json`.
- Security-routed: `src/core/git.ts`, `src/validate/**`, `src/providers/claude-sdk/gate-hook.ts`, `src/server/dispatch.ts`, `src/db/migrations/**`, `src/server/http/auth.ts`, `src/server/lock.ts`. Pipeline-owned: `docs/superpowers/plans/**`, `docs/superpowers/tasks/**`, `.superpowers/sdd/**`.
- Any file not listed under Touch. If a fix seems to need one, STOP and report BLOCKED.

## Interfaces
```js
// tests/e2e/fuel.test.mjs (file-local)
import { append, rowToEvent } from "../../dist/db/events.js";
/** Log events of one kind for one task (null = any task), read from the galaxy's database — never from the feed. */
function events(x, kind, taskId = "T1")   // x.w.g.db.all("events.since", { id: 0 }).map(rowToEvent).filter(…)
```
`feed.waitFor(...)` may still be used to wait for something to arrive. Nothing is asserted from the feed: the file contains no `feed.events` and no `events(feed`.

## Constraints
- Do not weaken or delete any existing assertion; change only where it reads its events from, and add the assertions below.
- If the system does something other than what a criterion says, do not bend the test: report it (BLOCKED, or IMPLEMENTED_WITH_DEVIATIONS describing exactly what was observed).

## Acceptance
**Test command (must exit 0):**
```bash
node -e 'const s=require("fs").readFileSync("tests/e2e/fuel.test.mjs","utf8");const t=s.slice(s.indexOf("test(\"10."),s.indexOf("test(\"11."));const bad=[];if(/feed\.events/.test(s))bad.push("feed.events is still read");if(/events\(feed/.test(s))bad.push("events() still reads the feed buffer");if(!/rowToEvent/.test(s))bad.push("the log is not read with rowToEvent");if(!/voyage\.launched/.test(t)||!/\.ts\b/.test(t))bad.push("scenario 10 does not compare a voyage.launched ts with until");if(bad.length){console.error("RED: "+bad.join("; "));process.exit(1)}console.log("static check ok")' && npm test -- "tests/e2e/fuel.test.mjs" && node --disable-warning=ExperimentalWarning --test "tests/e2e/fuel.test.mjs" && node --disable-warning=ExperimentalWarning --test "tests/e2e/fuel.test.mjs"
```
(Fails now at the static check, exit 1 — confirmed by the reviewer. The three runs are the real proof: one green run is not enough.)

**Behavioral criteria:**
- **D1 (every scenario).** Every assertion about events reads the log through `events(x, …)` from the database, including the failure message at the end of done-when. All existing counts and absence checks stay.
- **D2 (scenario 10).**
  - (a) Right after the restarted server is up and `x.api` points at it, assert `Date.now() < Date.parse(untilAt)`.
  - (b) Inside the window, a snapshot from the restarted server shows pool `fake` `dry` with `until === untilAt` and T1 `waiting_on_fuel` deep-equal `{ provider: "fake", reason: "dry", until: untilAt }`.
  - (c) Until the real clock passes `untilAt`, poll the log (at least once before `untilAt`) and assert it holds no `voyage.launched`.
  - (d) After `merged`, the first `voyage.launched` in the log has `Date.parse(ts) >= Date.parse(untilAt)`.
  - The scenario must go red if a dry pool does not hold after a restart or returns early.
- **D3 (scenario 5).** After `merged`: exactly one `limiter.refuelled` for T1 in the whole log; `verdict.issued` for T1 carry verdicts `["FIX", "APPROVE"]` in order; T1's implement launches are, in order, providers `["fake", "spare", "fake"]` with rounds `[1, 2, 3]`. The existing payload, text-event and `refuel_for` assertions stay.
- **D4 (scenario 12).** After the second `fuel.exhausted` (providers `["fake", "spare"]`) and before the clock moves: wait 400 ms, then a snapshot shows T1 `awaiting_pickup`, `park_reason` null, no pending decision for T1, `waiting_on_fuel.provider` `fake` with reason `dry`, `can_refuel` null; the log has no `moon.adrift` for T1 and still exactly two `voyage.launched`.
- **D5 (scenario 6).** The waiting snapshot's moon has `waiting_on_fuel.provider` `fake` and reason `dry`, as well as `can_refuel` null.
- **D6 (wrapper).** When a scenario body throws, the test reports that error; a failure of `finish` or close in the `finally` is attached to it (for example as `cause`), not substituted. When the body passes, a rebuild mismatch still fails the test.
- **D7 (`movePast`).** Never moves a galaxy's clock backwards: the offset only grows, per world.
- Optional, same file: delete the unused `detail` helper (line 40) or use it.

**Affected workflow IDs**: none

**Regression guard (task level — implementer runs this):**
```bash
npm test
```

## Out of Scope
- No change to what any scenario's stimuli are (scripts, patches, steering), other than D2's reads.
- No `src/` change; no documentation; no new scenarios; no fixes to unrelated tests (known flake: `tests/server/follow.test.mjs` under load).

## Report Format
```
STATUS: IMPLEMENTED | IMPLEMENTED_WITH_DEVIATIONS | BLOCKED | BACKEND_FAILURE | RATE_LIMITED
FILES_CHANGED: <list with one-line summary each>
TEST_OUTPUT: <last 20 lines of the acceptance command>
DEVIATIONS: <anything done differently than specified, and why — or "none".
  IMPLEMENTED requires "none"; IMPLEMENTED_WITH_DEVIATIONS requires a
  non-empty list>
BLOCKED_REASON: <only if BLOCKED: what was needed that the spec didn't provide>
```
