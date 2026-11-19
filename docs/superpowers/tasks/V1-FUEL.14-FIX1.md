# TASK: fuel-gauge-test-cleanup

## Meta
- **Task ID**: V1-FUEL.14-FIX1
- **Parent plan**: docs/superpowers/plans/2026-11-15-v1-fuel.md
- **Depends on**: V1-FUEL.14 round 0 (in this worktree)
- **Estimated scope**: S
- **Model hint**: terra

## Objective
Three things are wrong in `tests/http/page-fuel.test.mjs`, and nothing else:
1. Every run leaves a directory `aether-fuel-XXXXXX` behind in the operating system's temp directory.
2. The compiled module is imported as `out/gauge.js`, so Node has to guess its module type. With a `package.json` containing `"type": "commonjs"` in any directory above the temp directory, the file fails to load with `SyntaxError: Unexpected token 'export'` and no test runs.
3. Two assertions pass whatever the code does: `meterValue({ state: "dry" })` is 0 even if `dry` wrongly returns `remaining`, and `fleet.includes("aria-label")` was already true before the gauge existed (the retire input has one).

## Context
The page work of V1-FUEL.14 is reviewed and correct; this round changes the test file only. The original spec asked for `typescript`'s `transpileModule`; that function does not exist in the installed `typescript` 7.x, so compiling with the `tsc` CLI is accepted and stays. Do not import the `typescript` package and do not look for another compiler.

## Files

### Touch
| Path | Action | Notes |
|------|--------|-------|
| `tests/http/page-fuel.test.mjs` | modify | the setup lines above `const nowMs`, plus two added assertions |

### Do NOT touch
- `web/src/gauge.ts`, `web/src/types.ts`, `web/src/components/Fleet.tsx`, `web/src/style.css` — reviewed; no change of any kind
- Every other test file, including `tests/http/helpers.mjs` and `tests/http/page-fleet.test.mjs`
- Anything under `src/`
- Any file not listed under Touch. If the objective seems to need another file, STOP and report BLOCKED.

**Standing exclusions:**
- Security-routed files, never modified by this lane: `src/core/git.ts`, `src/validate/**`, `src/providers/claude-sdk/gate-hook.ts`, `src/server/dispatch.ts`, `src/db/migrations/**`, `src/server/http/auth.ts`, `src/server/lock.ts`
- Pipeline-owned paths: `docs/superpowers/plans/**`, `docs/superpowers/tasks/**`, `.superpowers/sdd/**`
- `package.json`, `package-lock.json` — no dependency changes

## Interfaces
None change. The test still obtains `ageText`, `timeText`, `gaugeText`, `familyLines`, `meterValue` from the compiled copy of `web/src/gauge.ts`.

## Constraints
- Keep the compile step: the project's `tsc` at `node_modules/typescript/bin/tsc`, run with `process.execPath`, in a directory made with `mkdtemp` under `os.tmpdir()` with the prefix `aether-fuel-`, with the stub `types.ts`.
- The imported file has the `.mjs` extension. Naming the copied source `gauge.mts` (and listing it in the temporary `tsconfig.json`) makes `tsc` emit `out/gauge.mjs`; import that.
- Remove the temporary directory synchronously (`rmSync(dir, { recursive: true, force: true })` from `node:fs`) in a `finally` that runs right after the import, so it is also removed when `tsc` throws. No `process.on("exit")` handler and no asynchronous `rm` for this.
- The eleven tests keep their names, their order and every existing assertion. Add exactly two assertions:
  - in `meterValue`: `meterValue({ state: "dry", remaining: 0.5 })` is `0`;
  - in `the page uses the fuel gauge declarations`: the `<meter` tag itself carries the label — `Fleet.tsx` matches `/<meter\b[^>]*aria-label=/`.
- No new dependencies, no child process other than the one `tsc` run, no other files written.

## Acceptance

**Test commands (both must exit 0; run the first one first, it builds `dist/`):**
```bash
npm test -- "tests/http/page-*.test.mjs"
node -e "const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');const d=fs.mkdtempSync(path.join(os.tmpdir(),'fuel-accept-'));fs.writeFileSync(path.join(d,'package.json'),JSON.stringify({type:'commonjs'}));const t=path.join(d,'t');fs.mkdirSync(t);const r=cp.spawnSync(process.execPath,['--disable-warning=ExperimentalWarning','--test','tests/http/page-fuel.test.mjs'],{env:{...process.env,TEMP:t,TMP:t,TMPDIR:t},encoding:'utf8'});const left=fs.readdirSync(t);fs.rmSync(d,{recursive:true,force:true});const ok=r.status===0&&left.length===0;console.log(ok?'OK':'FAIL: test exit '+r.status+', left in temp: '+JSON.stringify(left));process.exit(ok?0:1)"
```
The second command points the temp directory at a fresh folder that sits under a `"type": "commonjs"` `package.json`, runs the fuel test there, and requires exit 0 and an empty folder afterwards. Today it prints `FAIL: test exit 1, left in temp: ["aether-fuel-…"]`.

**Behavioral criteria:**
1. After the test file has run, no `aether-fuel-*` entry it created remains in `os.tmpdir()` — also when the `tsc` step fails.
2. The file passes when a `package.json` with `"type": "commonjs"` sits above the temp directory.
3. The suite still reports 38 tests, 38 pass for the first command, with the same eleven fuel test names.
4. The two added assertions are present (the reviewer re-runs two mutations: a `dry` meter that returns `remaining`, and a `<meter>` without `aria-label`; both must now fail the suite).

**Affected workflow IDs**: none

**Regression guard (task level — implementer runs this):**
```bash
npm test
```

## Out of Scope
- No change to what the eleven tests assert beyond the two additions; no new tests.
- No change to `gauge.ts`, the page or the styles, even where a review note mentions them.
- Do not delete the `aether-fuel-*` directories earlier runs left in the temp directory.
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
