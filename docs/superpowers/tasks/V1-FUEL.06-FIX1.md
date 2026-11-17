# TASK: fuel-limiter-boundaries-and-missing-tests

## Meta
- **Task ID**: V1-FUEL.06-FIX1
- **Parent plan**: docs/superpowers/plans/2026-11-15-v1-fuel.md
- **Depends on**: V1-FUEL.06 (round 0, in the same worktree)
- **Estimated scope**: M
- **Model hint**: sol

## Objective
Five things are wrong on the round-0 tree:
1. A reading exactly at the reserve floor reads `low` at some floors: used 0.93 at floor 0.07, 0.67 at 0.33, 0.68 at 0.32, 0.45 at 0.55. It must read `ok` at every floor.
2. A `fuel.exhausted` event whose `until` is missing or unparseable hides an older live exhaustion: the pool reads `free` or `unknown` when it must read `dry`.
3. A tier that is not an own key of `refuel.models` (`constructor`, `toString`, `hasOwnProperty`, `__proto__`) passes the refuel check, and the chooser returns `fly` with a non-string `model`. It must return `held` without `canRefuel`.
4. Only the single newest applicable exhaustion is examined, so a newer expired exhaustion for one model family hides an older live one for another family: the pool reads `unknown` when it must read `dry`. (Planner's addition to the reviewer's delta; it was a spec gap, not an implementer error.)
5. Twenty-six required tests are missing and one existing assertion reads the wrong config path.

## Context
The round-0 code passed review on everything else; the reviewer ran the untested paths by hand and they behave as specified, so the new tests are expected to pass against the current code except where they exercise defects 1 to 3. The dispatcher wall and the scheduler are built on this module next, so the tests are the deliverable, not a formality. The original spec's literal `1 - used < floor` is wrong in floating point, and so is the round-0 `used > 1 - floor`; the tolerance form under Interfaces is the ruling. Do not relitigate anything else in V1-FUEL.06. Affected workflow IDs is `none` because this project has no review suite.

## Files

### Touch
| Path | Action | Notes |
|------|--------|-------|
| `tests/server/limiter-pool.test.mjs` | modify | add the twelve tests under Acceptance |
| `tests/server/limiter-choose.test.mjs` | modify | add the twelve tests under Acceptance |
| `tests/config/pool-refuel.test.mjs` | modify | add two tests; delete the one wrong-path assertion |
| `src/server/limiter/pool.ts` | modify | only inside `poolState`: the `low` comparison and which exhaustion events are examined |
| `src/server/limiter/limiter.ts` | modify | only the tier lookup inside `chooseProvider` |

### Do NOT touch
- `src/config/schema.ts`, `src/server/galaxy.ts`, `src/db/statements.ts` — passed review
- `src/server/dispatch.ts` — security-routed; import from it, never edit it
- `src/server/commands/**`, `src/server/scheduler/**`, `src/server/http/**`, `src/providers/**`
- `tests/helpers.mjs`, `tests/fixtures/**` — use them as they are
- `templates/**`, `CLAUDE.md`, `docs/**`
- Any file not listed under Touch. If the fix seems to need one, STOP and report BLOCKED.

**Standing exclusions:**
- Security-routed files, never modified by this lane: `src/core/git.ts`, `src/validate/**`, `src/providers/claude-sdk/gate-hook.ts`, `src/server/dispatch.ts`, `src/db/migrations/**`, `src/server/http/auth.ts`, `src/server/lock.ts`
- Pipeline-owned paths: `docs/superpowers/plans/**`, `docs/superpowers/tasks/**`, `.superpowers/sdd/**`
- `package.json`, `package-lock.json` — no dependency changes

## Interfaces
No signature, type or SQL changes. Three behaviour changes:

```ts
// src/server/limiter/pool.ts — poolState
// (1) low  <=>  (pool.reserve_floor ?? 0) - (1 - tightest.used) > 1e-9
//     ("remaining strictly below the floor", with a 1e-9 tolerance). remaining stays 1 - used.
// (2) The exhaustion examined is the newest fuel.exhausted event that applies to `model`
//     AND whose payload.until parses as a date. Events with a missing or unparseable until
//     are skipped; they are never "the newest". Everything after that choice is unchanged
//     (until later than g.now(), not cleared by a returned voyage).
// (2b) One exhaustion is examined PER FAMILY, not one overall: group the applicable usable events by
//     payload.model_family (the exact string; events with no family form their own group) and take the
//     newest of each group. The pool is dry when ANY of those is live (until later than g.now()) and not
//     cleared by a returned voyage (the existing clearing rule, applied to that event). `until` in the
//     result is the latest until among the live uncleared ones. Within one family a newer event still
//     supersedes an older one, even when the newer one is expired or cleared.

// src/server/limiter/limiter.ts — chooseProvider
// (3) A tier "has an entry in refuel.models" only when it is an OWN key (Object.hasOwn)
//     whose value is a non-empty string. Otherwise refuel condition 2 fails: plain held.
```

Voyage fixture for the criterion-6, 13 and 15 tests (verified by the reviewer against the round-0 build; `loadMoon` and `moonScope` are imported from `dist/server/dispatch.js`):

```js
const w = await worldWithMoon("happy", (c) => { /* pools, a second provider `probe: { adapter: "fake", pool: {...} }`, roles, c.fleet.freighters, c.scheduler.per_provider_max */ });
const scope = moonScope(w.g, loadMoon(w.g, "T1"));
append(w.g.db, { kind: "moon.gated", ...scope, payload: { base_sha: "0".repeat(40), state_path: ".nexus/state/T1.json", round: 1 } });
const ship = w.g.db.get("ships.pickIdle", { class: "freighter", fleet: provider });
const voyageId = `${ship.id}/T1/implement/1`;
append(w.g.db, { kind: "voyage.launched", ...scope, ts: launchedTs, voyage_id: voyageId, ship_id: ship.id, provider, payload: { role: "implement", round: 1, provider, ship_id: ship.id, worktree: "w" /*, model */ } });
append(w.g.db, { kind: "voyage.returned", ...scope, ts: returnedTs, voyage_id: voyageId, payload: { role: "implement", report: {} } });   // omit for a voyage still in flight
```

## Constraints
- Each test under Acceptance is written as `test("<title>", ...)` with the exact title given and double quotes; the third command looks for that text.
- Expected values are the literals written below, never values computed by the code under test. Where a whole object is given, use `assert.deepEqual` so an extra key such as `canRefuel` fails.
- The thirteen existing tests stay. No existing `assert.*` line may be changed or removed, with one exception: `assert.equal(DEFAULT_CONFIG.providers.fake.refuel, undefined);` in `tests/config/pool-refuel.test.mjs` is deleted (the text `providers.fake.refuel` must not appear in that file).
- One voyage per world in the criterion-6 tests; use a fresh world for each case.
- In the source files change only what Interfaces names. No refactoring, no renamed helpers, no `Date.now()`.
- No new dependencies. Tests import from `dist/` and build worlds with `makeGalaxy` / `worldWithMoon`.
- Times below are UTC. "now" means `w.g.now = () => Date.parse(<that time>)`.

## Acceptance

**Test commands (all three must exit 0; run from the repo root in this order — the second reads the `dist/` built by the first):**
```bash
npm test -- "tests/config/*.test.mjs" "tests/server/limiter-*.test.mjs" "tests/db/*.test.mjs"
```
```bash
node --disable-warning=ExperimentalWarning --input-type=module -e "import {openDb} from './dist/db/open.js';import {append} from './dist/db/events.js';import {poolState} from './dist/server/limiter/pool.js';import {chooseProvider} from './dist/server/limiter/limiter.js';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';const T=Date.parse('2026-11-17T12:00:00.000Z'),iso=(o)=>new Date(T+o).toISOString();const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fuel06-'));const db=openDb(path.join(dir,'n.db'));const g={db,now:()=>T,adapters:{a:{},b:{}},config:{providers:{a:{pool:{kind:'window',reserve_floor:0.1,refuel:{provider:'b',models:{sol:'m'},min_wait_minutes:0}}},b:{}},roles:{implement:['a'],review:['a']},scheduler:{per_provider_max:{}}}};const J=(v)=>JSON.stringify(v,(k,x)=>x!==null&&typeof x=='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort()):x);let bad=0;const want=(label,got,exp)=>{const ok=J(got)===J(exp);if(!ok)bad++;console.log((ok?'ok   ':'FAIL ')+label+': '+J(got)+(ok?'':' (want '+J(exp)+')'))};const rd=(p,used)=>append(db,{kind:'fuel.reading',provider:p,ts:iso(0),payload:{window:'w',used,resets_at:iso(3600000),source:'reported'}});for(const [u,f] of [[0.9,0.1],[0.8,0.2],[0.95,0.05],[0.7,0.3],[0.93,0.07],[0.67,0.33],[0.68,0.32],[0.45,0.55]]){const p='p'+f;g.config.providers[p]={pool:{kind:'window',reserve_floor:f}};rd(p,u);want('used '+u+' exactly at floor '+f,poolState(g,p).state,'ok');const over=Math.round(u*100+1)/100;rd(p,over);want('used '+over+' at floor '+f,poolState(g,p).state,'low')}append(db,{kind:'fuel.exhausted',provider:'x',ts:iso(0),payload:{until:iso(3600000),voyage_id:'v'}});append(db,{kind:'fuel.exhausted',provider:'x',ts:iso(1),payload:{until:'not a date',voyage_id:'v'}});want('live exhaustion behind a newer event with an unparseable until',poolState(g,'x'),{state:'dry',until:iso(3600000)});append(db,{kind:'fuel.exhausted',provider:'x',ts:iso(2),payload:{voyage_id:'v'}});want('live exhaustion behind a newer event with no until',poolState(g,'x'),{state:'dry',until:iso(3600000)});for(const [id,fleet] of [['s1','a'],['s2','b']])append(db,{kind:'ship.registered',ship_id:id,provider:fleet,payload:{ship:{id,name:id,class:'freighter',fleet}}});rd('a',0.95);const held={kind:'held',provider:'a',reason:'low',until:iso(3600000)};want('tier sol, mayRefuel false',chooseProvider(g,{role:'implement',tier:'sol',mayRefuel:false}),{...held,canRefuel:{provider:'b',model:'m'}});for(const tier of ['constructor','toString','__proto__','hasOwnProperty'])want('tier '+tier+', mayRefuel true',chooseProvider(g,{role:'implement',tier,mayRefuel:true}),held);db.close();fs.rmSync(dir,{recursive:true,force:true});console.log(bad+' failure(s) (want 0)');process.exit(bad?1:0)"
```
```bash
node -e "const fs=require('node:fs');const want={'tests/server/limiter-pool.test.mjs':['c2: an ok reading reports remaining, window, resets_at and reading_ts','c2: a reading exactly at the reserve floor is ok','c5: dry carries the until of the exhaustion','c5: an exhaustion event without a usable until is skipped','c5: a newer expired exhaustion for one family does not hide a live one for another','c6: a voyage returned after the exhaustion clears it','c6: a voyage returned before the exhaustion does not clear it','c6: a voyage returned on another provider does not clear it','c6: a family exhaustion is cleared only by a voyage of that family','c8: invalid readings alone leave the pool unknown','c9: a changed resets_at alone appends','c9: another family appends and a duplicate appends nothing'],'tests/server/limiter-choose.test.mjs':['c10: ok, unknown and free allow both roles','c11: a single ok provider flies with no reroutedFrom','c12: review flies on a low first provider','c13: a first provider with every freighter assigned is skipped without reroutedFrom','c14: a low provider is held with until and a dry one is held for both roles','c15: without capacity the at-limit and all-assigned messages are exact','c16: requested flies the second provider while the first is fine','c18: a dry hold refuels with refuelFor reason dry','c19: each refuel condition failing alone is held without canRefuel','c19: an unknown until allows the refuel','c19: a tier that is not an own key of refuel.models cannot refuel','c21: flights on one fleet take different ships'],'tests/config/pool-refuel.test.mjs':['c23: a given non-zero min_wait_minutes is kept','c25: DEFAULT_CONFIG declares no pool.refuel and normalizes']};let miss=0;for(const f in want){const s=fs.readFileSync(f,'utf8');for(const t of want[f])if(!s.includes('test(\x22'+t+'\x22')){miss++;console.log('missing test: '+f+' :: '+t)}}const stale=fs.readFileSync('tests/config/pool-refuel.test.mjs','utf8').includes('providers.fake.refuel');if(stale)console.log('pool-refuel.test.mjs still reads DEFAULT_CONFIG.providers.fake.refuel (the wrong path)');console.log(miss+' required test(s) missing (want 0)');process.exit(miss||stale?1:0)"
```
- Verified by the reviewer on the round-0 tree: the first exits 0 (97 tests) and must stay 0 with at least 123 tests; the second exits 1 ("10 failure(s) (want 0)"); the third exits 1 ("25 required test(s) missing (want 0)" plus the wrong-path line; with the planner-added test the count on round 0 is 26).

**Behavioral criteria** (one test each, title exactly as given).

`tests/server/limiter-pool.test.mjs` — provider `fake`, pool `{ kind: "window", reserve_floor: 0.1 }`, now 12:00:00.000 on 2026-11-17 unless stated:
1. `c2: an ok reading reports remaining, window, resets_at and reading_ts` — one reading `{ window: "five-hour", used: 0.2, resets_at: "2026-11-17T12:01:00.000Z" }` with event `ts` `"2026-11-17T12:00:00.000Z"`: `poolState(g, "fake")` deep-equals `{ state: "ok", remaining: 0.8, window: "five-hour", resets_at: "2026-11-17T12:01:00.000Z", reading_ts: "2026-11-17T12:00:00.000Z" }`. After a newer reading of 0.95 for the same window with the same `resets_at` and `ts`: `state` `"low"`, the same `window`, `resets_at` and `reading_ts`, `remaining` within 1e-9 of 0.05.
2. `c2: a reading exactly at the reserve floor is ok` — for each (used, floor) of (0.9, 0.1), (0.8, 0.2), (0.95, 0.05), (0.7, 0.3), (0.93, 0.07), (0.67, 0.33), (0.68, 0.32), (0.45, 0.55): state `"ok"`. With used 0.91, 0.81, 0.96, 0.71, 0.94, 0.68, 0.69, 0.46 at the same floors: `"low"`. With no `reserve_floor` and used 1: `"ok"`.
3. `c5: dry carries the until of the exhaustion` — a `fuel.exhausted` with no family, `ts` 12:00:00.000, `until` `"2026-11-17T13:00:00.000Z"`: deep-equals `{ state: "dry", until: "2026-11-17T13:00:00.000Z" }`. With now 13:00:00.001: deep-equals `{ state: "unknown" }`.
4. `c5: an exhaustion event without a usable until is skipped` — the exhaustion of test 3, then a newer `fuel.exhausted` with `until: "not a date"`, then a newer one with no `until`: still deep-equals `{ state: "dry", until: "2026-11-17T13:00:00.000Z" }`. In a second world holding only the two unusable events: deep-equals `{ state: "unknown" }`.
4b. `c5: a newer expired exhaustion for one family does not hide a live one for another` — now 12:00:00.000, three fresh worlds. World A: an exhaustion with `model_family: "opus"`, `ts` 09:00:00.000, `until` `"2026-11-18T12:00:00.000Z"`, then a newer one with `model_family: "sonnet"`, `ts` 10:00:00.000, `until` `"2026-11-17T11:00:00.000Z"` (expired): `poolState(g, "fake")` and `poolState(g, "fake", "claude-opus-5-5")` each deep-equal `{ state: "dry", until: "2026-11-18T12:00:00.000Z" }`, and `poolState(g, "fake", "claude-sonnet-5-5")` deep-equals `{ state: "unknown" }`. World B (same family supersedes): the same two events but both with `model_family: "opus"`: `poolState(g, "fake")` deep-equals `{ state: "unknown" }`. World C (both live): as World A but the sonnet event's `until` is `"2026-11-17T13:00:00.000Z"`: `poolState(g, "fake")` deep-equals `{ state: "dry", until: "2026-11-18T12:00:00.000Z" }` and `poolState(g, "fake", "claude-sonnet-5-5")` deep-equals `{ state: "dry", until: "2026-11-17T13:00:00.000Z" }`.
5. `c6: a voyage returned after the exhaustion clears it` — now 12:00:30. Exhaustion on `fake`, `ts` 12:00:00.000, `until` 13:00. A `fake` voyage launched 12:00:05: state still `"dry"`. The same voyage returned 12:00:10: deep-equals `{ state: "unknown" }`.
6. `c6: a voyage returned before the exhaustion does not clear it` — now 12:00:30. A `fake` voyage launched 11:59:40 and returned 11:59:50, then the exhaustion at `ts` 12:00:00.000, `until` 13:00: deep-equals `{ state: "dry", until: "2026-11-17T13:00:00.000Z" }`.
7. `c6: a voyage returned on another provider does not clear it` — now 12:00:30. Exhaustion on `fake` as above; a `probe` voyage launched 12:00:05 and returned 12:00:10: `poolState(g, "fake")` deep-equals `{ state: "dry", until: "2026-11-17T13:00:00.000Z" }` and `poolState(g, "probe")` deep-equals `{ state: "unknown" }`.
8. `c6: a family exhaustion is cleared only by a voyage of that family` — now 12:00:30; exhaustion on `fake` with `model_family: "opus"`, `ts` 12:00:00.000, `until` 13:00. World A: a `fake` voyage with `model: "claude-haiku-5-5"` returned 12:00:10; `poolState(g, "fake")` and `poolState(g, "fake", "claude-opus-5-5")` are both `"dry"`. World B: a `fake` voyage with `model: "claude-opus-5-5"` returned 12:00:10; both are `"unknown"`.
9. `c8: invalid readings alone leave the pool unknown` — only readings with `used` of `NaN`, `7`, `-1`, `"x"` (each in its own window): `poolState` deep-equals `{ state: "unknown" }` and `poolReadings` deep-equals `[]`.
10. `c9: a changed resets_at alone appends` — `recordReading` with `{ window: "five-hour", used: 0.2, resets_at: "2026-11-17T12:01:00.000Z" }` returns true; the same with `resets_at: "2026-11-17T12:02:00.000Z"` (same `used`) returns true; that again returns false; the same with no `resets_at` returns true.
11. `c9: another family appends and a duplicate appends nothing` — `recordReading(g, { task_id: "T1" }, "fake", { window: "five-hour", used: 0.2, resets_at: "2026-11-17T12:01:00.000Z" })` returns true and `events.maxId` rises by 1. The newest event has `kind` `"fuel.reading"`, `provider` `"fake"`, `task_id` `"T1"`, `ts` `"2026-11-17T12:00:00.000Z"`, and a payload deep-equal to `{ window: "five-hour", used: 0.2, resets_at: "2026-11-17T12:01:00.000Z", source: "reported" }`. The identical call returns false and `events.maxId` is unchanged. Adding `model_family: "opus"` returns true; that again returns false.

`tests/server/limiter-choose.test.mjs` — the file's existing world: `fake` and `probe`, both `{ kind: "window", reserve_floor: 0.1 }`, roles `["fake", "probe"]` for both roles, now 12:00:00.000; readings use `resets_at` `"2026-11-17T13:00:00.000Z"`; `LOW` means `{ kind: "held", provider: "fake", reason: "low", until: "2026-11-17T13:00:00.000Z" }`:
12. `c10: ok, unknown and free allow both roles` — `fake` reading 0.2: `fuelCheck` for implement and for review deep-equals `{ allow: true }`. `probe` with no readings: both roles `{ allow: true }`. `probe` with its `pool` deleted: both roles `{ allow: true }`. Then an exhaustion on `fake`, `ts` 12:00:00.001, `until` `"2026-11-17T14:00:00.000Z"`: both roles deep-equal `{ allow: false, reason: "dry", until: "2026-11-17T14:00:00.000Z" }`.
13. `c11: a single ok provider flies with no reroutedFrom` — implement order `["fake"]`, `fake` reading 0.2: `kind` `"fly"`, `provider` `"fake"`, `shipId` is the id of an idle freighter of fleet `fake` (checked against `ships.all`), and none of `reroutedFrom`, `refuelFor`, `model` is a key of the choice.
14. `c12: review flies on a low first provider` — `fake` 0.95, `probe` 0.2: `chooseProvider(g, { role: "review", tier: null, mayRefuel: false })` has `kind` `"fly"`, `provider` `"fake"`, a customs ship of fleet `fake`, no `reroutedFrom` key.
15. `c13: a first provider with every freighter assigned is skipped without reroutedFrom` — `c.fleet.freighters = 1`, both providers reading 0.2, a `fake` voyage launched and not returned; no `capacity`: `kind` `"fly"`, `provider` `"probe"`, no `reroutedFrom` key.
16. `c14: a low provider is held with until and a dry one is held for both roles` — no refuel declared. `fake` 0.95, `requested: "fake"`: deep-equals `LOW`. Then an exhaustion on `fake`, `ts` 12:00:00.001, `until` `"2026-11-17T14:00:00.000Z"`: implement with `requested: "fake"`, and `chooseProvider(g, { role: "review", tier: null, mayRefuel: false, requested: "fake" })`, each deep-equal `{ kind: "held", provider: "fake", reason: "dry", until: "2026-11-17T14:00:00.000Z" }`.
17. `c15: without capacity the at-limit and all-assigned messages are exact` — no `capacity` argument in either case. World A: `per_provider_max` `{ fake: 1 }`, two freighters, one `fake` voyage in flight, `requested: "fake"`: deep-equals `{ kind: "none", message: "provider 'fake' is at its limit of 1 (scheduler.per_provider_max)" }`. World B: one freighter, no cap, one `fake` voyage in flight, `requested: "fake"`: deep-equals `{ kind: "none", message: "all freighters in fleet 'fake' are assigned" }`.
18. `c16: requested flies the second provider while the first is fine` — both providers reading 0.2: with no `requested` the provider is `"fake"`; with `requested: "probe"`: `kind` `"fly"`, `provider` `"probe"`, no `reroutedFrom` key.
19. `c18: a dry hold refuels with refuelFor reason dry` — refuel declared on `fake` (`provider: "probe"`, `models: { sol: "haiku-model" }`, `min_wait_minutes: 30`), tier `"sol"`, an exhaustion on `fake` with `until` `"2026-11-17T14:00:00.000Z"`, `requested: "fake"`. `mayRefuel: true`: `kind` `"fly"`, `provider` `"probe"`, `model` `"haiku-model"`, `refuelFor` deep-equals `{ provider: "fake", reason: "dry" }`, no `reroutedFrom` key. `mayRefuel: false`: deep-equals `{ kind: "held", provider: "fake", reason: "dry", until: "2026-11-17T14:00:00.000Z", canRefuel: { provider: "probe", model: "haiku-model" } }`.
20. `c19: each refuel condition failing alone is held without canRefuel` — the same refuel declaration, tier `"sol"`, `fake` reading 0.95, `requested: "fake"`, `mayRefuel: false`. A fresh world for each case; each result deep-equals `LOW`:
    - (a) no `refuel` key;
    - (b) `tier: null`;
    - (c) `tier: "luna"`;
    - (d) `probe` reading 0.95;
    - (e) an exhaustion on `probe` with `until` `"2026-11-17T14:00:00.000Z"`;
    - (f) `min_wait_minutes` 90;
    - (g) `min_wait_minutes` 60 (the reset is exactly 60 minutes away, which is not "more than");
    - (h) `capacity: { free: 5, providerUse: new Map(), claimed: <every freighter id of fleet probe> }`;
    - (i) `per_provider_max.probe = 1` with `capacity: { free: 5, providerUse: new Map([["probe", 1]]), claimed: new Set() }`.
21. `c19: an unknown until allows the refuel` — as test 20, but the `fake` reading of 0.95 has no `resets_at`. `mayRefuel: false`: deep-equals `{ kind: "held", provider: "fake", reason: "low", canRefuel: { provider: "probe", model: "haiku-model" } }`. `mayRefuel: true`: `kind` `"fly"`, `provider` `"probe"`, `model` `"haiku-model"`, `refuelFor` deep-equals `{ provider: "fake", reason: "low" }`.
22. `c19: a tier that is not an own key of refuel.models cannot refuel` — as test 20's base with `mayRefuel: true`, for each tier of `"constructor"`, `"toString"`, `"hasOwnProperty"`, `"__proto__"`: deep-equals `LOW`.
23. `c21: flights on one fleet take different ships` — three freighters per fleet, `fake` reading 0.2, `requested: "fake"`, one `capacity` of `{ free: 5, providerUse: new Map(), claimed: new Set() }`. Three choices are all `"fly"` with three distinct `shipId`s; then `capacity.free` is 2, `capacity.providerUse.get("fake")` is 3, and `capacity.claimed` holds exactly those three ids. A fourth choice deep-equals `{ kind: "none", message: "all freighters in fleet 'fake' are assigned" }`.

`tests/config/pool-refuel.test.mjs`:
24. `c23: a given non-zero min_wait_minutes is kept` — `min_wait_minutes: 45` normalizes to 45.
25. `c25: DEFAULT_CONFIG declares no pool.refuel and normalizes` — for every provider in `DEFAULT_CONFIG.providers`, `pool?.refuel` is `undefined`; `normalizeConfig(DEFAULT_CONFIG)` does not throw, and no provider in its result has `pool.refuel`.

**Affected workflow IDs**: none

**Regression guard (task level — implementer runs this):**
```bash
npm test
```

## Out of Scope
- Do not change any signature, type, SQL statement, the schema validation or `Galaxy`.
- Do not change which exhaustion wins beyond rules (2) and (2b): within one family the newest usable applicable one wins, even when it is expired or cleared.
- Do not call these functions from commands, the scheduler or the reads; do not write `fuel.exhausted` or any `limiter.*` event outside tests.
- Do not add an index or a migration, validate `used` in `recordReading`, or change `fuelHold`.
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
