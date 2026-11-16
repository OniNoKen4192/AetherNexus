# TASK: bridge-waiting-labels

## Meta
- **Task ID**: V1-SCHEDULER.09
- **Parent plan**: docs/superpowers/plans/2026-11-15-v1-scheduler.md
- **Depends on**: V1-SCHEDULER.08
- **Estimated scope**: M
- **Model hint**: terra

## Objective
The Bridge page shows, on a moon's row in the system view and at the top of its detail panel, what that moon is waiting on before a first freighter can be sent to it.

## Context
The Bridge is the browser page served by `nexus serve` (Preact, built with Vite into `dist/web`). The server now holds the first freighter to a moon until the moons it depends on are settled, and the scheduler also holds it while the moon's planet depends on other planets. Without a label the owner would see a ready-looking moon that nothing is happening to. The server already sends the two lists on every assigned moon row (`waiting_on`: task ids; `waiting_on_planets`: stream ids), both in the snapshot and in the moon detail. Rows on the page are loosely typed (`Record<string, unknown>`), so the fields are read defensively. Buttons do not change: a human may still try to send a freighter and will get the server's own refusal text. Wording rule: places don't move, ships do — the label says the moon is *waiting on* something; never "blocked from launching". The suite cannot render components, so the tests are bundle-string and source-text checks; a reviewer will render the components separately. Affected workflow IDs is `none` because this project has no review suite.

## Files

### Touch
| Path | Action | Notes |
|------|--------|-------|
| `tests/http/page-waiting.test.mjs` | create | the acceptance test, written first |
| `web/src/components/SystemView.tsx` | modify | label on an assigned moon's row |
| `web/src/components/MoonDetail.tsx` | modify | label at the top of the panel |
| `web/src/style.css` | modify | only if the label needs a rule; prefer existing classes |

### Do NOT touch
- `web/src/components/Header.tsx`, `web/src/types.ts` — owned by task V1-SCHEDULER.08 (merged)
- `web/src/components/ActionBar.tsx` — action buttons are unchanged
- `web/src/store.ts`, `web/src/api.ts`, every other component
- The other `tests/http/page-*.test.mjs` — they must stay green unmodified
- `src/**` — no server changes
- Do not add a new file under `web/src/` for a shared helper: if neither of the two components already imports from the other, duplicate the few lines.
- Any file not listed under Touch. If completing the objective seems to require touching an unlisted file, STOP and report BLOCKED.

**Standing exclusions:**
- Security-routed files, never modified by this lane: `src/core/git.ts`, `src/validate/**`, `src/providers/claude-sdk/gate-hook.ts`, `src/server/dispatch.ts`, `src/db/migrations/**`, `src/server/http/auth.ts`, `src/server/lock.ts`
- Pipeline-owned paths: `docs/superpowers/plans/**`, `docs/superpowers/tasks/**`, `.superpowers/sdd/**`
- `package.json`, `package-lock.json` — no dependency changes

## Interfaces

Exact copy (strings must appear verbatim in the built bundle):

```text
waiting on <id>, <id>                 from waiting_on          (ids joined with ", ")
waiting on planet <stream>, <stream>  from waiting_on_planets  (ids joined with ", ")
```

Consumed (exact current shapes; do not change them):

```ts
// web/src/types.ts
export type Row = Record<string, unknown>;
// Snapshot.systems[].planets[].moons[] : Row   — assigned rows carry  waiting_on: string[]  and  waiting_on_planets: string[]
// MoonDetail.moon : Row                         — carries the same two fields
// web/src/components/SystemView.tsx
export function SystemView({ b }: { b: Bridge }): JSX.Element
//   an assigned moon renders as  <div className={`row${...}`} key={moonId} onClick={() => b.openMoon(taskId)}> … <span className="badge">{text(moon["status"])}</span> … </div>
// web/src/components/MoonDetail.tsx
export function MoonDetail({ b }: { b: Bridge }): JSX.Element | null
//   b.detail is the MoonDetail read (or null while loading); both files already define  const text = (value: unknown): string => typeof value === "string" ? value : "";
```

## Constraints
- Read each field defensively: anything that is not an array is treated as empty, and non-string or empty entries are dropped.
- When `waiting_on` is non-empty render `waiting on <ids>`; when `waiting_on_planets` is non-empty render, as a separate element, `waiting on planet <streams>`. Both can show at once. When both are empty nothing is rendered — no empty element, no placeholder.
- In the system view the label sits inside the moon's row, after the status badge, and must not swallow the row's click (the row still opens the moon).
- In the detail panel the label sits at the top of the panel, above the tabs, and is shown from `b.detail.moon`; nothing is shown while `b.detail` is null.
- Action buttons and every existing element are unchanged.
- Long lists wrap rather than overflow at a narrow width (about 400 px).
- No new dependencies. TypeScript strict (`npm run build:web` type-checks `web/`).

## Acceptance

**Test command (must exit 0):**
```bash
npm test -- "tests/http/page-*.test.mjs"
```

**Behavioral criteria** (each must be covered by an assertion in `tests/http/page-waiting.test.mjs`, written in the style of `tests/http/page-panels.test.mjs`: read the built bundle under `dist/web/assets` and the component sources):
1. The bundle contains `waiting on ` and `waiting on planet `.
2. `web/src/components/SystemView.tsx` references both `waiting_on` and `waiting_on_planets`.
3. `web/src/components/MoonDetail.tsx` references both `waiting_on` and `waiting_on_planets`.
4. Neither source contains `blocked` in the new copy (assert the bundle does not contain `blocked from`).
5. The existing page tests in the same command stay green unmodified.

**Affected workflow IDs**: none

**Regression guard (task level — implementer runs this):**
```bash
npm test
```

## Out of Scope
- No server changes; the two fields are already in the reads.
- Do not disable, hide or relabel any action button.
- No links from an id to its moon or planet, no tooltips.
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
