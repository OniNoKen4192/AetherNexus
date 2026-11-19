# TASK: fuel-labels-and-actions-page

## Meta
- **Task ID**: V1-FUEL.15
- **Parent plan**: docs/superpowers/plans/2026-11-15-v1-fuel.md
- **Depends on**: V1-FUEL.14
- **Estimated scope**: M
- **Model hint**: terra

## Objective
On the Bridge a moon that waits on fuel says so, cargo awaiting pickup and a ship out of fuel are named in plain words, a moon parked for contraband or a raid stands out with what to do about it, and a person can refuel or send a ship anyway with one click.

## Context
Slice 2 of v1. The reads already carry everything (`waiting_on_fuel`, `can_refuel` on moon rows and the moon detail; `refuel_for` on voyage rows; `park_reason`), and the commands already accept `refuel` and `override`; this task only draws and wires them. As in V1-FUEL.14, the words are built by pure functions in a new file with no imports, which the test transpiles with the `typescript` package and calls directly; the reviewer renders what only a browser can show. Two park reasons were given owner-chosen wording on 2026-11-18 because they must stand out from the normal flow: `carryover_violations` reads **contraband in the cargo**, `baseline_tampered` reads **raided by pirates**. Wording rule: a *ship* runs out of fuel or hits the wall, a moon never does; a moon *waits on fuel*; its *cargo awaits pickup*; `adrift` means only "needs a person". Affected workflow IDs is `none` because this project has no review suite.

Facts about the reads the page must live with:
- `waiting_on_fuel` is `null` whenever no launch or inspect is available for the moon, and also while the held provider has no idle ship; the label may come and go. Do not try to remember it.
- A moon can carry `waiting_on` (dependencies) and `waiting_on_fuel` at once.
- `until` may be absent from `waiting_on_fuel`.
- Snapshot rows carry no `actions`; the moon detail does (`b.detail.actions`).

## Files

### Touch
| Path | Action | Notes |
|------|--------|-------|
| `tests/http/page-fuel-actions.test.mjs` | create | |
| `web/src/labels.ts` | create | pure functions, no imports except types |
| `web/src/components/SystemView.tsx` | modify | moon rows |
| `web/src/components/MoonDetail.tsx` | modify | heading, labels, park reason |
| `web/src/components/ActionBar.tsx` | modify | Refuel and Send anyway |
| `web/src/style.css` | modify | the attention label only |

### Do NOT touch
- `web/src/gauge.ts`, `web/src/types.ts`, `web/src/components/Fleet.tsx` — owned by V1-FUEL.14; import from them
- `web/src/store.ts`, `web/src/api.ts`, the other components
- Anything under `src/`
- Existing test files. If one fails, STOP and report it (name the test and the assertion).
- Any file not listed under Touch. If completing the objective seems to require touching an unlisted file, STOP and report BLOCKED.

**Standing exclusions:**
- Security-routed files, never modified by this lane: `src/core/git.ts`, `src/validate/**`, `src/providers/claude-sdk/gate-hook.ts`, `src/server/dispatch.ts`, `src/db/migrations/**`, `src/server/http/auth.ts`, `src/server/lock.ts`
- Pipeline-owned paths: `docs/superpowers/plans/**`, `docs/superpowers/tasks/**`, `.superpowers/sdd/**`
- `package.json`, `package-lock.json` — no dependency changes

## Interfaces

Produced:

```ts
// web/src/labels.ts
import type { FuelWait, RefuelOffer } from "./types";      // type-only; nothing else is imported
/** "awaiting_pickup" → "cargo awaiting pickup"; "out_of_fuel" → "out of fuel"; anything else unchanged. */
export function statusText(status: string): string;
/** "carryover_violations" → "contraband in the cargo"; "baseline_tampered" → "raided by pirates"; anything else unchanged. */
export function parkReasonText(reason: string): string;
/** What a person can do about it, for the two reasons above; null for any other reason. */
export function parkReasonHint(reason: string): string | null;
/** True for the two reasons above. */
export function needsAttention(reason: unknown): boolean;
/** "waiting on <provider> fuel", plus " · resets <formatTime(until)>" when until is present. */
export function fuelWaitText(wait: FuelWait, formatTime: (iso: string) => string): string;
/** reason "low" → "Send anyway"; any other reason → "Send anyway (probe)". */
export function sendAnywayLabel(reason: string): string;
/** "Refuel: <provider>/<model>". */
export function refuelLabel(offer: RefuelOffer): string;
/** For a voyage row: "refuelled: <provider>/<model>" (just "<provider>" when it has no model), or null when refuel_for is not a string. */
export function refuelledText(voyage: Record<string, unknown>): string | null;
/** The override for the moon's available action: launch wins over inspect; null when neither is available. */
export function overrideCommand(actions: string[], taskId: string): { name: "moon.launch" | "voyage.inspect"; body: { taskId: string; override: true } } | null;
/** { name: "moon.launch", body: { taskId, refuel: true } } when actions include "launch", else null. */
export function refuelCommand(actions: string[], taskId: string): { name: "moon.launch"; body: { taskId: string; refuel: true } } | null;
/** Type guards for values read off a Row. */
export function asFuelWait(value: unknown): FuelWait | null;        // an object with string provider and reason (until kept only when a string)
export function asRefuelOffer(value: unknown): RefuelOffer | null;  // an object with string provider and model
```

Consumed (exact current code):

```ts
// web/src/types.ts (V1-FUEL.14)
export type FuelWait = { provider: string; reason: string; until?: string };
export type RefuelOffer = { provider: string; model: string };
// Snapshot.voyages / MoonDetail.voyages rows: Row & { owner: Owner | null; refuel_for: string | null } — also carry assignment_id, role, status, provider, model
// web/src/gauge.ts (V1-FUEL.14)
export function timeText(iso: string, nowMs: number): string;
// web/src/components/ActionBar.tsx
export function useCommand(b: Bridge): { busy: boolean; error: string | null; send(name: string, body: object): Promise<boolean>; clear(): void };  // the shared pending/error handling
export function ActionBar({ b }: { b: Bridge })     // renders one control per b.detail.actions entry
// web/src/components/SystemView.tsx — each assigned moon row:
//   <span>{name}</span><code>{taskId}</code><span className="badge">{text(moon["status"])}</span>
//   {waitingOn.length > 0 && <span className="badge waiting-label">waiting on …</span>} …
// web/src/components/MoonDetail.tsx — heading badge {text(moon["status"])}; waiting labels as <div className="badge waiting-label">;
//   {moon["park_reason"] !== null && <div className="moon-park-reason">{text(moon["park_reason"])}</div>}; then <ActionBar b={b} />
// Commands (already accepted by the server): moon.launch { taskId, refuel: true } · moon.launch { taskId, override: true } · voyage.inspect { taskId, override: true }
```

## Constraints
- **Hints.** `parkReasonHint("carryover_violations")` is exactly `clear the files outside the task's paths from its worktree, then reply — or drop the moon`. `parkReasonHint("baseline_tampered")` is exactly `put the gate's state file back exactly as it was, then reply — or drop the moon`.
- **Status words.** Wherever the page prints a moon's status (the row badge, the detail heading) it prints `statusText(status)`.
- **Waiting on fuel.** A moon whose `waiting_on_fuel` is set shows `fuelWaitText(...)` in the existing `.waiting-label` style, in its system-view row and in the detail panel — but only when it has no dependency wait showing (`waiting_on` and `waiting_on_planets` both empty): dependencies come first. `formatTime` is `(iso) => timeText(iso, Date.now())`.
- **Contraband and raids.** A moon whose `park_reason` satisfies `needsAttention` shows, in its system-view row, a badge with classes `badge attention-label` and the text `parkReasonText(reason)`. In the detail panel the park-reason line shows `parkReasonText(reason)` for every reason, gains the class `attention-label` and is followed by the `parkReasonHint` line when `needsAttention`. `.attention-label` uses the stylesheet's existing danger/error colour variables and a visible border, in the light and the dark scheme; the words carry the meaning.
- **Refuelled mark.** In the detail panel, under the heading, one line `refuelledText(v)` for each of the moon's voyages that has it, newest last. In the system-view row, the same text for a voyage of that moon (`assignment_id` equal) whose `status` is `launched` or `working`, in the `.waiting-label` style.
- **Buttons** (in `ActionBar`, after the existing controls, each using its own `useCommand(b)` so the existing pending and error handling applies):
  - `refuelLabel(offer)` when the moon detail's `can_refuel` is set and `refuelCommand` is not null; a click sends that command.
  - `sendAnywayLabel(reason)` when `waiting_on_fuel` is set and `overrideCommand` is not null; a click sends that command.
  - Neither button is rendered otherwise. The existing Launch, Inspect, Drop and other controls and their copy are unchanged.
- `labels.ts` has no runtime import and no JSX. The three components import from `../labels`. Nothing overflows at a 400 px viewport. No new dependencies.

## Acceptance

**Test command (must exit 0):**
```bash
npm test -- "tests/http/page-*.test.mjs"
```

**Behavioral criteria** (each a named test in `tests/http/page-fuel-actions.test.mjs`; tests 1–7 transpile `web/src/labels.ts` with `typescript`'s `transpileModule` (ES module output), write it to a temp `.mjs` file and import it):
1. **statusText.** `awaiting_pickup` → `cargo awaiting pickup`; `out_of_fuel` → `out of fuel`; `adrift` → `adrift`; `""` → `""`.
2. **Park reasons.** `parkReasonText`: `carryover_violations` → `contraband in the cargo`; `baseline_tampered` → `raided by pirates`; `rate_limited` → `rate_limited`. `needsAttention` is true for exactly those two and false for `rate_limited`, `null`, `undefined`, `7`. `parkReasonHint` returns the two exact strings above and `null` for `rate_limited`.
3. **fuelWaitText.** `{ provider: "codex", reason: "low", until: "X" }` with `formatTime = (iso) => "T(" + iso + ")"` → `waiting on codex fuel · resets T(X)`; without `until` → `waiting on codex fuel`, and `formatTime` is not called.
4. **Button labels.** `sendAnywayLabel("low")` → `Send anyway`; `("dry")` → `Send anyway (probe)`; `refuelLabel({ provider: "claude", model: "claude-haiku-5-5" })` → `Refuel: claude/claude-haiku-5-5`.
5. **refuelledText.** `{ refuel_for: "codex", provider: "claude", model: "m-cheap" }` → `refuelled: claude/m-cheap`; with `model: null` → `refuelled: claude`; with `refuel_for: null` → `null`; with no `refuel_for` key → `null`.
6. **Commands.** `overrideCommand(["launch", "drop"], "T1")` deep-equals `{ name: "moon.launch", body: { taskId: "T1", override: true } }`; `(["inspect"], "T1")` → `{ name: "voyage.inspect", body: { taskId: "T1", override: true } }`; `(["launch", "inspect"], "T1")` → the launch one; `(["reply", "drop"], "T1")` → `null`. `refuelCommand(["launch"], "T1")` deep-equals `{ name: "moon.launch", body: { taskId: "T1", refuel: true } }`; `(["inspect"], "T1")` → `null`.
7. **Guards.** `asFuelWait({ provider: "a", reason: "low", until: 5 })` deep-equals `{ provider: "a", reason: "low" }`; `asFuelWait(null)`, `asFuelWait("x")`, `asFuelWait({ provider: "a" })` → `null`; `asRefuelOffer({ provider: "p", model: "m" })` deep-equals itself; `asRefuelOffer({ provider: "p" })` → `null`.
8. **The page uses them.** `SystemView.tsx`, `MoonDetail.tsx` and `ActionBar.tsx` each import from `../labels`; `SystemView.tsx` and `MoonDetail.tsx` read `waiting_on_fuel` and `park_reason` and call `statusText`; `ActionBar.tsx` reads `can_refuel` and `waiting_on_fuel` and calls `overrideCommand` and `refuelCommand`; `SystemView.tsx` and `MoonDetail.tsx` read `refuel_for` (directly or through `refuelledText`); `labels.ts` contains no `import` other than a type-only one.
9. **The built page carries the copy.** The bundle under `dist/web/assets` contains `waiting on `, ` fuel`, `cargo awaiting pickup`, `out of fuel`, `Refuel: `, `Send anyway`, `(probe)`, `refuelled: `, `contraband in the cargo`, `raided by pirates`, `attention-label`; the built stylesheet contains `attention-label`.
10. **Wording.** Neither the bundle nor the four changed source files contain `moon is out of fuel`, `moon ran out`, `moon hit the wall` or `refuel the moon`.

**For the reviewer to render (not in the suite):** each label and button appears exactly when its field is set and not otherwise; the fuel label gives way to a dependency wait; the two attention labels in a row and in the detail panel, light and dark; the posted bodies of both buttons; a button's pending and error states; no overflow at 400 px.

**Affected workflow IDs**: none

**Regression guard (task level — implementer runs this):**
```bash
npm test
```

## Out of Scope
- No change to the Drop control or its copy, and none to the existing Launch / Inspect controls.
- No client-side memory of a hold that the read has stopped reporting.
- No change to the reads, the commands or the gauge.
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
