# TASK: scheduler-end-to-end-scenarios — fix round 1

## Meta
- **Task ID**: V1-SCHEDULER.07-FIX1
- **Parent plan**: docs/superpowers/plans/2026-11-15-v1-scheduler.md
- **Depends on**: V1-SCHEDULER.06
- **Estimated scope**: S
- **Model hint**: sol

## Objective
Five scenarios in `tests/e2e/scheduler.test.mjs` are wrong as observable behaviour. Three "nothing was sent" scenarios can pass after a freighter was sent. The restart scenario passes or fails depending on whether an HTTP round trip beats a 20 ms timer, and does not prove that C's freighter was sent by the restarted server. The planet-dependency scenario passes even if the scheduler never sends any first freighter. After this round each of these fails when the scheduler does the wrong thing, and none depends on that timing.

## Context
This is fix round 1 of task V1-SCHEDULER.07. The round-0 work is present in this worktree: the test file, and `writeSpecs` in `tests/fixtures/world.mjs`, which is accepted and must not change. No product code changes. These facts were measured in review and are not to be relitigated:
- **The feed buffer can be behind the log.** With the fake `happy` script a moon's whole settle (freighter sent, customs inspects, freighter docks) runs without yielding to the event loop, about 0.3 s. Timers and the feed do not run meanwhile, so the buffer `readFeed` holds can lack events that are already in the log when `delay(300)` returns. A GET made after the wait is answered only once the server is free and reads the database, so it cannot be behind. With `plan` altered so `verdicts` sends first freighters, `verdicts sends no first freighter` passed its 300 ms check in 3 of 3 runs, and `a reply to a never-visited adrift moon` passed outright in 2 of 3.
- **Restart scenario.** C is assigned after the rung is raised and just before the close. If the scheduler's 20 ms poll fires in between, C is settled before the restart; the test then either fails (A finishes too) or passes while proving nothing. Assigning C before raising the rung is not enough at the default limit: the scheduler sends both freighters in one pass, C's settle blocks the loop past A's 400 ms, and the test never sees A `implementing`. With `scheduler.max_concurrent_ships: 1` and C assigned first, C stays `emitted` with no voyage until the restart, every time.
- **Planet-dependency scenario.** T1 on P1 is ready, and the scheduler settles it during the scenario, but the test asserts nothing about it. With `plan` altered to never send a first freighter the scenario still passes.
- **Known and out of scope.** In `lowering the rung mid-run starts nothing new`, A ends with a pending `main_tree_changed` decision. That is a product defect already reported to the planner. Do not assert on A's decisions in this round and do not work around it.

Wording rule for test names, messages and comments: ships move, places don't. A freighter is sent to a moon, customs inspects, the freighter docks, the moon is settled. Never "the moon launches". Affected workflow IDs is `none` because this project has no review suite.

## Files

### Touch
| Path | Action | Notes |
|------|--------|-------|
| `tests/e2e/scheduler.test.mjs` | modify | the five tests named under Acceptance, plus one shared config-patch constant |

### Do NOT touch
- `tests/fixtures/world.mjs` — `writeSpecs` is accepted as it is
- `src/**` — no product code changes of any kind. If a criterion cannot pass without one, report it under DEVIATIONS with the failing assertion.
- `tests/http/helpers.mjs`, `tests/helpers.mjs`, `tests/fixtures/specs/**`, `tests/fixtures/scripts/**`, `tests/server/**`, `tests/e2e/bridge.test.mjs`, `tests/e2e/lifecycle.test.mjs`, `web/**`
- Any file not listed under Touch. If the fix seems to need another file, STOP and report BLOCKED.

**Standing exclusions:**
- Security-routed files, never modified by this lane: `src/core/git.ts`, `src/validate/**`, `src/providers/claude-sdk/gate-hook.ts`, `src/server/dispatch.ts`, `src/db/migrations/**`, `src/server/http/auth.ts`, `src/server/lock.ts`
- Pipeline-owned paths: `docs/superpowers/plans/**`, `docs/superpowers/tasks/**`, `.superpowers/sdd/**`
- `package.json`, `package-lock.json` — no dependency changes

## Interfaces
Nothing is produced outside the test file. Consumed, exact current behaviour:

```js
// tests/http/helpers.mjs
startWorld(script, patchConfig, opts)
//   patchConfig REPLACES the default patch, so it must also set what the default sets.
//   Copy the patch of the test "caps: never more than max_concurrent_ships in flight" in
//   tests/server/scheduler-loop.test.mjs (roles, routing.security_routed, routing.do_not_touch,
//   scheduler.max_concurrent_ships = 1).

// already in tests/e2e/scheduler.test.mjs
moonDetail(x, taskId)   // GET /api/moons/<taskId> → { moon, voyages, verdicts, events, decisions, actions }
//   moon.status                     the moon's status
//   voyages: [{ role, round, status, ... }]   every voyage of the moon's current assignment; [] when no ship was ever sent
//   events:  [{ id, kind, payload, ... }]     the assignment's events in ascending id.
//     A freighter being sent is kind "voyage.launched" with payload.role === "implement".
//     The interruption written while a server closes is kind "moon.adrift".
```

## Constraints
- `roundabout settles a three-moon planet unattended` and `a REJECT holds only its own moon` stay exactly as they are. All seven test names stay.
- Keep the helper names `until`, `post`, `snapshot`, `findMoon`, `moonDetail`, `assign`, `finish`, and keep the `delay(300)` calls. The acceptance command looks for `delay(300`, `moonDetail(`, `implementing`, `.close(`, `assign`, `holding`, `voyage.launched` and `max_concurrent_ships` inside the test bodies.
- Keep every existing assertion unless a criterion below moves or replaces it. The feed assertions may stay, but they are not the proof.
- As in the original spec: HTTP only (the one exception is `parkMoonOnly` in the reply scenario), state is awaited with `until` or the feed, a fixed wait only to assert that something did not happen (300 ms), every scenario ends with the `rebuild` byte-equal check and cleans up in `finally`.
- Do not weaken a scenario to make it pass. A scenario that fails against the merged code is a finding to report under DEVIATIONS.

## Acceptance

**Test command (must exit 0; run from the repository root of the worktree):**
```bash
node -e "const t=require('fs').readFileSync('tests/e2e/scheduler.test.mjs','utf8');const body=(n)=>{const i=t.indexOf(n);if(i<0)return '';const j=t.indexOf('test(',i);return t.slice(i,j<0?t.length:j);};const after=(s)=>{const d=s.indexOf('delay(300');return d<0?'':s.slice(d);};const s3=body('verdicts sends no first freighter'),s4=body('lowering the rung mid-run starts nothing new'),s5=body('a restart resumes from the log'),s6=body('a planet with dependencies gets no first freighter'),s7=body('a reply to a never-visited adrift moon');const bad=[];const k=s5.indexOf('implementing'),c=s5.indexOf('.close(');if(k<0||c<k||s5.slice(k,c).includes('assign'))bad.push('restart: a moon is assigned between seeing A implementing and closing the server');if(!t.includes('max_concurrent_ships'))bad.push('restart: max_concurrent_ships is not capped');if(!s5.includes('voyage.launched'))bad.push('restart: nothing checks when C was sent its freighter');const d6=s6.indexOf('delay(300'),p6=s6.slice(0,d6<0?0:d6);if(!(p6.includes('T1')&&p6.includes('merged')))bad.push('planet dependencies: T1 is not awaited as merged before the 300 ms wait');const d4=s4.indexOf('delay(300');if(d4<0||s4.indexOf('holding')<d4)bad.push('lowering the rung: holding is asserted before the 300 ms wait');for(const [n,s] of [['verdicts',s3],['lowering the rung',s4],['planet dependencies',s6],['reply',s7]])if(!after(s).includes('moonDetail('))bad.push(n+': nothing-was-sent is not read with moonDetail after the 300 ms wait');if(bad.length){console.error(bad.join('; '));process.exit(1);}console.log('structure ok');" && npm test -- "tests/e2e/scheduler.test.mjs"
```
It currently exits 1 at the first step with nine complaints. The first step checks the structure of the five tests; the second runs them.

**Behavioral criteria:**
1. **`a restart resumes from the log`.**
   - The world is started with `scheduler.max_concurrent_ships: 1`.
   - C is assigned over HTTP before `config.automation` → `roundabout`.
   - Between seeing A `implementing` and `x.srv.close()` there is no command, request or wait.
   - After the restart: C reaches `merged`; A is `adrift` with exactly one pending decision.
   - The rounds of A's implement voyages are exactly `[1]`. This replaces the count of round-1 voyages.
   - C's events hold exactly one `voyage.launched` with `payload.role === "implement"`, and its `id` is greater than the `id` of A's `moon.adrift` event. That is the proof the freighter was sent by the restarted server.
2. **`a planet with dependencies gets no first freighter`.** After `config.automation` → `roundabout`, the test waits with `until` for T1 to reach `merged` with no command. Then come the 300 ms wait and the checks on D.
3. **Nothing-was-sent checks read the server after the wait.** After `delay(300)`, each of these asserts through `moonDetail`:
   - `verdicts sends no first freighter`: T1's `voyages` deep-equals `[]`.
   - `lowering the rung mid-run starts nothing new`: B's `voyages` deep-equals `[]`.
   - `a planet with dependencies gets no first freighter`: D's `voyages` deep-equals `[]`.
   - `a reply to a never-visited adrift moon`: T1's `voyages` deep-equals `[]` and `moon.status` is `adrift`.
4. **`lowering the rung mid-run starts nothing new`.** The assertion that A's implement voyage is `holding` is made after the 300 ms wait, from a `moonDetail` read made after the wait.
5. The test command passes five times in a row. Say in the report that it was run five times and what happened.

**Affected workflow IDs**: none

**Regression guard (task level — implementer runs this):**
```bash
npm test
```

## Out of Scope
- No product code, no new HTTP commands, no new fake scripts, no fixture changes.
- Do not assert on A's pending decisions in `lowering the rung mid-run starts nothing new`, and do not change that scenario's config to avoid the decision.
- Do not add a hard-kill scenario.
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
