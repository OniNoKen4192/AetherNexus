# TASK: fuel-codex-readings-from-session-log

## Meta
- **Task ID**: V1-FUEL.05
- **Parent plan**: docs/superpowers/plans/2026-11-15-v1-fuel.md
- **Depends on**: V1-FUEL.04
- **Estimated scope**: M
- **Model hint**: sol

## Objective
After a Codex call, the Codex adapter reports the provider's own rate-limit snapshot for that session as `fuel` events, read from Codex's local session log, and attaches a reset time to a rate-limit error when it knows one.

## Context
Slice 2 of v1: fuel readings and a limiter. Readings are *reported only*. The Codex MCP tool result carries no rate-limit information, but the Codex CLI writes a log file per session, and that log contains the same `rate_limits` snapshot the CLI shows. The adapter already learns the session's thread id from the tool result; the log file's name ends with that id, so the adapter can find the file and read the newest snapshot without any extra call to the provider. This must never make a voyage worse: if the log is missing, unreadable or half-written, the adapter produces no reading and everything else happens exactly as before. Session logs contain the user's prompts — read only the `rate_limits` object and never copy other content into events, messages or fixtures. Affected workflow IDs is `none` because this project has no review suite.

## Files

### Touch
| Path | Action | Notes |
|------|--------|-------|
| `tests/providers/codex-fuel.test.mjs` | create | `readCodexFuel`, `codexSessionsRoot` |
| `tests/providers/codex-mcp.test.mjs` | modify | add adapter-level tests; existing ones keep passing unchanged |
| `src/providers/codex-mcp/fuel.ts` | create | |
| `src/providers/codex-mcp/index.ts` | modify | `Deps.sessionsRoot`, yield readings, `resets_at` on the error |

### Do NOT touch
- `tests/fixtures/codex-sessions/**` — the fixture session log is already in the repo (hand-written, no prompt text); use it, and write any other log your tests need into a temp directory
- `src/providers/adapter.ts`, `src/providers/fake/**`, `src/providers/index.ts` — owned by V1-FUEL.03
- `src/providers/claude-sdk/**` — owned by V1-FUEL.04 (`gate-hook.ts` is security-routed)
- Any file not listed under Touch. If completing the objective seems to require touching an unlisted file, STOP and report BLOCKED.

**Standing exclusions:**
- Security-routed files, never modified by this lane: `src/core/git.ts`, `src/validate/**`, `src/providers/claude-sdk/gate-hook.ts`, `src/server/dispatch.ts`, `src/db/migrations/**`, `src/server/http/auth.ts`, `src/server/lock.ts`
- Pipeline-owned paths: `docs/superpowers/plans/**`, `docs/superpowers/tasks/**`, `.superpowers/sdd/**`
- `package.json`, `package-lock.json` — no dependency changes

## Interfaces

Produced:

```ts
// src/providers/codex-mcp/fuel.ts
/** Readings from the newest rate_limits snapshot in the session log of `threadId`; [] when there is none or it cannot be read. Never throws. */
export function readCodexFuel(sessionsRoot: string, threadId: string): AgentEvent[];
/** $CODEX_HOME/sessions when CODEX_HOME is set and non-empty, else <os.homedir()>/.codex/sessions. */
export function codexSessionsRoot(env: NodeJS.ProcessEnv): string;

// src/providers/codex-mcp/index.ts
type Deps = { makeClient?: /* unchanged */; sessionsRoot?: string };   // default: codexSessionsRoot(process.env)
```

Consumed:

```ts
// src/providers/adapter.ts (after V1-FUEL.03)
| { kind: "fuel"; ts: string; data: { window: string; used: number; resets_at?: string; model_family?: string } }   // used 0..1
| { kind: "error"; ts: string; data: { classification: ErrorClass; message: string; raw?: unknown; resets_at?: string; model_family?: string } }
// src/providers/codex-mcp/index.ts today, inside dispatch after the tool call:
//   const body = textOf(result);
//   if (result.isError) { yield errEvent(classify(body), body); return; }
//   … file_changed events …
//   const threadId = typeof sc?.threadId === "string" ? sc.threadId : body.match(/threadId["':\s=]+([\w-]+)/)?.[1];
//   yield { kind: "done", … session_id: threadId }
```

Facts about the log (verified on codex-cli 0.145.0):

```text
file:  <sessionsRoot>/YYYY/MM/DD/rollout-<timestamp>-<thread id>.jsonl      one JSON object per line
a line carrying a snapshot:
{"timestamp":"…","type":"event_msg","payload":{"type":"token_count","info":{…},"rate_limits":{"limit_id":"codex","limit_name":null,
  "primary":{"used_percent":22.0,"window_minutes":10080,"resets_at":1795186480},"secondary":null,"credits":{…},"plan_type":"plus","rate_limit_reached_type":null}}}
primary and secondary have the same shape; either may be null; resets_at is in SECONDS since the epoch.
fixture: tests/fixtures/codex-sessions/2026/11/15/rollout-2026-11-15T15-26-41-01a1e11a-deaf-7e60-a634-bf3cc2f96ec0.jsonl
  line 1 session_meta; line 2 snapshot primary 22.0% of 10080 min, secondary null;
  line 3 snapshot primary 23.5% of 10080 min (resets_at 1795186480), secondary 61.0% of 300 min (resets_at 1794760000)
```

## Constraints
- **Finding the file:** a file under `sessionsRoot` (any depth of the `YYYY/MM/DD` layout) whose name ends with `-<threadId>.jsonl`. If several match, the one with the newest modification time. A `threadId` that is empty or contains anything other than letters, digits, `-` and `_` yields `[]` without touching the file system (it is used in a file-name match; never build a path from it).
- **Finding the snapshot:** the last line of the file that parses as JSON and has an object at `payload.rate_limits`. Do not depend on the outer `type` or `payload.type` values. A last line cut off mid-JSON is skipped and the previous snapshot is used.
- **Size:** read the file at most once; for a large file prefer reading from the end in chunks so a 5 MB log is not parsed line by line from the start when the snapshot is near the end. A snapshot line is far smaller than 64 KB.
- **Events:** one `fuel` event per non-null window, `primary` first: `window = "<window_minutes>m"`, `used = used_percent / 100` clamped to 0..1, `resets_at` = ISO string from `resets_at * 1000` when it is a finite positive number. A window whose `used_percent` is not a finite number is dropped; a negative one is clamped to 0. A window whose `window_minutes` is not a finite positive number uses `window: "unknown"`.
- **In `dispatch`:** the thread id is the one the adapter already derives, falling back to `job.previousSessionId`. On success the readings are yielded after the `file_changed` events and before `done`. When the tool result is an error, the readings are yielded before the error event (thread id from `structuredContent.threadId`, the body match, or `job.previousSessionId`; none → no readings); and when that error classifies as `rate_limited`, the error event carries `resets_at` from the window with the highest `used` among the readings just read (none read → no `resets_at`). The thrown-error path (`catch`) is unchanged.
- `readCodexFuel` never throws, whatever is on disk; `dispatch` must also survive it throwing (belt and braces).
- No new dependencies; `node:fs`, `node:os`, `node:path` only. Tests import from `dist/`.

## Acceptance

**Test command (must exit 0):**
```bash
npm test -- "tests/providers/codex-*.test.mjs"
```

**Behavioral criteria** (1–9 in `codex-fuel.test.mjs`, 10–13 in `codex-mcp.test.mjs`):
1. On the fixture and its thread id: exactly two events, `{ window: "10080m", used: 0.235, resets_at: new Date(1795186480000).toISOString() }` then `{ window: "300m", used: 0.61, resets_at: new Date(1794760000000).toISOString() }` — the newest snapshot wins and `secondary` is read.
2. A log whose only snapshot has `secondary: null` gives one event.
3. Root directory missing → `[]`. No file for the thread id → `[]`. A file with no `rate_limits` line → `[]`.
4. A log whose last line is cut mid-JSON gives the previous snapshot's readings.
5. A 5 MB log (padding lines, snapshot near the end, then a few more non-snapshot lines) returns the snapshot's readings; assert the result, and that the function completes (no assertion on timing).
6. `used_percent` of `"x"` → that window is dropped; `-3` → `used` 0; `250` → `used` 1.
7. A thread id of `""`, `"../x"`, `"a/b"`, `"*"` → `[]`.
8. Two files ending with the same thread id (different day folders) → the newer file's snapshot is used.
9. `codexSessionsRoot({ CODEX_HOME: "/x" })` is `path.join("/x", "sessions")`; with `CODEX_HOME` unset or empty it is `path.join(os.homedir(), ".codex", "sessions")`.
10. Adapter with `sessionsRoot` set to the fixture root and a tool result whose `structuredContent.threadId` is the fixture's id: the event kinds end `…, "fuel", "fuel", "done"`.
11. Adapter with `sessionsRoot` pointing at an empty temp directory: no `fuel` event, and the events are exactly what they are today.
12. `isError` result whose text matches the rate-limit signal and names the fixture's thread id in `structuredContent`: events end `"fuel", "fuel", "error"`, the error is `rate_limited` with `resets_at` equal to the 300-minute window's (it is the fuller one, 61%).
13. `isError` with no thread id anywhere: no `fuel` event and an error without `resets_at`.

**Affected workflow IDs**: none

**Regression guard (task level — implementer runs this):**
```bash
npm test
```

## Out of Scope
- Do not call the real `codex` binary, read the real `~/.codex`, or add a live test.
- Do not read readings from MCP notifications (whether Codex sends them is checked in a later task).
- Do not copy anything but `rate_limits` values out of a log. Do not log file paths that contain the user's home directory into events.
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
