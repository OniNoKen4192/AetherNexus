# TASK: rung-command-http-and-cli

## Meta
- **Task ID**: V1-SCHEDULER.04
- **Parent plan**: docs/superpowers/plans/2026-11-15-v1-scheduler.md
- **Depends on**: V1-SCHEDULER.03
- **Estimated scope**: M
- **Model hint**: terra

## Objective
The trust rung can be changed over HTTP (`POST /api/commands/config.automation`) and from the terminal (`nexus config set trust <level>`).

## Context
`setAutomationLevel` (task V1-SCHEDULER.03, merged) does all the work: validation, the safe file write, the log event. This task adds the two thin wrappers. One decision matters: the HTTP field `level` is a free string, not restricted to the three selectable values in the command table, because a rung that exists but is not available yet (`highways`, `autopilot`) must come back as a `409` carrying `setAutomationLevel`'s own explanation, not as a generic `400 invalid value`. The parent plan put the new test cases into the two existing test files; this spec puts them into two new files instead so the acceptance command is red before the work starts. Affected workflow IDs is `none` because this project has no review suite.

## Files

### Touch
| Path | Action | Notes |
|------|--------|-------|
| `tests/http/commands-automation.test.mjs` | create | HTTP acceptance tests, written first |
| `tests/cli/config-trust.test.mjs` | create | CLI acceptance tests, written first |
| `src/server/http/commands.ts` | modify | one new entry in `COMMANDS`, one import |
| `src/cli/run.ts` | modify | `config` command, one `USAGE` line |

### Do NOT touch
- `src/server/commands/config.ts` — owned by task V1-SCHEDULER.03 (merged); call it, do not change it
- `tests/http/commands.test.mjs`, `tests/cli/cli.test.mjs`, `tests/http/helpers.mjs`, `tests/helpers.mjs`, `tests/fixtures/**` — use them, do not edit them
- In `src/server/http/commands.ts`: `validate`, `runCommand`, `errorResponse` and every existing `COMMANDS` entry
- In `src/cli/run.ts`: every existing command's behaviour, output and exit code
- `src/server/http/server.ts`, `src/server/http/runner.ts`, `src/server/scheduler/**`, `src/server/commands/query.ts` — owned by later tasks
- `web/**` — owned by tasks V1-SCHEDULER.08 and .09
- Any file not listed under Touch. If completing the objective seems to require touching an unlisted file, STOP and report BLOCKED.

**Standing exclusions:**
- Security-routed files, never modified by this lane: `src/core/git.ts`, `src/validate/**`, `src/providers/claude-sdk/gate-hook.ts`, `src/server/dispatch.ts`, `src/db/migrations/**`, `src/server/http/auth.ts`, `src/server/lock.ts`
- Pipeline-owned paths: `docs/superpowers/plans/**`, `docs/superpowers/tasks/**`, `.superpowers/sdd/**`
- `package.json`, `package-lock.json` — no dependency changes

## Interfaces

Produced:

```text
HTTP   POST /api/commands/config.automation     body { "level": "<non-empty string>" }
       200 { "result": { "level": "...", "from": "...", "changed": true|false } }
       409 { "error": "<setAutomationLevel's refusal message>" }        unavailable or unknown level, broken config file
       400 { "error": "..." }                                           missing level, non-string or empty level, unexpected field

CLI    nexus config set trust <level>
       stdout  rung: <from> -> <level>          when changed
               rung: <level> (unchanged)        when not changed
       --json  prints the result object { level, from, changed }
       exit 0 ok; exit 2 on a Refusal (message on stderr); exit 1 with the usage text for any other `config` form
USAGE gains the line:   config set trust <manual|verdicts|roundabout>
```

```ts
// src/server/http/commands.ts — new COMMANDS entry, in the style of "config.roles"
"config.automation": { fields: { level: s() }, run: (g, _r, i) => setAutomationLevel(g, i as Parameters<typeof setAutomationLevel>[1]) },
```

Consumed (exact current signatures; do not change them):

```ts
// src/server/commands/config.ts
export function setAutomationLevel(g: Galaxy, input: { level: string }): { level: "manual" | "verdicts" | "roundabout"; from: string; changed: boolean };
// throws Refusal: `'<level>' is not available yet — it arrives in a later release` | `level must be manual, verdicts or roundabout` | config-file refusals
// src/server/http/commands.ts
type Field = { type: "string" | "integer" | "strings"; optional?: true; values?: readonly string[] };
const s = (optional = false, values?: readonly string[]): Field;      // a string field rejects non-strings and "" with 400
// errorResponse maps Refusal → 409 { error }, BadRequest → 400, UnknownCommand → 404
// src/cli/run.ts
// run(): commands that need a galaxy are listed in
//   if (!["system", "planet", "moon", "voyage", "status", "events", "fleet", "db", "validate", "decision", "serve"].includes(c0)) throw new Usage();
// dispatch(g, pos, o, out): a switch on `${c0} ${c1}`;  out(result, () => "<human line>") prints JSON under --json, else the line
// class Usage extends Error {}   → prints USAGE, exit code 1;  Refusal → message on stderr, exit code 2
```

Test helpers:

```js
// tests/http/helpers.mjs
export async function startWorld(script, patchConfig, opts = {})   // → { w, srv, webRoot, origin, api, close }
// api(path, { method, body, headers }) → resolves to the response (see tests/http/commands.test.mjs for its shape: status and parsed JSON body)
// GET /api/snapshot → { rung, ... }
// tests/cli/cli.test.mjs shows the CLI pattern (copy it into the new file, do not import from a test file):
//   const CLI = path.join(repoRoot, "dist", "cli", "main.js");
//   spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, NEXUS_FAKE_SCRIPTS: path.join(repoRoot, "tests", "fixtures", "scripts") } })
//   makeRepo() from tests/helpers.mjs → { dir, git, cleanup };  `nexus init` then commit, as that file's first test does
```

## Constraints
- Both wrappers are thin: no validation of the level beyond what the table's string field and `setAutomationLevel` already do.
- Do not give the `level` field a `values` list.
- A fresh `nexus init` galaxy has rung `manual`.
- No new dependencies. Node ≥ 22.13, ES modules, TypeScript strict.
- Tests use `node:test` and `node:assert/strict`, close servers and clean up temp repos in `finally`.

## Acceptance

**Test command (must exit 0):**
```bash
npm test -- "tests/http/commands-automation.test.mjs" "tests/cli/config-trust.test.mjs"
```

**Behavioral criteria** (each must be covered by a test in one of the two new files):
1. HTTP: `config.automation` with `{ level: "verdicts" }` answers 200 with `result.level === "verdicts"`, `result.from === "manual"`, `result.changed === true`; a following `GET /api/snapshot` has `rung === "verdicts"`.
2. HTTP: `{ level: "autopilot" }` answers 409 and `error` matches `/not available yet/`; `{ level: "turbo" }` answers 409 and `error` matches `/level must be/`.
3. HTTP: `{}`, `{ level: 3 }` and `{ level: "" }` each answer 400.
4. HTTP: `{ level: "verdicts", extra: 1 }` answers 400.
5. CLI: `config set trust verdicts` exits 0 with stdout `rung: manual -> verdicts` and `.nexus/config.json` on disk has `automation.level === "verdicts"`; running it again prints `rung: verdicts (unchanged)`.
6. CLI: `config set trust verdicts --json` prints a JSON object with `level`, `from`, `changed`.
7. CLI: `config set trust autopilot` exits 2 and stderr matches `/not available yet/`.
8. CLI: `config`, `config set` and `config set trust` (no level) each exit 1 and print the usage text, which contains `config set trust <manual|verdicts|roundabout>`.

**Affected workflow IDs**: none

**Regression guard (task level — implementer runs this):**
```bash
npm test
```

## Out of Scope
- No other `config` subcommands (no `get`, no other keys).
- No page changes; no scheduler.
- Do not update documentation (CLAUDE.md is handled in a later task).
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
