# TASK: fuel-claude-readings-and-model

## Meta
- **Task ID**: V1-FUEL.04
- **Parent plan**: docs/superpowers/plans/2026-11-15-v1-fuel.md
- **Depends on**: V1-FUEL.03
- **Estimated scope**: M
- **Model hint**: terra

## Objective
The Claude adapter reports what the Claude Agent SDK says about the rate limit as `fuel` events, attaches the reset time to a rate-limit error, and flies the model the job names.

## Context
Slice 2 of v1: fuel readings and a limiter. Readings are *reported only* — the adapter passes on what the provider said and estimates nothing. The SDK sends a `rate_limit_event` message carrying `SDKRateLimitInfo`; today the adapter turns it into a text line (or an error when rejected). Whether `utilization` arrives as a fraction or a percentage is not yet confirmed (a later live check settles it), so this task reads both. Claude has per-model weekly windows (`seven_day_opus`, `seven_day_sonnet`): a reading for one of those must say which family it is about, so that a later task can send a freighter on a cheaper model whose window still has room. Today the adapter always flies `models.frontier`; with `Job.model` (V1-FUEL.03) the caller can name another. Affected workflow IDs is `none` because this project has no review suite.

## Files

### Touch
| Path | Action | Notes |
|------|--------|-------|
| `tests/providers/claude-sdk.test.mjs` | modify | add tests; existing ones keep passing (see Constraints for the one that changes) |
| `src/providers/claude-sdk/index.ts` | modify | `mapMessage`'s `rate_limit_event` case and the `model` option in `dispatch` |

### Do NOT touch
- `src/providers/claude-sdk/gate-hook.ts` — security-routed
- `src/providers/adapter.ts`, `src/providers/fake/**`, `src/providers/index.ts` — owned by V1-FUEL.03
- `src/providers/codex-mcp/**` — owned by V1-FUEL.05
- Any file not listed under Touch. If completing the objective seems to require touching an unlisted file, STOP and report BLOCKED.

**Standing exclusions:**
- Security-routed files, never modified by this lane: `src/core/git.ts`, `src/validate/**`, `src/providers/claude-sdk/gate-hook.ts`, `src/server/dispatch.ts`, `src/db/migrations/**`, `src/server/http/auth.ts`, `src/server/lock.ts`
- Pipeline-owned paths: `docs/superpowers/plans/**`, `docs/superpowers/tasks/**`, `.superpowers/sdd/**`
- `package.json`, `package-lock.json` — no dependency changes

## Interfaces

Consumed:

```ts
// node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts
export declare type SDKRateLimitInfo = {
  status: 'allowed' | 'allowed_warning' | 'rejected';
  resetsAt?: number;
  rateLimitType?: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | /* others */ 'overage';
  utilization?: number;
  /* other fields not used here */
};
// the message: { type: "rate_limit_event", rate_limit_info: SDKRateLimitInfo }

// src/providers/adapter.ts (after V1-FUEL.03)
| { kind: "fuel"; ts: string; data: { window: string; used: number; resets_at?: string; model_family?: string } }   // used 0..1
| { kind: "error"; ts: string; data: { classification: ErrorClass; message: string; raw?: unknown; resets_at?: string; model_family?: string } }
export type Job = { /* … */ model?: string };

// src/providers/claude-sdk/index.ts (unchanged signatures)
export function mapMessage(m: SDKMessage, role: Role): AgentEvent[]
export function createClaudeAdapter(id: string, cfg: ProviderConfig, deps: { query?: QueryFn } = {}): ProviderAdapter
```

Produced — `mapMessage` for a `rate_limit_event` returns, in this order:

```text
1. a fuel event            — only when utilization is a finite number >= 0 and rateLimitType !== "overage"
     window       = rateLimitType ?? "unknown"
     used         = utilization <= 1 ? utilization : min(utilization / 100, 1)        (a value above 1 is a percentage)
     resets_at    = ISO string from resetsAt when it is a finite number > 0: below 1e12 it is seconds, otherwise milliseconds
     model_family = "opus" for seven_day_opus, "sonnet" for seven_day_sonnet, otherwise absent
2. when status === "rejected": the existing rate_limited error event (same message as today),
     now also carrying resets_at and model_family computed as above (each only when known —
     also when no fuel event was produced, e.g. utilization absent)
   otherwise: the existing text line `rate limit status: <status>`
```

`dispatch` passes `model: job.model ?? cfg.models?.frontier` in the SDK options (omitted when both are absent).

## Constraints
- A negative, `NaN`, infinite or non-number `utilization` produces no fuel event; it never produces `used` outside 0..1.
- A `resetsAt` that is not a finite positive number is dropped (no `resets_at`), never an invalid date string.
- The existing test "mapMessage: … rate limit rejected → error" asserts the events for a rejected message; if the message it uses now also yields a fuel event, update that assertion to the new order and say so under FILES_CHANGED. No other existing assertion may change.
- No new dependencies. Tests import from `dist/` and inject `query` exactly as the existing adapter test does.

## Acceptance

**Test command (must exit 0):**
```bash
npm test -- "tests/providers/claude-sdk.test.mjs"
```

**Behavioral criteria** (each covered by a test added to `tests/providers/claude-sdk.test.mjs`):
1. One case per `rateLimitType` `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`: the fuel event's `window` equals the type; `model_family` is `opus` / `sonnet` for the two per-model windows and absent for the others.
2. `rateLimitType` absent → `window: "unknown"`; `overage` → no fuel event.
3. `utilization` absent, `NaN`, `-0.1`, `"0.4"` → no fuel event; `0.4` → `used` 0.4; `1` → 1; `40` → 0.4; `140` → 1.
4. `resetsAt` `1795186480` (seconds) and `1795186480000` (milliseconds) both give `resets_at` `2026-11-20T…` equal to `new Date(1795186480000).toISOString()`; `resetsAt` `0`, `-5`, `NaN` give no `resets_at`.
5. A `rejected` message with utilization yields exactly `[fuel, error]` in that order, the error `rate_limited` with the same `resets_at` and `model_family`; a `rejected` message without utilization yields exactly `[error]`, still with `resets_at` when `resetsAt` is valid.
6. An `allowed` message with utilization yields `[fuel, text]`.
7. With `job.model: "m-cheap"` and `cfg.models.frontier: "m1"` the injected `query` receives `options.model === "m-cheap"`; without `job.model` it receives `"m1"`; with neither, `"model" in options` is false.

**Affected workflow IDs**: none

**Regression guard (task level — implementer runs this):**
```bash
npm test
```

## Out of Scope
- Do not call the real SDK or add a live test (a later KEEP task does that with the owner's go).
- Do not store readings or decide anything from them (V1-FUEL.06–.08).
- Do not change `classify`, `buildEnv`, the hooks, or the tool lists.
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
