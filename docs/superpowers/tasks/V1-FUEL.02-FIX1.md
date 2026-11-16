# TASK: fuel-arrows-refusal-test (delta)

## Meta
- **Task ID**: V1-FUEL.02-FIX1
- **Parent plan**: docs/superpowers/plans/2026-11-15-v1-fuel.md
- **Depends on**: V1-FUEL.02 (its changes are committed in this worktree and stay as they are)
- **Estimated scope**: S
- **Model hint**: terra

## Objective
The refusal tests in `tests/core/transitions-fuel.test.mjs` fail when any of the seven fuel-related event keys accepts a source status that the contract below does not list. Today they pass whatever the tables contain, because they read the allowed sources from the tables under test.

## Context
Review of V1-FUEL.02 found the source code correct and one test defect. The two tests titled "fuel-related moon event keys refuse every source absent from their tables" and "fuel-related voyage event keys refuse every source absent from their tables" decide what is allowed by reading `MOON_TRANSITIONS[event]?.[from]` and `VOYAGE_TRANSITIONS[event]?.[from]`. An extra arrow added to the code is therefore silently treated as allowed. The expected sources must be written out in the test file as literal data. Do not copy the pattern in `tests/core/transitions.test.mjs`; it has the same weakness and is not this task's to change. The production tables already match the contract, so no source file needs to change. Wording rule for any test name or comment you touch: places don't move, appear or vanish; a ship runs out of fuel, a moon never does; the work at a moon is its cargo.

## Files

### Touch
| Path | Action | Notes |
|------|--------|-------|
| `tests/core/transitions-fuel.test.mjs` | modify | the two refusal tests only |

### Do NOT touch
- `src/core/transitions.ts`, `src/db/reducers/moons.ts`, `src/db/reducers/voyages.ts`, `src/db/reducers/index.ts`, `src/server/commands/park.ts` — reviewed and correct; they stay exactly as they are in the worktree
- `tests/db/reducers-fuel.test.mjs` — reviewed and accepted as it stands
- `tests/core/transitions.test.mjs` and every other existing test — must keep passing unchanged
- The first test in the file ("fuel arrows accept every listed moon and voyage transition") — already correct
- Any file not listed under Touch. If completing the objective seems to require touching an unlisted file, STOP and report BLOCKED.

**Standing exclusions:**
- Security-routed files, never modified by this lane: `src/core/git.ts`, `src/validate/**`, `src/providers/claude-sdk/gate-hook.ts`, `src/server/dispatch.ts`, `src/db/migrations/**`, `src/server/http/auth.ts`, `src/server/lock.ts`
- Pipeline-owned paths: `docs/superpowers/plans/**`, `docs/superpowers/tasks/**`, `.superpowers/sdd/**`
- `package.json`, `package-lock.json` — no dependency changes

## Interfaces
The complete allowed arrows for the seven keys (source → result). The test file must carry this as literal data and must not derive it from the exported tables.

```ts
// moon keys — sources taken over: barren, emitted, gated, implementing, audited, reviewing, merged, adrift, quarantined, dropped, awaiting_pickup
"moon.awaiting_pickup":  { implementing: "awaiting_pickup", audited: "awaiting_pickup" }
"moon.review_abandoned": { reviewing: "audited" }
"moon.gated":   { emitted: "gated", gated: "gated", adrift: "gated", quarantined: "gated", audited: "gated", awaiting_pickup: "gated" }
"moon.adrift":  { implementing: "adrift", audited: "adrift", reviewing: "adrift", emitted: "adrift", gated: "adrift", adrift: "adrift", quarantined: "quarantined", awaiting_pickup: "adrift" }
"moon.dropped": { adrift: "dropped", quarantined: "dropped", awaiting_pickup: "dropped" }

// voyage keys — sources taken over: launched, working, holding, cleared, en_route, docked, superseded, adrift, quarantined, out_of_fuel
"voyage.out_of_fuel": { launched: "out_of_fuel", working: "out_of_fuel", holding: "out_of_fuel" }
"voyage.superseded":  { holding: "superseded", cleared: "superseded", en_route: "superseded", adrift: "superseded", quarantined: "superseded", out_of_fuel: "superseded" }
```

For every (key, source) pair: if the pair is listed above, `nextMoonStatus` / `nextVoyageStatus` returns the listed result; otherwise it throws `TransitionRefused`.

Keep the two existing specific checks:
- `awaiting_pickup` refuses `voyage.launched:implement`.
- `out_of_fuel` refuses every key of `VOYAGE_TRANSITIONS` other than `voyage.superseded`. Reading the table's keys to enumerate events is fine; reading it to decide which sources are allowed is the defect.

## Constraints
- Tests use `node:test` and `node:assert/strict` and import from `dist/` (the test command builds first).
- No new dependencies, no new files.
- Keep the file's existing style; three tests remain, with test names that follow the wording rule.

## Acceptance

**Test commands (both must exit 0; run from the repo root, in this order — the second reads the `dist/` built by the first):**
```bash
npm test -- "tests/core/*.test.mjs" "tests/db/*.test.mjs"
```
```bash
node -e "const {spawnSync}=require('node:child_process');const muts=['M moon.awaiting_pickup gated awaiting_pickup','M moon.review_abandoned audited audited','M moon.gated implementing gated','M moon.adrift merged adrift','M moon.dropped gated dropped','V voyage.out_of_fuel cleared out_of_fuel','V voyage.superseded launched superseded'];const code='import {MOON_TRANSITIONS as M, VOYAGE_TRANSITIONS as V} from \'./dist/core/transitions.js\'; const [t,k,s,v]=process.env.MUT.split(\' \'); (t===\'M\'?M:V)[k][s]=v; await import(\'./tests/core/transitions-fuel.test.mjs\');';let bad=0;for(const m of muts){const r=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',env:{...process.env,MUT:m}});if(r.status===0){console.log('SURVIVED (extra arrow not caught): '+m);bad++}else console.log('caught: '+m)}console.log(bad+' of '+muts.length+' extra arrows survived');process.exit(bad?1:0)"
```
The second command adds one extra arrow at a time to the in-memory tables (it writes nothing to disk) and runs the test file against it; the test file must fail for each. Verified by the reviewer on the round-0 tree: exit 1, "7 of 7 extra arrows survived". The first command currently exits 0 and must stay that way.

**Behavioral criteria:**
1. For each of the seven keys, every source status not listed under Interfaces (over the eleven moon sources including `barren`, the ten voyage sources) is refused with `TransitionRefused`, judged against literal data in the test file.
2. An extra arrow on any of the seven keys makes `tests/core/transitions-fuel.test.mjs` fail (the second command above).
3. `awaiting_pickup` refuses `voyage.launched:implement`; `out_of_fuel` accepts nothing but `voyage.superseded`.

**Affected workflow IDs**: none

**Regression guard (task level — implementer runs this):**
```bash
npm test
```

## Out of Scope
- Do not change any arrow, reducer or other source file; if the hardened test fails against the current tables, STOP and report BLOCKED.
- Do not harden or edit `tests/core/transitions.test.mjs`.
- Do not edit `tests/db/reducers-fuel.test.mjs`, including its test titles.
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
