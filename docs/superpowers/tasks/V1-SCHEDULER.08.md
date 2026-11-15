# TASK: bridge-rung-selector

## Meta
- **Task ID**: V1-SCHEDULER.08
- **Parent plan**: docs/superpowers/plans/2026-11-15-v1-scheduler.md
- **Depends on**: V1-SCHEDULER.07
- **Estimated scope**: M
- **Model hint**: terra

## Objective
The Bridge page's header lets the owner change the trust rung from a selector, and warns with one inline line before a change that would send freighters immediately.

## Context
The Bridge is the browser page served by `nexus serve` (Preact, built with Vite into `dist/web`). Its header shows the rung as plain text today. The rung now changes what the server does by itself: `manual` nothing, `verdicts` everything after a human sent the first freighter, `roundabout` also the first freighter to every ready moon. Raising to `roundabout` can therefore start work the moment it is chosen, so that one case gets a confirmation line saying how many freighters will be sent now; the server supplies that number as `snapshot.ready_to_send`. Every other change applies at once: the owner's rule is that the system should just run and only ask when something deserves attention. The confirmation is inline in the header, never a browser dialog. `highways` and `autopilot` exist as config values but cannot be selected yet; a galaxy whose file already says one of them must still display truthfully. The page never imports from `src/`; its types are re-declared in `web/src/types.ts`. The suite cannot render components, so the tests are bundle-string and source-text checks; a reviewer will render the component separately. Affected workflow IDs is `none` because this project has no review suite.

## Files

### Touch
| Path | Action | Notes |
|------|--------|-------|
| `tests/http/page-rung.test.mjs` | create | the acceptance test, written first |
| `web/src/components/Header.tsx` | modify | the selector and the confirmation line |
| `web/src/types.ts` | modify | `Snapshot` gains `ready_to_send: number`; nothing else |
| `web/src/style.css` | modify | only the rules the selector and the new line need |

### Do NOT touch
- `web/src/components/ActionBar.tsx` — import `useCommand` from it, change nothing
- `web/src/components/SystemView.tsx`, `web/src/components/MoonDetail.tsx` — owned by task V1-SCHEDULER.09
- `web/src/components/Routing.tsx`, `Decisions.tsx`, `Fleet.tsx`, `web/src/store.ts`, `web/src/api.ts`, `web/src/main.tsx`
- `tests/http/page-panels.test.mjs` and the other `tests/http/page-*.test.mjs` — they must stay green unmodified (the bundle must still contain `rung: ` and `in flight `)
- `src/**` — no server changes
- Any file not listed under Touch. If completing the objective seems to require touching an unlisted file, STOP and report BLOCKED.

**Standing exclusions:**
- Security-routed files, never modified by this lane: `src/core/git.ts`, `src/validate/**`, `src/providers/claude-sdk/gate-hook.ts`, `src/server/dispatch.ts`, `src/db/migrations/**`, `src/server/http/auth.ts`, `src/server/lock.ts`
- Pipeline-owned paths: `docs/superpowers/plans/**`, `docs/superpowers/tasks/**`, `.superpowers/sdd/**`
- `package.json`, `package-lock.json` — no dependency changes

## Interfaces

Produced:

```ts
// web/src/types.ts — Snapshot gains one field
ready_to_send: number;      // first freighters that would be sent right now if the rung were roundabout

// web/src/components/Header.tsx — signature unchanged
export function Header({ b }: { b: Bridge }): JSX.Element
```

Exact copy (strings must appear verbatim in the built bundle):

```text
select:        <select aria-label="Trust rung">
options:       manual — you do every step
               verdicts — you send each freighter; the server inspects, docks and re-runs fixes
               roundabout — the server also sends a freighter to every ready moon
confirmation:  Raising to roundabout sends <n> freighter now.       (n === 1)
               Raising to roundabout sends <n> freighters now.      (n !== 1)
buttons:       Raise      Cancel
command:       config.automation   with body { level }
```

Consumed (exact current signatures; do not change them):

```ts
// web/src/components/ActionBar.tsx
export function useCommand(b: Bridge): { busy: boolean; error: string | null; send(name: string, body: object): Promise<boolean>; clear(): void };
// send resolves true when the server accepted the command, false on a refusal (error is then set). Used the same way in web/src/components/Routing.tsx.
// web/src/store.ts — Bridge: b.snapshot is Snapshot | null (re-read after every command and on every feed event), b.conn
// web/src/types.ts — Snapshot: { rung: string; ready_to_send: number; limits: { in_flight: number; max_concurrent_ships: number; ... }; ... }
// current header markup being replaced:   <span>rung: {snapshot.rung}</span>
// existing CSS classes available: .field (select/input), .btn, .msg-error, .bridge-summary, .bridge-header
```

## Constraints
- The header's `rung: <value>` text becomes the text `rung: ` followed by the select. The option values are `manual`, `verdicts`, `roundabout`; the selected option always follows `snapshot.rung` once no choice is pending.
- If `snapshot.rung` is `highways` or `autopilot`, a fourth option showing just that name is rendered, selected and disabled; the three others stay selectable.
- Choosing `manual` or `verdicts`, or choosing `roundabout` while `snapshot.ready_to_send === 0`, sends `config.automation` with `{ level }` immediately.
- Choosing `roundabout` while `snapshot.ready_to_send > 0` sends nothing yet and shows the confirmation line with the two buttons. `Raise` sends the command; `Cancel` removes the line and puts the selector back on `snapshot.rung`. The line's number follows the live snapshot while it is shown.
- Never `window.confirm`, `alert` or any dialog.
- While a command is in flight the selector and both buttons are disabled. A refused command shows `command.error` in a `.msg-error` line under the summary and leaves the selector on `snapshot.rung`.
- Treat a missing or non-numeric `ready_to_send` as `0` (an older server).
- At a width of about 400 px the selector and the confirmation line must wrap rather than overflow; add only the CSS needed for that.
- No new dependencies; Preact hooks only. TypeScript strict (`npm run build:web` type-checks `web/`).

## Acceptance

**Test command (must exit 0):**
```bash
npm test -- "tests/http/page-*.test.mjs"
```

**Behavioral criteria** (each must be covered by an assertion in `tests/http/page-rung.test.mjs`, written in the style of `tests/http/page-panels.test.mjs`: read the built bundle under `dist/web/assets` and the component source):
1. The bundle contains each of the three option strings verbatim.
2. The bundle contains `Trust rung`, `Raising to roundabout sends `, ` freighter now.`, ` freighters now.`, `Raise`, `Cancel` and `config.automation`.
3. `web/src/components/Header.tsx` does not contain `confirm(` or `alert(`.
4. `web/src/components/Header.tsx` references `ready_to_send` and imports `useCommand`.
5. `web/src/types.ts` contains `ready_to_send: number`.
6. The bundle still contains `rung: ` and `in flight ` (the existing page tests in the same command stay green unmodified).

**Affected workflow IDs**: none

**Regression guard (task level — implementer runs this):**
```bash
npm test
```

## Out of Scope
- No server changes; `ready_to_send` is already in the snapshot.
- No selector for later rungs, no tooltips, no settings panel, no persistence in the browser.
- Do not restyle the rest of the header or other panels.
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
