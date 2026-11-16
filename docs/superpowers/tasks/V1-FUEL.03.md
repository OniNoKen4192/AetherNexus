# TASK: fuel-adapter-contract-and-fake

## Meta
- **Task ID**: V1-FUEL.03
- **Parent plan**: docs/superpowers/plans/2026-11-15-v1-fuel.md
- **Depends on**: V1-FUEL.02
- **Estimated scope**: L (one contract change felt in several files; each edit is small)
- **Model hint**: terra

## Objective
A provider adapter can report a fuel reading as an event in its stream and can be told which model to fly; the fake adapter can be scripted to emit readings, to hit a rate limit with a reset time, and to behave differently per round and per provider id.

## Context
Slice 2 of v1 adds fuel readings and a limiter. Readings are *reported only*: an adapter says what the provider told it, as a `fuel` event inside the voyage's event stream, and never estimates. The old `fuel()` method on the adapter was a placeholder that always answered "unknown"; it is removed, with the `FuelReading` type. `Job.model` exists so a later task can send a freighter on a cheaper model ("refuelling"). The fake adapter is the only provider the test suite ever calls, so every later task's tests depend on the scripting added here; the real adapters get their readings in V1-FUEL.04 and .05 — here they only lose `fuel()`. Wording rule for comments, fixture names and test names: a *ship* runs out of fuel or hits the wall; a moon never does. Affected workflow IDs is `none` because this project has no review suite.

## Files

### Touch
| Path | Action | Notes |
|------|--------|-------|
| `tests/providers/fake.test.mjs` | modify | add the tests below; keep the existing ones passing unchanged |
| `src/providers/adapter.ts` | modify | contract below |
| `src/providers/fake/index.ts` | modify | new steps, redirects, `id`, model line |
| `src/providers/index.ts` | modify | pass the config id to the fake; drop `fuel()` from `placeholder` |
| `src/providers/claude-sdk/index.ts` | modify | remove `fuel()` and the `FuelReading` import **only** |
| `src/providers/codex-mcp/index.ts` | modify | remove `fuel()` and the `FuelReading` import **only** |
| `src/cli/run.ts` | modify | one new case in the event-summary switch (beside `case "usage"`) |
| `tests/fixtures/scripts/wall.json` | create | |
| `tests/fixtures/scripts/wall-twice.json` | create | |
| `tests/fixtures/scripts/review-wall.json` | create | |
| `tests/fixtures/scripts/fuel-low.json` | create | |
| `tests/fixtures/scripts/fuel-ok.json` | create | |

### Do NOT touch
- Existing fixture scripts under `tests/fixtures/scripts/` (`happy`, `rate-limited`, `review-rate-limited`, `fix-round`, …) — unchanged
- `src/providers/claude-sdk/gate-hook.ts` — security-routed
- `mapMessage`, `dispatch` and everything else in the two real adapters beyond the `fuel()` removal — owned by V1-FUEL.04 and V1-FUEL.05
- `src/server/**`, `src/db/**`, `src/config/**`, `web/**` — owned by later tasks
- Any file not listed under Touch. If completing the objective seems to require touching an unlisted file, STOP and report BLOCKED.

**Standing exclusions:**
- Security-routed files, never modified by this lane: `src/core/git.ts`, `src/validate/**`, `src/providers/claude-sdk/gate-hook.ts`, `src/server/dispatch.ts`, `src/db/migrations/**`, `src/server/http/auth.ts`, `src/server/lock.ts`
- Pipeline-owned paths: `docs/superpowers/plans/**`, `docs/superpowers/tasks/**`, `.superpowers/sdd/**`
- `package.json`, `package-lock.json` — no dependency changes

## Interfaces

Produced:

```ts
// src/providers/adapter.ts
export type AgentEventKind = "text" | "tool_use" | "tool_result" | "file_changed" | "usage" | "fuel" | "done" | "error";
// AgentEvent gains one member and the error member gains two optional fields:
| { kind: "fuel"; ts: string; data: { window: string; used: number; resets_at?: string; model_family?: string } }   // used is a fraction 0..1; resets_at is ISO 8601
| { kind: "error"; ts: string; data: { classification: ErrorClass; message: string; raw?: unknown; resets_at?: string; model_family?: string } }
export type Job = { /* every existing field unchanged */ model?: string };
// ProviderAdapter: the fuel() method is removed. The FuelReading type is deleted.

// src/providers/fake/index.ts
export type FakeScript = { name: string; role: Role; steps: FakeStep[]; rounds?: Record<string, string>; providers?: Record<string, string> };
// FakeStep gains:   { fuel: { window: string; used: number; resets_in_ms?: number; model_family?: string } }
// and error becomes { error: { classification: ErrorClass; message: string; resets_in_ms?: number; model_family?: string } }
export function createFakeAdapter(scriptsDir: string, opts?: { id?: string; pick?: (job: Job) => string }): ProviderAdapter;   // id defaults to "fake"

// src/providers/index.ts — buildAdapters passes the provider's config id: createFakeAdapter(deps.scriptsDir, { id })
```

Consumed (exact current code):

```ts
// src/providers/fake/index.ts today
export function createFakeAdapter(scriptsDir: string, opts: { pick?: (job: Job) => string } = {}): ProviderAdapter
// default pick: first "FAKE-SCRIPT: <name>" in job.prompt for implement; first name starting "review-" for review;
// defaults "happy" / "review-approve"; "fix-round" and "scope-violation" become "happy" when job.round > 1.
// src/cli/run.ts event summary: case "usage": summary = `in=${...} out=${...}`; break;
```

## Constraints
- **Script redirection**, applied once to the name `pick` returned (never chained): if that script has `providers[<this adapter's id>]`, load that script instead; otherwise if it has `rounds[String(job.round)]`, load that one. Provider beats round. A redirect naming a script file that does not exist throws an error whose message contains the missing file name. The built-in round rule for `fix-round` / `scope-violation` is unchanged.
- `resets_in_ms` on a `fuel` or `error` step becomes `resets_at = new Date(Date.now() + resets_in_ms).toISOString()` on the emitted event; without it the event carries no `resets_at`. `model_family` is passed through when present.
- When `job.model` is set, the fake's first event is `{ kind: "text", data: { text: "fake: model <model>" } }`, before the script's steps. When it is not set, the stream is exactly as today.
- CLI event summary for a `fuel` event: `<window> <percent>% used`, percent = `Math.round(used * 100)` (e.g. `5h 95% used`).
- **Fixture scripts** (all use the two-file writes of `happy.json` where they say "happy steps"):
  - `wall` — implement: a text step, then error `{ classification: "rate_limited", message: "usage limit reached", resets_in_ms: 400 }`; `rounds: { "2": "happy" }`.
  - `wall-twice` — implement: the same error, no redirects (it hits the wall at every round).
  - `review-wall` — review: the same error. `rounds: { "2": "review-approve" }`, so the review of a second round approves. Keep `name` equal to the file name; put no comments in the JSON.
  - `fuel-low` — implement: a `fuel` step `{ window: "5h", used: 0.95, resets_in_ms: 60000 }`, then the happy steps.
  - `fuel-ok` — implement: a `fuel` step `{ window: "5h", used: 0.2, resets_in_ms: 60000 }`, then the happy steps.
- No new dependencies. Tests import from `dist/`.

## Acceptance

**Test command (must exit 0):**
```bash
npm test -- "tests/providers/fake.test.mjs" && npx tsc -p tsconfig.json --noEmit
```

**Behavioral criteria** (each covered by a test added to `tests/providers/fake.test.mjs`):
1. `fuel-ok` yields a `fuel` event `{ window: "5h", used: 0.2 }` with a `resets_at` that parses to a time 55–65 s ahead, before the `file_changed` events, and still ends with `done`.
2. `wall` at round 1 yields an `error` event with `classification: "rate_limited"` and a `resets_at` 0.2–0.6 s ahead, and no `done`; at round 2 it behaves exactly as `happy`.
3. `wall-twice` yields the error at rounds 1 and 2.
4. A step with `model_family` passes it through on both `fuel` and `error` events (use a temp scripts directory written by the test).
5. Redirection: with a temp script declaring both `providers: { spare: "happy" }` and `rounds: { "1": "wall-twice" }`, an adapter created with `id: "spare"` runs `happy` at round 1; one with the default id runs `wall-twice`.
6. A redirect to a missing script rejects with a message containing that file name.
7. `createFakeAdapter(dir).id === "fake"` and `createFakeAdapter(dir, { id: "spare" }).id === "spare"`.
8. With `job.model: "m-cheap"` the first event is the text `fake: model m-cheap`; without it no such event appears.
9. No adapter built by `buildAdapters` has a `fuel` property (test through `dist/providers/index.js` with a config holding one `fake` provider and a second provider whose adapter is `fake` under another id; both ids are reflected in `.id`).

**Affected workflow IDs**: none

**Regression guard (task level — implementer runs this):**
```bash
npm test
```

## Out of Scope
- No readings from the real adapters (V1-FUEL.04, .05); no storing of readings (V1-FUEL.06, .08).
- Do not change how `rate-limited.json` or any existing script behaves.
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
