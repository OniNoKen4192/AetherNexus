# TASK: fuel-codex-session-id-and-hermetic-tests

## Meta
- **Task ID**: V1-FUEL.05-FIX1
- **Parent plan**: docs/superpowers/plans/2026-11-15-v1-fuel.md
- **Depends on**: V1-FUEL.05 (round 0, committed as wip in the same worktree)
- **Estimated scope**: S
- **Model hint**: sol

## Objective
Three things are wrong on the round-0 tree:
1. On a `codex-reply` round whose tool result carries no thread id, the `done` event now carries `session_id: job.previousSessionId`. At commit b7a0ec3 it carried no `session_id`, and it must again.
2. Running `tests/providers/codex-mcp.test.mjs` lists the user's real Codex home (`~/.codex/sessions`, or `$CODEX_HOME/sessions`). No test in that file may list, stat or open anything there.
3. The criterion-11 test compares event kinds only, so it cannot notice a changed `done` event.

## Context
The fallback to `job.previousSessionId` exists only to locate the session log for fuel readings. `done.data.session_id` is stored and becomes the next round's resume id (`src/server/dispatch.ts`, `src/server/commands/launch.ts`), so it must be exactly what the base commit produced. In the original spec, "existing ones keep passing unchanged" protects the existing assertions; it does not forbid pointing the test file's default sessions root somewhere empty. `fuel.ts` and its tests passed review and are not part of this fix. Do not relitigate anything else in V1-FUEL.05. Affected workflow IDs is `none` because this project has no review suite.

## Files

### Touch
| Path | Action | Notes |
|------|--------|-------|
| `tests/providers/codex-mcp.test.mjs` | modify | isolate the file from the real Codex home; add the tests under Acceptance; strengthen the criterion-11 test |
| `src/providers/codex-mcp/index.ts` | modify | only the thread-id lines inside `dispatch` |

### Do NOT touch
- `src/providers/codex-mcp/fuel.ts`, `tests/providers/codex-fuel.test.mjs` — passed review
- `tests/fixtures/codex-sessions/**`, `tests/helpers.mjs`
- `src/providers/adapter.ts`, `src/providers/fake/**`, `src/providers/index.ts`, `src/providers/claude-sdk/**`
- Any file not listed under Touch. If the fix seems to need one, STOP and report BLOCKED.

**Standing exclusions:**
- Security-routed files, never modified by this lane: `src/core/git.ts`, `src/validate/**`, `src/providers/claude-sdk/gate-hook.ts`, `src/server/dispatch.ts`, `src/db/migrations/**`, `src/server/http/auth.ts`, `src/server/lock.ts`
- Pipeline-owned paths: `docs/superpowers/plans/**`, `docs/superpowers/tasks/**`, `.superpowers/sdd/**`
- `package.json`, `package-lock.json` — no dependency changes

## Interfaces
```ts
// src/providers/codex-mcp/index.ts, inside dispatch — two distinct values, never merged:
//   reported : string | undefined = structuredContent.threadId when it is a string, else the body match
//              (exactly the expression at b7a0ec3). The ONLY source of done.data.session_id.
//   for the log lookup only: reported ?? job.previousSessionId -> readCodexFuel(sessionsRoot, <that>)
// done:  { kind: "done", ts, data: { report, ...(reported ? { session_id: reported } : {}) } }
// Unchanged from round 0: Deps, errEvent, where readings are yielded, resets_at on a rate_limited error, the catch path.
```

## Constraints
- **Hermetic test file.** Every adapter in `tests/providers/codex-mcp.test.mjs` whose `dispatch` runs must resolve its sessions root to a place the test owns. Either is acceptable:
  - set `process.env.CODEX_HOME` to a fresh empty temp directory at the top of the file, before any test runs, and remove the directory at the end (preferred: the ten existing tests stay byte-identical); or
  - pass `sessionsRoot` in each adapter construction.
- No existing `assert.*` line may be changed or removed. The only edit allowed inside an existing test is adding `sessionsRoot` to its `createCodexAdapter(...)` call. The one exception is the round-0 criterion-11 test ("empty sessions root preserves existing event sequence"), which criterion 4 below replaces.
- New tests compare against literal expected values written in the test, never values computed by the adapter under test. `ts` is the only field that may be stripped before comparing.
- No new dependencies. Tests import from `dist/`.

## Acceptance

**Test commands (all three must exit 0; run from the repo root, in this order — the second and third read the `dist/` built by the first):**
```bash
npm test -- "tests/providers/codex-*.test.mjs"
```
```bash
node -e "const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),m=require('node:module');const real=path.resolve(process.env.CODEX_HOME||path.join(os.homedir(),'.codex')).toLowerCase();let hits=0;for(const n of ['readdirSync','opendirSync','statSync','lstatSync','openSync','readFileSync','existsSync','accessSync']){const o=fs[n];fs[n]=function(...a){if(typeof a[0]=='string'&&path.resolve(a[0]).toLowerCase().startsWith(real)){hits++;const e=new Error('ENOENT: blocked by the hermeticity check');e.code='ENOENT';throw e}return o.apply(this,a)}}m.syncBuiltinESMExports();process.on('exit',()=>{console.log(hits+' file-system call(s) on the real Codex home (want 0)');if(hits)process.exitCode=1});import('./tests/providers/codex-mcp.test.mjs')"
```
```bash
node --input-type=module -e "import {createCodexAdapter} from './dist/providers/codex-mcp/index.js';const id='01a1e11a-deaf-7e60-a634-bf3cc2f96ec0';const c={async connect(){},async listTools(){return {tools:[]}},async callTool(){return {content:[{type:'text',text:'STATUS: IMPLEMENTED'}]}},async close(){}};const a=createCodexAdapter('codex',{adapter:'codex-mcp'},{makeClient:async()=>c,sessionsRoot:'tests/fixtures/codex-sessions'});let fuel=0,done;for await(const e of a.dispatch({voyageId:'v',role:'implement',specPath:'s',specText:'',prompt:'p',round:2,previousSessionId:id},{cwd:process.cwd(),touch:[],timeoutMs:5000,signal:new AbortController().signal})){if(e.kind=='fuel')fuel++;if(e.kind=='done')done=e}const ok=fuel==2&&done&&('session_id' in done.data)==false;console.log('fuel events: '+fuel+' (want 2); done.session_id: '+(done&&done.data.session_id)+' (want undefined)');process.exit(ok?0:1)"
```
- The second command runs the test file with every file-system call on the real Codex home blocked and counted. It never lists the home itself.
- Verified by the reviewer on the round-0 tree: the second exits 1 ("4 file-system call(s) on the real Codex home (want 0)") and the third exits 1 ("done.session_id: 01a1e11a-deaf-7e60-a634-bf3cc2f96ec0 (want undefined)").
- The first currently exits 0 (23 tests) and must stay 0.

**Behavioral criteria** (2 to 5 are tests in `tests/providers/codex-mcp.test.mjs`):
1. The whole of `tests/providers/codex-mcp.test.mjs` makes no file-system call on the real Codex home (second command).
2. Reply round (`round: 2`, `previousSessionId` = the fixture id), result with no thread id in `structuredContent` or the body, `sessionsRoot` = the fixture root: the event kinds end `"fuel", "fuel", "done"`, and `"session_id" in done.data` is `false`.
3. Reply round, `isError` result whose text matches the rate-limit signal and carries no thread id, `previousSessionId` = the fixture id, `sessionsRoot` = the fixture root: events end `"fuel", "fuel", "error"`, and the error is `rate_limited` with `resets_at` equal to `new Date(1794760000000).toISOString()`.
4. Replacement for the round-0 criterion-11 test. `sessionsRoot` = an empty temp directory, default stub, `baseJob`: the events with `ts` removed deep-equal exactly `[{ kind: "text", data: { text: "dispatching to codex mcp-server (tool codex, sandbox workspace-write)" } }, { kind: "done", data: { report: { status: "IMPLEMENTED", raw: "STATUS: IMPLEMENTED" }, session_id: "th-1" } }]`.
5. Same empty root, reply round (`previousSessionId: "th-0"`), result `{ content: [{ type: "text", text: "STATUS: IMPLEMENTED" }] }`: the events with `ts` removed deep-equal exactly `[{ kind: "text", data: { text: "dispatching to codex mcp-server (tool codex-reply, sandbox workspace-write)" } }, { kind: "done", data: { report: { status: "IMPLEMENTED", raw: "STATUS: IMPLEMENTED" } } }]`.
6. The round-0 tests for criteria 10, 12 and 13, and all ten pre-existing tests, still pass with their assertions unchanged.

**Affected workflow IDs**: none

**Regression guard (task level — implementer runs this):**
```bash
npm test
```

## Out of Scope
- Do not change `fuel.ts`, the chunked reader, or its tests. The chunk-boundary decoding was checked and is not a defect.
- Do not change how the next round resumes a session, and do not make `done` carry a session id it did not carry at b7a0ec3.
- Do not call the real `codex` binary, read the real `~/.codex`, or add a live test.
- Do not update documentation. Do not fix unrelated failing tests — report them instead.

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
