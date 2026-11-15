# TASK: rung-command-and-config-reload

## Meta
- **Task ID**: V1-SCHEDULER.03
- **Parent plan**: docs/superpowers/plans/2026-11-15-v1-scheduler.md
- **Depends on**: V1-SCHEDULER.02
- **Estimated scope**: M
- **Model hint**: sol

## Objective
The trust rung (`automation.level` in `.nexus/config.json`) can be set to `manual`, `verdicts` or `roundabout` through one command function that writes the file safely and records the change in the event log, and a galaxy can re-read its config from disk without ever ending up with a broken one.

## Context
The rung decides how much a coming scheduler does by itself. Until now it could only be changed by editing the file and restarting. The change must be visible to a running server even when another process (the CLI) made it, which is why a `config.changed` event carrying the writer's `pid` is appended: a server that sees one from a foreign pid calls `reloadConfig`. `highways` and `autopilot` are valid values in the schema but their behaviour does not exist yet, so they cannot be *selected*; a file that already says one of them still loads. `setRoleOrder` in the same file already has the exact safe-write procedure (start from the file on disk, not the in-memory copy, so a hand edit is never overwritten; refuse a broken file without writing; record the write as the system's own with `recordTreeWrite`; temp file + rename; swap `g.config` last) — reuse it through one private helper rather than copying it. The event kind `config.changed` is already registered as log-only (task V1-SCHEDULER.01). Affected workflow IDs is `none` because this project has no review suite.

## Files

### Touch
| Path | Action | Notes |
|------|--------|-------|
| `tests/server/config-automation.test.mjs` | create | the acceptance tests, written first |
| `src/server/commands/config.ts` | modify | `setAutomationLevel`, `reloadConfig`, one private helper shared with `setRoleOrder` |

### Do NOT touch
- `tests/server/config-roles.test.mjs` — it must stay green unmodified: `setRoleOrder`'s behaviour and every message it produces must not change
- `src/config/schema.ts` — use `normalizeConfig` / `validateConfig` as they are
- `src/server/commands/park.ts`, `launch.ts`, `query.ts`, `deps.ts`, `src/core/transitions.ts`, `src/db/reducers/**` — owned by tasks V1-SCHEDULER.01 and .02 (merged)
- `src/server/http/**`, `src/cli/**` — owned by task V1-SCHEDULER.04
- `src/server/scheduler/**`, `web/**` — owned by later tasks
- Any file not listed under Touch. If completing the objective seems to require touching an unlisted file, STOP and report BLOCKED.

**Standing exclusions:**
- Security-routed files, never modified by this lane: `src/core/git.ts`, `src/validate/**`, `src/providers/claude-sdk/gate-hook.ts`, `src/server/dispatch.ts`, `src/db/migrations/**`, `src/server/http/auth.ts`, `src/server/lock.ts`
- Pipeline-owned paths: `docs/superpowers/plans/**`, `docs/superpowers/tasks/**`, `.superpowers/sdd/**`
- `package.json`, `package-lock.json` — no dependency changes

## Interfaces

Produced:

```ts
// src/server/commands/config.ts
export type SelectableRung = "manual" | "verdicts" | "roundabout";
export function setAutomationLevel(g: Galaxy, input: { level: string }): { level: SelectableRung; from: string; changed: boolean };
/** Re-read .nexus/config.json into g.config. On any error g.config is left untouched. */
export function reloadConfig(g: Galaxy): { ok: true } | { ok: false; error: string };

// event appended by setAutomationLevel after a successful write (and only then):
// append(g.db, { kind: "config.changed", payload: { key: "automation.level", from, to: level, pid: process.pid } })
```

Consumed (exact current signatures; do not change them):

```ts
// src/config/schema.ts
export function validateConfig(cfg: unknown): string[];            // [] when valid
export function normalizeConfig(cfg: unknown): NexusConfig;        // throws on an invalid config
// NexusConfig["automation"]: { level: "manual" | "verdicts" | "roundabout" | "highways" | "autopilot"; max_fix_rounds: number }
// src/server/dispatch.ts  (import only)
export function recordTreeWrite(g: Galaxy, paths: string[]): void; // appends tree.written { paths }
// src/db/events.ts
export function append(db: NexusDb, ev: NexusEvent, precheck?: () => void): EventRow;
// src/server/errors.ts
export class Refusal extends Error { constructor(message: string, details?: Record<string, unknown>) }
// src/server/commands/config.ts  (existing, behaviour frozen)
export function setRoleOrder(g: Galaxy, input: { role: "implement" | "review"; order: string[] }): { roles: NexusConfig["roles"] };
// its messages: `.nexus/config.json is not valid JSON: <parser message>` ; validateConfig(file).join("; ") for a non-object or invalid file
```

Test reference: `tests/server/config-roles.test.mjs` shows how to build the galaxy, edit the file by hand and compare file bytes.

## Constraints
- `setAutomationLevel` starts from the file on disk exactly as `setRoleOrder` does: parse; refuse if not valid JSON, not a plain object, or not a valid config; clone; change one key; validate the candidate; `recordTreeWrite(g, [".nexus/config.json"])`; write a temp file with flag `wx` and rename it over the config; set `g.config = normalizeConfig(candidate)`. The part both functions share lives in one private helper in this file.
- It preserves every other key of the file, including `automation.max_fix_rounds`; it creates the `automation` block if the file has none (the value written for `max_fix_rounds` is then whatever `normalizeConfig` gives for the file).
- The level check and the file checks may run in either order. Nothing is written and no event is appended on any refusal.
- Refusals, exact text: level `highways` or `autopilot` → `'<level>' is not available yet — it arrives in a later release`; any other value outside the three → `level must be manual, verdicts or roundabout`.
- `from` is the level the file had (`manual` when the file has none). If `from === level`: no write, no `tree.written`, no `config.changed`, result `changed: false`. If `from` is `highways` or `autopilot` and a selectable level is requested, the change proceeds normally.
- `reloadConfig` returns `{ ok: false, error }` for a missing file, invalid JSON, a non-object or a config that does not validate; `error` is non-empty and, for the cases `setRoleOrder` also refuses, carries the same message text. It appends no event and writes nothing.
- No new SQL, no new dependencies. Node ≥ 22.13, ES modules, TypeScript strict.
- Tests use `node:test` and `node:assert/strict`, import compiled code from `dist/`, and clean up in `finally`.

## Acceptance

**Test command (must exit 0):**
```bash
npm test -- "tests/server/config-*.test.mjs"
```

**Behavioral criteria** (each must be covered by a test in `tests/server/config-automation.test.mjs`):
1. Setting `verdicts`, then `roundabout`, then `manual`: each call returns `{ level, from, changed: true }` with the right `from`; `g.config.automation.level` matches; the file on disk matches; `automation.max_fix_rounds` and `roles` in the file are unchanged.
2. The last event after a change has `kind === "config.changed"` and payload `{ key: "automation.level", from: "manual", to: "verdicts", pid: process.pid }`.
3. Setting the current rung: `changed === false`, file bytes identical, no new event.
4. `highways` and `autopilot` are refused with a message matching `/is not available yet/`; file bytes identical.
5. `"turbo"` and `""` are refused with `/level must be manual, verdicts or roundabout/`.
6. With the file overwritten by `{ not json`: a `Refusal` whose message includes `.nexus/config.json is not valid JSON`; file bytes identical; `g.config` unchanged.
7. A hand edit survives: reverse `roles.implement` in the file by hand (the fixture needs two providers there; if it has one, hand-edit another harmless key such as `server.port`), call `setAutomationLevel`; the hand edit is still in the file.
8. A `tree.written` event whose `paths` contains `.nexus/config.json` precedes the `config.changed` event.
9. `reloadConfig` after `automation.level` is edited in the file → `{ ok: true }` and `g.config.automation.level` follows.
10. `reloadConfig` with an invalid file → `{ ok: false, error }` with a non-empty `error`; `g.config` deep-equals what it was.
11. `tests/server/config-roles.test.mjs` passes unmodified (it is part of the test command).

**Affected workflow IDs**: none

**Regression guard (task level — implementer runs this):**
```bash
npm test
```

## Out of Scope
- No HTTP command, no CLI command, no caller of `reloadConfig` (later tasks).
- Do not change the config schema or its defaults.
- Do not make `highways` / `autopilot` selectable.
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
