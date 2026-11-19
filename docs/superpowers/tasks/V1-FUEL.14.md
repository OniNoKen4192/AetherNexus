# TASK: fuel-gauge-page

## Meta
- **Task ID**: V1-FUEL.14
- **Parent plan**: docs/superpowers/plans/2026-11-15-v1-fuel.md
- **Depends on**: V1-FUEL.13
- **Estimated scope**: M
- **Model hint**: terra

## Objective
The Fleet panel on the Bridge shows one fuel gauge per provider: how much of its pool is left, when it resets, how old the reading is, and whether the pool is below its reserve floor, dry, unknown or free.

## Context
Slice 2 of v1. The server's snapshot already carries `pools` (V1-FUEL.12); this task only draws it. The page is Preact + Vite under `web/`, built to `dist/web` by `npm run build` (which `npm test` runs first). The page never imports from `src/`; server types are re-declared in `web/src/types.ts`. The suite has no DOM library and none may be added, so the text of the gauge is built by pure functions in a new file with no imports, which the test transpiles with the `typescript` package the project already uses and then calls directly; what only a browser can show (layout, the `<meter>`) the reviewer renders out of band. State must be carried by the words, not by colour alone. Wording rule: a *ship* runs out of fuel or hits the wall, a moon never does; a *pool* is low, dry, unknown or free. Affected workflow IDs is `none` because this project has no review suite.

## Files

### Touch
| Path | Action | Notes |
|------|--------|-------|
| `tests/http/page-fuel.test.mjs` | create | |
| `web/src/gauge.ts` | create | pure functions, no imports except types |
| `web/src/types.ts` | modify | add `PoolView`, `FuelWait`, `RefuelOffer`; `Snapshot.pools`; `refuel_for` on voyage rows |
| `web/src/components/Fleet.tsx` | modify | draw the gauge |
| `web/src/style.css` | modify | gauge styles only |

### Do NOT touch
- `web/src/components/SystemView.tsx`, `MoonDetail.tsx`, `ActionBar.tsx` — owned by V1-FUEL.15
- `web/src/store.ts`, `web/src/api.ts`, `web/src/App.tsx`, the other components
- Anything under `src/` — the reads are V1-FUEL.12's
- Existing test files. If one fails, STOP and report it (name the test and the assertion).
- Any file not listed under Touch. If completing the objective seems to require touching an unlisted file, STOP and report BLOCKED.

**Standing exclusions:**
- Security-routed files, never modified by this lane: `src/core/git.ts`, `src/validate/**`, `src/providers/claude-sdk/gate-hook.ts`, `src/server/dispatch.ts`, `src/db/migrations/**`, `src/server/http/auth.ts`, `src/server/lock.ts`
- Pipeline-owned paths: `docs/superpowers/plans/**`, `docs/superpowers/tasks/**`, `.superpowers/sdd/**`
- `package.json`, `package-lock.json` — no dependency changes

## Interfaces

Produced:

```ts
// web/src/types.ts  (mirrors src/server/commands/query.ts)
export type PoolView = {
  provider: string; kind: string; state: "dry" | "free" | "low" | "ok" | "unknown";
  remaining?: number; resets_at?: string; until?: string; reading_ts?: string;
  reserve_floor: number; refuel?: { provider: string; models: Record<string, string> };
  windows: { window: string; used: number; resets_at?: string; model_family?: string; ts: string }[];
};
export type FuelWait = { provider: string; reason: string; until?: string };
export type RefuelOffer = { provider: string; model: string };
// Snapshot gains  pools: PoolView[];  Snapshot.voyages and MoonDetail.voyages rows gain  refuel_for: string | null

// web/src/gauge.ts
import type { PoolView } from "./types";            // type-only import; nothing else is imported
/** "0s" … "59s", "1m" … "59m", "1h" … "47h", then whole days "2d" …; a negative or non-finite input is "0s". */
export function ageText(ms: number): string;
/** A local time for an ISO string: time only when it falls on the same local calendar day as nowMs, otherwise date and time. Unparseable input is returned as it is. */
export function timeText(iso: string, nowMs: number): string;
/** The gauge's one line of text (see Constraints). */
export function gaugeText(pool: PoolView, nowMs: number): string;
/** One line per window that names a model family: "<family>: <n>% left". */
export function familyLines(pool: PoolView): string[];
/** The <meter> value in 0..1, or null when the pool has no meter (unknown, free). */
export function meterValue(pool: PoolView): number | null;
```

Consumed (exact current code):

```ts
// web/src/types.ts
export type Row = Record<string, unknown>;
export type Snapshot = { cursor: number; repo: string; rung: string; ready_to_send: number; limits: …; roles: …;
  systems: …; voyages: (Row & { owner: Owner | null })[]; fleet: Row[]; decisions: Row[]; specs: SpecEntry[]; failures: Failure[] };
// web/src/components/Fleet.tsx — export function Fleet({ b }: { b: Bridge }); groups b.snapshot.fleet by ship["fleet"] into
//   <div className="fleet-group"><h3>{provider}</h3> … class lines … <div className="fleet-ships">…</div></div>
// tests/http/page-rung.test.mjs, tests/http/page-fleet.test.mjs — how the suite reads the built bundle (dist/web/assets/*.js) and component sources
```

## Constraints
- **Text.** With `p` = `Math.round(remaining * 100)`, `f` = `Math.round(reserve_floor * 100)`, segments joined by ` · ` (space, middle dot U+00B7, space):
  - `ok`: `<p>% left`, then `resets <timeText(resets_at)>` if `resets_at` is present, then `read <ageText(nowMs - reading_ts)> ago` if `reading_ts` parses, then `floor <f>%`.
  - `low`: the same, with a last segment `below floor`.
  - `dry`: `dry until <timeText(until)>`; just `dry` when `until` is absent.
  - `unknown`: `unknown · floor <f>%`.
  - `free`: `free`.
  - No output ever contains `NaN`, `undefined`, `null` or `Invalid Date`: a missing or non-finite `remaining` is treated as 0, a missing `reserve_floor` as 0.
- **`timeText`.** Same local day as `nowMs`: `new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })`. Another day: `new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })`.
- **`familyLines`.** Only windows with a `model_family`; `<n>` = `Math.round((1 - used) * 100)` with `used` clamped to 0..1; order as in `windows`.
- **`meterValue`.** `ok` / `low`: `remaining` clamped to 0..1; `dry`: 0; `unknown` / `free`: `null`.
- **Drawing.** In each provider's group, directly under its `<h3>`, a block with class `gauge gauge-<state>` holding: a `<meter min="0" max="1" low={reserve_floor} value={…}>` with `aria-label="<provider> fuel"` (omitted when `meterValue` is `null`), the `gaugeText` line, and one line per `familyLines` entry. A provider that is in `pools` but has no ships still gets a group (heading and gauge), after the groups that have ships. A provider with ships and no `pools` entry keeps today's group with no gauge. When the fleet is empty and `pools` is not, the pool groups are shown instead of "No ships.". A snapshot without `pools` (an older server) is treated as `pools: []`.
- **Style.** Gauge styles use the existing colour variables of `style.css`; `gauge-low` and `gauge-dry` differ visibly from `gauge-ok`, in the light and the dark scheme, but the words carry the state. Nothing in the Fleet panel overflows horizontally at a 400 px viewport: the gauge text wraps.
- `gauge.ts` has no runtime import and no JSX, so the test can transpile it alone. `Fleet.tsx` imports the functions from `../gauge`.
- The retire controls and everything else in `Fleet.tsx` behave as today. No new dependencies.

## Acceptance

**Test command (must exit 0):**
```bash
npm test -- "tests/http/page-*.test.mjs"
```

**Behavioral criteria** (each a named test in `tests/http/page-fuel.test.mjs`; tests 1–8 transpile `web/src/gauge.ts` with `typescript`'s `transpileModule` (ES module output), write it to a temp `.mjs` file and import it; expected local times are computed in the test with the same `toLocale…` calls and a fixed `nowMs`):
1. **ageText.** `0` → `0s`; `59_000` → `59s`; `60_000` → `1m`; `3_599_000` → `59m`; `3_600_000` → `1h`; 47 hours → `47h`; 48 hours → `2d`; `-5` → `0s`; `NaN` → `0s`.
2. **timeText.** An instant on the same local day as `nowMs` gives the time-only form; one three days later gives the date-and-time form; `"soon"` gives `"soon"`.
3. **ok.** `{ state: "ok", remaining: 0.72, reserve_floor: 0.1, resets_at, reading_ts: nowMs − 3 min }` → exactly `72% left · resets <time> · read 3m ago · floor 10%`.
4. **low.** The same pool with `state: "low"`, `remaining: 0.05` → exactly `5% left · resets <time> · read 3m ago · floor 10% · below floor`.
5. **Missing fields.** `{ state: "ok", remaining: 0.72, reserve_floor: 0.1 }` → exactly `72% left · floor 10%`; `{ state: "ok", reserve_floor: 0.1 }` and `{ state: "low" }` produce text with none of `NaN`, `undefined`, `null`, `Invalid Date`.
6. **dry, unknown, free.** `dry` with `until` → `dry until <time>`; `dry` without → `dry`; `unknown` with floor 0.25 → `unknown · floor 25%`; `free` → `free`.
7. **familyLines.** Windows `[{ window: "5h", used: 0.2 }, { window: "weekly", used: 0.6, model_family: "opus" }, { window: "weekly", used: 1.4, model_family: "sonnet" }]` → `["opus: 40% left", "sonnet: 0% left"]`.
8. **meterValue.** `ok` 0.72 → 0.72; `low` with `remaining` 1.7 → 1; `dry` → 0; `unknown` → `null`; `free` → `null`.
9. **The page uses them.** `Fleet.tsx` imports from `../gauge`, reads `pools`, and contains a `<meter` and an `aria-label`; `types.ts` declares `pools`, `PoolView`, `FuelWait`, `RefuelOffer` and `refuel_for`; `gauge.ts` contains no `import` other than a type-only one.
10. **The built page carries the copy.** The bundle under `dist/web/assets` contains `% left`, `below floor`, `dry until`, `unknown`, `floor ` and the class names `gauge-ok`, `gauge-low`, `gauge-dry`, `gauge-unknown`, `gauge-free`; the built stylesheet contains the five class names.
11. **Wording.** None of `gauge.ts`, `Fleet.tsx`, `types.ts` contains `moon is out of fuel`, `moon ran out` or `moon hit the wall`.

**For the reviewer to render (not in the suite):** each state's block in a browser; the meter's `low` mark; a provider with a pool and no ships; a provider with ships and no pool entry; an empty fleet with pools; a snapshot without `pools`; no horizontal overflow at 400 px; light and dark schemes.

**Affected workflow IDs**: none

**Regression guard (task level — implementer runs this):**
```bash
npm test
```

## Out of Scope
- No labels or buttons on moons (`waiting on … fuel`, `Refuel`, `Send anyway`) — V1-FUEL.15.
- No gauge for a provider that is only a refuel target and is not in `pools` (the read does not list it; a later task decides).
- No timers: the age shown is computed when the panel renders (the page re-renders on every feed event).
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

## Amendments

### A1 — 2026-11-18 — accepted deviation
- **Original sha256**: 0851ecb5fd564fe368310107e3696b846c0f6e203bb23998aff603e2adde2272
- **Verdict ref**: FIX, V1-FUEL.14 round 0, lanes-reviewer
- **Deviation**: Tests 1–8 do not use `typescript`'s `transpileModule`. They copy `web/src/gauge.ts` into a directory under `os.tmpdir()` beside a stub `types.ts`, compile it with the project's `tsc` CLI (`node_modules/typescript/bin/tsc`, run with `process.execPath`, `noCheck`), and import the emitted module.
- **Reason accepted**: `typescript` is 7.0.2; its package exports only `version` and `versionMajorMinor`, so `transpileModule` does not exist and no new dependency is allowed. The CLI is the compiler the build already uses; the step costs about 135 ms. Type errors in `web/src` are caught by `npm run build:web` (`tsc -p web/tsconfig.json --noEmit`), which `npm test` runs first.
- **Affected paths**: tests/http/page-fuel.test.mjs
- **Acceptance criteria**: replaces the bracketed mechanism sentence of "Behavioral criteria": tests 1–8 compile a copy of `web/src/gauge.ts` with the project's `tsc` CLI and import the emitted file, which has the `.mjs` extension; the temporary directory is removed before the test process ends, also when the compile fails; nothing is left in `os.tmpdir()`. Criteria 1–11 are otherwise unchanged. (The `.mjs` extension and the cleanup are enforced by V1-FUEL.14-FIX1.)
