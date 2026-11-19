# TASK: fuel-wall-event-clock-and-missing-tests

## Meta
- **Task ID**: V1-FUEL.07-FIX1
- **Parent plan**: docs/superpowers/plans/2026-11-15-v1-fuel.md
- **Depends on**: V1-FUEL.07 (round 0, in the same worktree)
- **Estimated scope**: S
- **Model hint**: sol

## Objective
Two things are wrong on the round-0 tree:
1. `endOutOfFuel` stamps the events it appends with a timestamp taken from `g.now()` instead of leaving it to `append`. Whenever `g.now()` is not the wall clock: a voyage on the provider that returns after the wall hit does not clear the exhaustion (the pool stays `dry`); a holding voyage's own earlier return clears the exhaustion it has just caused (the pool does not read `dry`); and on a second hit `fuel.exhausted` sits on one clock while the four park events after it sit on another.
2. Nine tests are missing. Criterion 9's second sub-case has no first hit, and four rules can be broken without any test failing: taking the newest reading instead of the earliest, letting readings win over `resetsAt`, ignoring the role in the second-hit check, and treating any earlier out-of-fuel voyage (not the most recent one) as a second hit.

## Context
The round-0 code passed review on everything else; the reviewer ran the untested sequences by hand and they behave as specified, so tests 5 to 9 below are expected to pass against the current code and tests 1 to 4 only after the source change. Why `append`'s clock: `poolState` clears an exhaustion by comparing the `fuel.exhausted` event's `ts` with `voyages.returned_ts`, and that column is always stamped by `append`'s default clock. The spec line "Time is `g.now()`, never `Date.now()`" governs how `until` is computed and nothing else. `until` stays on `g.now()`. (`recordReading` in `pool.ts` stamps `fuel.reading` from `g.now()` on purpose; that event is compared with `g.now()`, this one is not. Do not copy it and do not change it.) Do not relitigate anything else in V1-FUEL.07. Wording rule for comments and test names: a *ship* runs out of fuel or hits the wall; a moon never does; the moon's *cargo awaits pickup*. Affected workflow IDs is `none` because this project has no review suite.

## Files

### Touch
| Path | Action | Notes |
|------|--------|-------|
| `tests/server/limiter-wall.test.mjs` | modify | add the nine tests under Acceptance |
| `src/server/limiter/wall.ts` | modify | only: delete the `ts` constant and the `ts` property from the four `append` calls |

### Do NOT touch
- `src/server/dispatch.ts` — security-routed; import from it, never edit it
- `src/server/limiter/pool.ts`, `src/server/limiter/limiter.ts` — owned by V1-FUEL.06
- `src/db/events.ts`, `src/db/statements.ts`, `src/db/reducers/**`, `src/core/transitions.ts`
- `src/server/commands/**`, `src/server/scheduler/**`, `src/server/http/**`
- `tests/helpers.mjs`, `tests/fixtures/**`, every other test file — use them as they are
- Any file not listed under Touch. If the fix seems to need one, STOP and report BLOCKED.

**Standing exclusions:**
- Security-routed files, never modified by this lane: `src/core/git.ts`, `src/validate/**`, `src/providers/claude-sdk/gate-hook.ts`, `src/server/dispatch.ts`, `src/db/migrations/**`, `src/server/http/auth.ts`, `src/server/lock.ts`
- Pipeline-owned paths: `docs/superpowers/plans/**`, `docs/superpowers/tasks/**`, `.superpowers/sdd/**`
- `package.json`, `package-lock.json` — no dependency changes

## Interfaces
No signature or type change. One behaviour change:

```ts
// src/server/limiter/wall.ts — endOutOfFuel
// None of the events this function appends (fuel.exhausted, voyage.out_of_fuel, ship.released,
// moon.awaiting_pickup / moon.review_abandoned) passes `ts`: each takes append's default timestamp,
// exactly as parkVoyage's events do. `until` is computed as before, from p.resetsAt, the readings and g.now().
```

Pool fixture for tests 3 and 4 (verified by the reviewer against the round-0 build): the file's `world()` returns a bare galaxy `{ db, now }`. `poolState` also reads `g.config.providers[provider]?.pool`, so set
`w.g.config = { providers: { fake: { pool: { kind: "window", reserve_floor: 0.1 } } } };`
and import `poolState` from `../../dist/server/limiter/pool.js`. With no readings and no live exhaustion that pool reads `{ state: "unknown" }`.

## Constraints
- Each test under Acceptance is written as `test("<title>", ...)` with the exact title given and double quotes; the third command looks for that text.
- The nine existing tests stay. No existing `assert.*` line is changed or removed.
- Every world a new test builds ends with the file's `finish(w)` helper.
- Expected values are the test's own constants, never values returned by the code under test (compare `until` with `new Date(fixed + 30 * 60_000).toISOString()`, not with the returned `until`).
- Clock tests (1 to 4): `g.now` is a fixed value computed once, `const fixed = Date.now() + offset; w.g.now = () => fixed;`. "Stamped by append" means: read `t0 = Date.now()` immediately before the call and `t1 = Date.now()` immediately after, and assert `t0 <= Date.parse(event.ts) <= t1`. No timers and no sleeping: where a return must be later or earlier than the hit, give that `voyage.returned` event an explicit `ts` one second after or before the wall clock.
- Build states as the file already does (its `world`, `gate`, `launch`, `hit`, `nextAfter`, `events` helpers and direct `append` calls); ship, voyage and moon rows must be real.
- `src/server/limiter/wall.ts` must not contain `Date.now` or `new Date()`; the third command checks.
- No new dependencies. Tests import from `dist/`.

## Acceptance

**Test commands (all three must exit 0; run from the repo root in this order — the second reads the `dist/` built by the first):**
```bash
npm test -- "tests/server/limiter-wall.test.mjs"
```
```bash
node --disable-warning=ExperimentalWarning --input-type=module -e "import {openDb} from './dist/db/open.js';import {append,rowToEvent} from './dist/db/events.js';import {endOutOfFuel} from './dist/server/limiter/wall.js';import {poolState} from './dist/server/limiter/pool.js';import {tmpDb} from './tests/helpers.mjs';import {seedSystem,seedFleet} from './tests/fixtures/world.mjs';const DAY=86400000,iso=(ms)=>new Date(ms).toISOString(),J=JSON.stringify;let bad=0;const want=(label,got,exp)=>{const ok=J(got)===J(exp);if(!ok)bad++;console.log((ok?'ok   ':'FAIL ')+label+': '+J(got)+(ok?'':' (want '+J(exp)+')'));};function world(offset){const db=openDb(tmpDb());const gen=seedSystem(db);seedFleet(db,['fake']);const system='S-20261013-demo',planet=system+'/'+gen.planets[0].name,moon=planet+'/'+gen.planets[0].moons[0].name;append(db,{kind:'planet.assigned',system_id:system,planet_id:planet,payload:{stream_id:'P1',mission:'m',territory:['src/**'],depends_on:[],branch:'b',worktree:'w'}});append(db,{kind:'moon.assigned',system_id:system,planet_id:planet,moon_id:moon,payload:{task_id:'T1',spec_path:'s',spec_sha:'abc',touch:['src/x.ts'],depends_on:[],tier:'terra'}});const base={system_id:system,planet_id:planet,moon_id:moon,task_id:'T1',assignment_id:db.get('moons.byId',{id:moon}).assignment_id};const fixed=Date.now()+offset;return {db,base,n:0,fixed,g:{db,now:()=>fixed,config:{providers:{fake:{pool:{kind:'window',reserve_floor:0.1}}}}}};}const gate=(w)=>append(w.db,{kind:'moon.gated',...w.base,payload:{base_sha:'0'.repeat(40),state_path:'p',round:1}});function launch(w,ts){const ship=w.db.get('ships.pickIdle',{class:'freighter',fleet:'fake'});w.n+=1;const voyageId=ship.id+'/T1/implement/1#'+w.n;append(w.db,{kind:'voyage.launched',...w.base,...(ts?{ts}:{}),voyage_id:voyageId,ship_id:ship.id,provider:'fake',payload:{role:'implement',round:1,provider:'fake',ship_id:ship.id,worktree:'w'}});return {voyageId,shipId:ship.id};}const ret=(w,v,ts)=>append(w.db,{kind:'voyage.returned',...w.base,ts,voyage_id:v.voyageId,payload:{role:'implement',report:{}}});const hit=(w,v)=>endOutOfFuel(w.g,{taskId:'T1',role:'implement',provider:'fake',details:'d',...v});const tail=(w,n)=>w.db.all('events.byAssignment',{assignment_id:w.base.assignment_id}).map(rowToEvent).slice(-n);const clock=(e,t0,t1)=>{const t=Date.parse(e.ts);return e.kind+(t>=t0&&t<=t1?' on the clock of append':' NOT on the clock of append');};{const w=world(DAY);gate(w);const v=launch(w);const t0=Date.now();const r=hit(w,v);const t1=Date.now();want('g.now() a day ahead, first hit: until',r.until,iso(w.fixed+1800000));want('g.now() a day ahead, first hit: event clocks',tail(w,4).map((e)=>clock(e,t0,t1)),['fuel.exhausted','voyage.out_of_fuel','ship.released','moon.awaiting_pickup'].map((k)=>k+' on the clock of append'));want('g.now() a day ahead: pool right after the hit',poolState(w.g,'fake'),{state:'dry',until:r.until});append(w.db,{kind:'voyage.superseded',...w.base,voyage_id:v.voyageId,payload:{}});gate(w);const v2=launch(w);ret(w,v2,iso(Date.now()+1000));want('g.now() a day ahead: pool after a voyage on the provider returned one second after the hit',poolState(w.g,'fake'),{state:'unknown'});w.db.close();}{const w=world(DAY);gate(w);const v=launch(w);hit(w,v);append(w.db,{kind:'voyage.superseded',...w.base,voyage_id:v.voyageId,payload:{}});gate(w);const v2=launch(w);const t0=Date.now();const r=hit(w,v2);const t1=Date.now();want('g.now() a day ahead, second hit: parked',r.parked,true);want('g.now() a day ahead, second hit: event clocks',tail(w,5).map((e)=>clock(e,t0,t1)),['fuel.exhausted','voyage.adrift','ship.adrift','moon.adrift','decision.opened'].map((k)=>k+' on the clock of append'));w.db.close();}{const w=world(-DAY);gate(w);const v=launch(w,iso(Date.now()-2000));ret(w,v,iso(Date.now()-1000));append(w.db,{kind:'voyage.audited',...w.base,voyage_id:v.voyageId,payload:{audit:{}}});const r=hit(w,v);want('g.now() a day behind: pool right after a holding voyage hit the wall (its own return was a second earlier)',poolState(w.g,'fake'),{state:'dry',until:iso(w.fixed+1800000)});want('g.now() a day behind: parked',r.parked,false);w.db.close();}console.log(bad+' failure(s) (want 0)');process.exit(bad?1:0);"
```
```bash
node -e "const fs=require('node:fs');const want=['clock: the four events of a first hit are stamped by append, and until follows g.now()','clock: fuel.exhausted of a second hit is stamped by append','clock: a voyage that returns after the wall hit clears the exhaustion','clock: the return of the holding voyage itself does not clear the exhaustion','c1: resetsAt wins over live readings','c2: the earliest reading wins when it was recorded first','c8: a second customs hit on one provider parks despite freighter voyages in between','c8: a customs hit does not count against the next freighter hit','c9: a normal return on the provider between two hits restarts the count'];const s=fs.readFileSync('tests/server/limiter-wall.test.mjs','utf8');let miss=0;for(const t of want)if(!s.includes('test(\x22'+t+'\x22')){miss++;console.log('missing test: '+t);}const src=fs.readFileSync('src/server/limiter/wall.ts','utf8');const wall=src.includes('Date.now')||src.includes('new Date()');if(wall)console.log('src/server/limiter/wall.ts reads the wall clock itself (Date.now or new Date())');console.log(miss+' required test(s) missing (want 0)');process.exit(miss||wall?1:0);"
```
- Verified by the reviewer on the round-0 tree: the first exits 0 (9 tests) and must stay 0 with at least 18 tests; the second exits 1 ("4 failure(s) (want 0)") and exits 0 once the four `ts` properties are gone (it still exits 1 if only `fuel.exhausted` is changed); the third exits 1 ("9 required test(s) missing (want 0)").

**Behavioral criteria** (one test each, title exactly as given; `NOW` is the file's constant; "a day ahead / behind" means `fixed = Date.now() ± 86_400_000` with `w.g.now = () => fixed`):
1. `clock: the four events of a first hit are stamped by append, and until follows g.now()` — `g.now` a day ahead, freighter in flight, no `resetsAt`, no readings. `until` equals `new Date(fixed + 30 * 60_000).toISOString()`. The last four events of the assignment are, in order, `fuel.exhausted`, `voyage.out_of_fuel`, `ship.released`, `moon.awaiting_pickup`, and each one's `ts` lies between `t0` and `t1`.
2. `clock: fuel.exhausted of a second hit is stamped by append` — `g.now` a day ahead; a first hit, `nextAfter`, a second freighter on the same provider, then the hit measured with `t0`/`t1`: `parked` is true and the last five events of the assignment are, in order, `fuel.exhausted`, `voyage.adrift`, `ship.adrift`, `moon.adrift`, `decision.opened`, each with `ts` between `t0` and `t1`.
3. `clock: a voyage that returns after the wall hit clears the exhaustion` — `g.now` a day ahead, the pool fixture from Interfaces. After a first hit, `poolState(w.g, "fake")` deep-equals `{ state: "dry", until: new Date(fixed + 30 * 60_000).toISOString() }`. Then `nextAfter`, a second freighter on `fake`, and its `voyage.returned` appended with `ts: new Date(Date.now() + 1000).toISOString()`: `poolState(w.g, "fake")` deep-equals `{ state: "unknown" }`.
4. `clock: the return of the holding voyage itself does not clear the exhaustion` — `g.now` a day behind, the pool fixture. A freighter is launched, its `voyage.returned` appended with `ts: new Date(Date.now() - 1000).toISOString()`, then `voyage.audited`, then the hit: `parked` is false and `poolState(w.g, "fake")` deep-equals `{ state: "dry", until: new Date(fixed + 30 * 60_000).toISOString() }`.
5. `c1: resetsAt wins over live readings` — one live `fuel.reading` on the provider with `resets_at` `NOW` + 10 minutes, and `resetsAt` `NOW` + 2 hours: the returned `until` and the `fuel.exhausted` payload's `until` both equal the 2-hour time.
6. `c2: the earliest reading wins when it was recorded first` — no `resetsAt`; two live readings appended in this order: window `"ten-minute"` with `resets_at` `NOW` + 10 minutes, then window `"three-day"` with `resets_at` `NOW` + 3 days: `until` is the 10-minute time. (The existing criterion-2 test appends them the other way round; keep it.)
7. `c9: a normal return on the provider between two hits restarts the count` — one provider A, one moon. A freighter on A hits the wall: not parked. `nextAfter`; a second freighter on A is launched, returned and audited; `nextAfter` into round 2; a third freighter on A hits the wall: `parked` false, moon `awaiting_pickup`, no pending decision. `nextAfter`; a fourth freighter on A hits the wall: `parked` true, moon `adrift`.
8. `c8: a second customs hit on one provider parks despite freighter voyages in between` — one provider X. Round 1: a freighter on X is launched, returned, audited; customs on X is launched and hits the wall: `parked` false, moon `audited`. `nextAfter` on the freighter voyage into round 2; a second freighter on X is launched, returned, audited; customs on X is launched and hits the wall: `parked` true, moon `adrift` with `park_reason` `rate_limited`, that customs voyage and its ship `adrift`, one pending decision, the second freighter voyage still `holding` and its ship still `assigned`.
9. `c8: a customs hit does not count against the next freighter hit` — as test 8 up to the first customs hit; then `nextAfter` on the freighter voyage into round 2 and a second freighter on X hits the wall while in flight: `parked` false, that voyage `out_of_fuel`, its ship `idle`, moon `awaiting_pickup`, no pending decision.

**Affected workflow IDs**: none

**Regression guard (task level — implementer runs this):**
```bash
npm test
```

## Out of Scope
- Do not change the signature, the order of the appends, any payload, how `until` is computed, or the second-hit rule.
- Do not add a clock parameter to `append`, and do not change `recordReading`, `poolState` or `parkVoyage`.
- Do not call `endOutOfFuel` from anywhere (V1-FUEL.08 and .09 do).
- Do not change what happens on a third hit after a park (it is not parked; that is recorded for the planner).
- Do not update documentation. Do not fix unrelated failing tests — report them instead (known flake: `tests/server/follow.test.mjs` under load).

## Report Format
Return exactly this structure:

```
STATUS: IMPLEMENTED | IMPLEMENTED_WITH_DEVIATIONS | BLOCKED | BACKEND_FAILURE | RATE_LIMITED
FILES_CHANGED: <list with one-line summary each>
TEST_OUTPUT: <last 20 lines of the acceptance commands>
DEVIATIONS: <anything done differently than specified, and why — or "none".
  IMPLEMENTED requires "none"; IMPLEMENTED_WITH_DEVIATIONS requires a
  non-empty list>
BLOCKED_REASON: <only if BLOCKED: what was needed that the spec didn't provide>
```
