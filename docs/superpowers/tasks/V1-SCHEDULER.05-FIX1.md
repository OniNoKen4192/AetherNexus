# TASK: scheduler-decision-function — fix round 1

## Meta
- **Task ID**: V1-SCHEDULER.05-FIX1
- **Parent plan**: docs/superpowers/plans/2026-11-15-v1-scheduler.md
- **Depends on**: V1-SCHEDULER.04
- **Estimated scope**: S
- **Model hint**: sol

## Objective
Two tests in `tests/server/scheduler-plan.test.mjs` pass even when the behaviour they name is removed from `plan`. After this round, the test file fails if `plan` stops ordering its result, and fails if `plan` writes an event while planning actions.

## Context
This is fix round 1 of task V1-SCHEDULER.05; the round-0 work is committed in this worktree. `src/server/scheduler/plan.ts` was reviewed and is correct; it must not change. Only the test file is at fault.
- **Order test.** "result order is dock, inspect, later launch, then first launches by assignment" assigns its moons in the same order as the expected result (DOCK, INSPECT, FIX, FIRST1, FIRST2). The database already returns them in that order, so the test passes with the sort deleted from `plan`.
- **Writes-nothing test.** "busy tasks are omitted and planning writes no events" compares `events.maxId` around a call whose only moon is in `ctx.busy`. `plan` skips that moon before doing any work, so the assertion would still hold if `plan` appended an event for every action it returns.

The acceptance command below runs the test file against the real `plan` and against two altered copies of the compiled `plan`, built in the OS temp directory. The test file must pass on the real one and fail on both altered ones. Affected workflow IDs is `none` because this project has no review suite.

## Files

### Touch
| Path | Action | Notes |
|------|--------|-------|
| `tests/server/scheduler-plan.test.mjs` | modify | strengthen the order test and the writes-nothing assertion only |

### Do NOT touch
- `src/server/scheduler/plan.ts` — correct as reviewed. The acceptance command looks for its compiled statements `candidates.sort(` and `return out;`. Any change to this file fails the round.
- `src/server/scheduler/.gitkeep`
- `src/server/commands/**`, `src/server/scheduler/loop.ts`, `src/server/http/**`, `src/db/statements.ts`, `src/core/fleet.ts`, `tests/fixtures/**`, `tests/helpers.mjs`, `web/**`
- Any file not listed under Touch. If the fix seems to need another file, STOP and report BLOCKED.

**Standing exclusions:**
- Security-routed files, never modified by this lane: `src/core/git.ts`, `src/validate/**`, `src/providers/claude-sdk/gate-hook.ts`, `src/server/dispatch.ts`, `src/db/migrations/**`, `src/server/http/auth.ts`, `src/server/lock.ts`
- Pipeline-owned paths: `docs/superpowers/plans/**`, `docs/superpowers/tasks/**`, `.superpowers/sdd/**`
- `package.json`, `package-lock.json` — no dependency changes

## Interfaces
Unchanged from the original spec (`docs/superpowers/tasks/V1-SCHEDULER.05.md`). Nothing is produced or changed outside the test file.

## Constraints
- Keep every existing test and assertion; do not weaken or delete any. The 15 current tests must still pass.
- Keep the import specifiers at the top of the test file in their current form: double-quoted, relative, `"../helpers.mjs"`, `"../fixtures/world.mjs"`, `"../../dist/..."`. The acceptance command rewrites exactly these.
- Tests use `node:test` and `node:assert/strict`, import compiled code from `dist/`, and clean up in `finally`.
- Wording rule for test names and comments: ships move, places don't. A freighter is sent to a moon, customs inspects, the freighter docks. Never "the moon launches".

## Acceptance

**Test command (must exit 0; run from the repository root of the worktree; takes about 90 s):**
```bash
npm test -- "tests/server/scheduler-plan.test.mjs" && node --disable-warning=ExperimentalWarning -e "const fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process'),url=require('url');const q=String.fromCharCode(34),U=url.pathToFileURL(process.cwd()).href;const abs=(s)=>s.split(q+'../../dist/').join(q+U+'/dist/').split(q+'../helpers.mjs').join(q+U+'/tests/helpers.mjs').split(q+'../fixtures/').join(q+U+'/tests/fixtures/').split(q+'../commands/').join(q+U+'/dist/server/commands/').split(q+'../dispatch.js').join(q+U+'/dist/server/dispatch.js');const test=abs(fs.readFileSync('tests/server/scheduler-plan.test.mjs','utf8').split(q+'../../dist/server/scheduler/plan.js').join(q+'./plan.mjs'));const src=abs(fs.readFileSync('dist/server/scheduler/plan.js','utf8'));const variants=[['unchanged plan',src,true],['plan with its ordering removed',src.split('candidates.sort(').join('void ('),false],['plan that appends an event for every action it returns','import { append as extraAppend } from '+q+U+'/dist/db/events.js'+q+';'+src.split('return out;').join('for (const a of out) extraAppend(g.db, { kind: '+q+'tree.written'+q+', payload: { paths: [] } }); return out;'),false]];const run=([name,code,wantGreen])=>new Promise((done)=>{if(wantGreen===false&&code===src){console.log('NOT OK  '+name+': variant could not be built');done(1);return;}const dir=fs.mkdtempSync(path.join(os.tmpdir(),'plan-variant-'));fs.writeFileSync(path.join(dir,'plan.mjs'),code);fs.writeFileSync(path.join(dir,'plan.test.mjs'),test);cp.spawn(process.execPath,['--disable-warning=ExperimentalWarning','--test',path.join(dir,'plan.test.mjs')],{stdio:'ignore'}).on('exit',(status)=>{fs.rmSync(dir,{recursive:true,force:true});const green=status===0,ok=green===wantGreen;console.log((ok?'ok      ':'NOT OK  ')+name+': the test file '+(green?'passes':'fails')+', expected it to '+(wantGreen?'pass':'fail'));done(ok?0:1);});});Promise.all(variants.map(run)).then((r)=>process.exit(r.some((x)=>x===1)?1:0));"
```
It currently exits 1: the control line is `ok`, and both altered plans are `NOT OK`.

**Behavioral criteria:**
1. **Order (original criterion 19).** In the order test, the moons are assigned so that ascending `assignment_id` differs from the required result order. For example: an emitted moon first, then the FIX moon, then the holding moon, then the dock moon, then the second emitted moon. The asserted result stays exactly `dock`, `inspect`, `launch` (`first: false`), `launch` (`first: true`), `launch` (`first: true`), with the two emitted moons in ascending `assignment_id`. The test must fail when `plan` does not sort.
2. **Writes nothing (original criterion 21).** `events.maxId` is read immediately before and after a `plan` call that returns at least one action, and the two values are asserted equal. The call in the order test, which returns all four kinds, is the natural place. The test file must fail when `plan` appends an event for an action it returns.
3. `git status` shows `src/server/scheduler/plan.ts` unchanged from the state handed to this round.

**Affected workflow IDs**: none

**Regression guard (task level — implementer runs this):**
```bash
npm test
```

## Out of Scope
- No change to `plan.ts`, to any command function, or to fixtures and helpers.
- Do not add tests for other behaviour (voyages in flight, adapter membership, `park_stale` ordering); those are recorded for final review.
- Do not restructure, rename or reformat the existing tests beyond what criteria 1 and 2 need.
- Do not update documentation. Do not fix unrelated failing tests; report them instead.

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
