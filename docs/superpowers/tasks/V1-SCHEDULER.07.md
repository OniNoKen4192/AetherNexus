# TASK: scheduler-end-to-end-scenarios

## Meta
- **Task ID**: V1-SCHEDULER.07
- **Parent plan**: docs/superpowers/plans/2026-11-15-v1-scheduler.md
- **Depends on**: V1-SCHEDULER.06
- **Estimated scope**: M
- **Model hint**: sol

## Objective
Seven end-to-end scenarios, driven over HTTP against a real `nexus serve` instance with the fake provider, prove that the scheduler settles a planet's moons by itself as far as the trust rung allows, respects dependencies, holds only the moon that needs a human, and resumes after a restart.

## Context
The scheduler (a loop inside the server, merged in task V1-SCHEDULER.06) sends freighters to moons, has customs inspect them and docks them, according to the trust rung: `manual` does nothing, `verdicts` does everything after a human sent the first freighter, `roundabout` also sends the first freighter to every ready moon. This task adds no product code. Its tests are the release's done-when, so they are expected to **pass** against the merged code: a scenario that fails is a finding to report under DEVIATIONS (with the failing assertion and what the log showed), never something to work around by loosening the test. One fixture helper is added so scenarios can lay out several specs briefly. Wording rule for test names and comments: places don't move, ships do — a freighter is *sent to* a moon, customs *inspects*, the freighter *docks*, the moon is *settled* (status `merged`); never "the moon launches". Affected workflow IDs is `none` because this project has no review suite.

## Files

### Touch
| Path | Action | Notes |
|------|--------|-------|
| `tests/e2e/scheduler.test.mjs` | create | the seven scenarios |
| `tests/fixtures/world.mjs` | modify | add the exported `writeSpecs`; change nothing existing |

### Do NOT touch
- `src/**` — no product code changes of any kind. If a scenario cannot pass without one, report it.
- `tests/http/helpers.mjs`, `tests/helpers.mjs`, `tests/fixtures/specs/**`, `tests/fixtures/scripts/**` — use them as they are
- `tests/e2e/bridge.test.mjs`, `tests/e2e/lifecycle.test.mjs`, `tests/server/**` — existing tests
- `web/**` — owned by tasks V1-SCHEDULER.08 and .09
- Any file not listed under Touch. If completing the objective seems to require touching an unlisted file, STOP and report BLOCKED.

**Standing exclusions:**
- Security-routed files, never modified by this lane: `src/core/git.ts`, `src/validate/**`, `src/providers/claude-sdk/gate-hook.ts`, `src/server/dispatch.ts`, `src/db/migrations/**`, `src/server/http/auth.ts`, `src/server/lock.ts`
- Pipeline-owned paths: `docs/superpowers/plans/**`, `docs/superpowers/tasks/**`, `.superpowers/sdd/**`
- `package.json`, `package-lock.json` — no dependency changes

## Interfaces

Produced:

```js
// tests/fixtures/world.mjs
/**
 * Write and commit one spec per entry into the galaxy's repo and return their repo-relative paths, in order.
 * deps: task ids for the spec's "Depends on" line; scripts: FAKE-SCRIPT names, each written as its own
 * `<!-- FAKE-SCRIPT: name -->` comment (an implement script and optionally a review-* script).
 * Each spec gets its own Touch paths (e.g. src/lib/<id>.js and its test) so moons do not collide.
 */
export function writeSpecs(w, entries /* [{ id, deps?: string[], scripts?: string[] }] */) // → string[]
```

Consumed (exact current behaviour; do not change it):

```js
// tests/http/helpers.mjs
export async function startWorld(script, patchConfig, opts = {})   // → { w, srv, webRoot, origin, api, close }
//   w: { g, dir, git, cleanup, systemId, planetId, moonId }  — a galaxy with one system, planet P1 and one assigned moon T1 (script = T1's implement script)
//   opts.server is spread into startServer's options: pass { server: { pollMs: 20, schedulerTickMs: 200 } } to make the scheduler quick in tests
//   api(path, { method, body, headers }) — authenticated request; see tests/http/commands.test.mjs for the response shape
export function readFeed(srv, { since, lastEventId } = {})         // → { events, waitFor(nOrPredicate, ms), close(), ... }
// tests/helpers.mjs:  makeGalaxy(patchConfig), writeSpec(dir, taskId, body?), read(relPath)
// dist/server/http/server.js:  startServer(g, { port: 0, webRoot, pollMs, schedulerTickMs }) → { port, token, url, close() }
// dist/server/commands/park.js: parkMoonOnly(g, { taskId, reason, details })
// dist/db/rebuild.js: rebuild(db);  the projection dump helper the other e2e tests use (search tests for dumpProjections)
```

```text
HTTP commands (POST /api/commands/<name>, JSON body):
  planet.assign     { systemId, streamId, mission, territory: string[], dependsOn?: string[] }  → 200 { result: { planetId, ... } }
  moon.assign       { planetId, specPath }                                                      → 200 { result: { moonId, taskId, ... } }
  moon.launch       { taskId }                                                                  → 202 { voyageId }
  moon.reply        { taskId, note }                                                            → 200
  config.automation { level: "manual" | "verdicts" | "roundabout" }                             → 200 { result: { level, from, changed } }
GET /api/snapshot → { rung, ready_to_send, systems: [{ planets: [{ moons: [{ task_id, status, waiting_on, waiting_on_planets, ... }] }] }], voyages, decisions, failures, ... }
GET /api/moons/<taskId> → { moon, voyages, verdicts, events, decisions, actions }
```

Fake provider (see `pick` in `src/providers/fake/index.ts`): the implement script is the first `FAKE-SCRIPT:` name in the prompt, default `happy`; the review script is the first name starting with `review-`, default `review-approve`. Scripts available: `happy`, `slow` (about 400 ms), `fix-round`, `review-approve`, `review-fix`, `review-reject` (`tests/fixtures/scripts/`). A spec comment `<!-- FAKE-SCRIPT: review-reject -->` therefore steers that moon's review. "Exactly one FIX round" needs the adapter wrapped so that only the first review of that spec is prefixed with `FAKE-SCRIPT: review-fix`: use the pattern already in `tests/e2e/bridge.test.mjs`.

## Constraints
- Every scenario drives the server over HTTP only (the single exception is named in scenario 7), waits on state with a bounded polling helper local to the file (`until(fn, ms = 10000)`) or on the feed — never a fixed sleep as the pass condition. A fixed wait is allowed only to assert that something did **not** happen (300 ms).
- Every scenario ends by asserting that `rebuild` leaves the projection dump byte-equal, and closes the server and cleans up in `finally`.
- `startWorld` already assigns a moon `T1`; either use it as one of the scenario's moons or build the scenario's planet beside it — but no moon may be left that the scheduler could act on outside what the scenario asserts.
- No changes under `src/`. No new dependencies. Tests use `node:test` and `node:assert/strict`.

## Acceptance

**Test command (must exit 0):**
```bash
npm test -- "tests/e2e/scheduler.test.mjs"
```

**Behavioral criteria** (one test each in `tests/e2e/scheduler.test.mjs`, named as given):
1. `roundabout settles a three-moon planet unattended` — moons A, B depending on A, C independent, exactly one FIX round on A. Assign all three, then `config.automation` → `roundabout`. All three reach `merged` with no further command. In the event log the implement `voyage.launched` for B has a higher id than the `voyage.docked` for A. A has two implement voyages (rounds 1 and 2).
2. `a REJECT holds only its own moon` — same layout, C scripted `review-reject`, no FIX round needed. C ends `quarantined` with one pending decision of kind `reject`; A and B end `merged`.
3. `verdicts sends no first freighter` — at `verdicts`, 300 ms after assign no `voyage.launched` event exists; after `moon.launch` for A, A reaches `merged` with no further command.
4. `lowering the rung mid-run starts nothing new` — at `roundabout` with the `slow` script on A and B depending on A: as soon as A is `implementing`, set `manual`. A's freighter ends `holding`, A stays `audited`, and B gets no voyage (checked 300 ms after A is `audited`).
5. `a restart resumes from the log` — at `roundabout`, A `slow`, C independent. As soon as A is `implementing`, close the server (`srv.close()`, which interrupts the voyage) and start a new one on the same galaxy with `startServer`. C reaches `merged`. A is `adrift` with a pending decision. A has exactly one implement voyage for round 1.
6. `a planet with dependencies gets no first freighter` — a second planet assigned with `dependsOn: ["P1"]` and one moon D: at `roundabout` D gets no voyage (300 ms) and the snapshot shows `waiting_on_planets: ["P1"]` on D; after a manual `moon.launch` for D, D reaches `merged` unattended.
7. `a reply to a never-visited adrift moon` — put an emitted moon adrift with `parkMoonOnly(x.w.g, { taskId, reason: "test_hold", details: "held for the test" })` on the galaxy object (the one step in this file that is not HTTP). At `verdicts`, `moon.reply` sends nothing (300 ms, no `voyage.launched`); after `config.automation` → `roundabout` a freighter is sent and the moon reaches `merged`.

The acceptance command must also pass five times in a row; say in the report that it was run five times and what happened.

**Affected workflow IDs**: none

**Regression guard (task level — implementer runs this):**
```bash
npm test
```

## Out of Scope
- No product code, no new HTTP commands, no new fake scripts.
- Do not weaken a scenario to make it pass; report the failure instead.
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

## Amendments

### A1 — 2026-11-15 — planner correction before dispatch
- **Corrects**: the `writeSpecs` doc comment under Interfaces ("Each spec gets its own Touch paths (e.g. src/lib/<id>.js and its test) so moons do not collide").
- **Correction**: every spec written by `writeSpecs` keeps the Touch list of `tests/fixtures/specs/good-basic.md` unchanged (`src/lib/thing.js`, `src/lib/thing.test.js`). The fake scripts write exactly those two paths, so a spec with any other Touch list is parked by the audit as out of scope. Build each spec body from `good-basic.md` the way `worldWithTwoMoons` in `tests/fixtures/world.mjs` does (Task ID replaced by `writeSpec`, the `Depends on` line replaced with the entry's deps or `none`, one `<!-- FAKE-SCRIPT: name -->` comment per script).
- **Why this is safe**: several moons on one planet writing the same content to the same files all settle; `tests/server/scheduler-loop.test.mjs` ("caps: never more than max_concurrent_ships in flight") does this with three moons.
- **Acceptance criteria**: unchanged.

### A2 — 2026-11-15 — accepted deviation
- **Original sha256**: f94bbdc386eae6887905e8db5dad5357eef181add56e6986d7918954cd3e34e6
- **Verdict ref**: FIX verdict, task V1-SCHEDULER.07, round 0, lanes-reviewer
- **Deviation**: the doc comment on `writeSpecs` in `tests/fixtures/world.mjs` is shorter than the text under Interfaces. It omits the note "(an implement script and optionally a review-* script)" and the sentence about each spec getting its own Touch paths.
- **Reason accepted**: the omitted Touch sentence is the one A1 corrected. The signature, behaviour and return value match Interfaces and A1, and the remaining comment is accurate.
- **Affected paths**: tests/fixtures/world.mjs
- **Acceptance criteria**: unchanged

### A3 — 2026-11-15 — accepted deviation
- **Original sha256**: f94bbdc386eae6887905e8db5dad5357eef181add56e6986d7918954cd3e34e6 (delta spec V1-SCHEDULER.07-FIX1: a1401ffc0f2b44bc7af5f21ee90c1f007db58f86d2617d8799275509695ddc4d)
- **Verdict ref**: lanes-reviewer, V1-SCHEDULER.07 fix round 1 (V1-SCHEDULER.07-FIX1), APPROVE
- **Deviation**: in `a reply to a never-visited adrift moon`, one line the delta spec did not name was added before the existing final feed assertion: `await feed.waitFor(...)` for T1's `voyage.launched`.
- **Reason accepted**: the snapshot can show `merged` before the feed buffer holds the event, so the existing assertion failed intermittently on correct code (reproduced by the reviewer: 1 of 12 isolated runs without the line; 0 of 13 with it). The wait is bounded at 5 s and fails if the event never arrives, so the scenario is not weakened.
- **Affected paths**: `tests/e2e/scheduler.test.mjs`
- **Acceptance criteria**: unchanged

### A4 — 2026-11-15 — accepted deviation
- **Original sha256**: f94bbdc386eae6887905e8db5dad5357eef181add56e6986d7918954cd3e34e6 (delta spec V1-SCHEDULER.07-FIX1: a1401ffc0f2b44bc7af5f21ee90c1f007db58f86d2617d8799275509695ddc4d)
- **Verdict ref**: lanes-reviewer, V1-SCHEDULER.07 fix round 1 (V1-SCHEDULER.07-FIX1), APPROVE
- **Deviation**: the delegate backend's first `npm test` had one failing test whose name was lost to truncated output (443 tests, 440 pass, 1 fail, 2 skipped). Its rerun and the implementer's two runs were clean.
- **Reason accepted**: not reproduced in review: 8 sequential full-suite runs with 0 failures, and 10 isolated runs of `tests/server/scheduler-loop.test.mjs` with 0 failures. The likeliest cause (inference) is the feed race recorded in A3, if that run predates the added wait. No test is known to be flaky after this round.
- **Affected paths**: none
- **Acceptance criteria**: unchanged
