# TASK: bridge-waiting-labels-fix1

## Meta
- **Task ID**: V1-SCHEDULER.09-FIX1
- **Parent plan**: docs/superpowers/plans/2026-11-15-v1-scheduler.md
- **Depends on**: V1-SCHEDULER.08
- **Estimated scope**: S
- **Model hint**: terra

## Objective
Three layout defects of the "waiting on" labels, all in the stylesheet:
1. In the system view, a waiting label inside a moon's row is squeezed into a sliver instead of wrapping readably. When the System panel is 280 px wide (browser 1100 px wide with a moon open), `waiting on V1-SCHEDULER.13` renders 24 px wide over 23 lines and a 12-id list renders one character per line in a row 3490 px tall. At a 400 px panel a 12-id list is a 103 px column of 24 lines. In every labelled row the task id and the moon name are squeezed onto two lines. After this task a label that does not fit beside the moon takes its own line under it, at up to the full row width, and the name and task id keep their one line.
2. In the moon detail, when both labels fit on one line they touch with no gap. After this task each label is on its own line with a small gap.
3. A label that wraps to several lines keeps the 999px pill radius of `.badge`, so the border arc crosses the first and last lines of text. After this task the label has a small radius of its own.

## Context
This is fix round 1 of task V1-SCHEDULER.09; the round-0 work is committed in this worktree. Round 0 added `<span className="badge waiting-label">` inside the moon row (`web/src/components/SystemView.tsx`) and `<div className="badge waiting-label">` as direct children of `section.moon-detail` (`web/src/components/MoonDetail.tsx`), plus one `.waiting-label` rule in `web/src/style.css`. The markup, copy, defensive reads, click behaviour and placement were all reviewed in a render and are correct: do not change them. The row is a non-wrapping flex line (`.row`), and `min-width: 0` with `overflow-wrap: anywhere` makes the label the one item that gives up all the space. The fix is the three style rules under Interfaces; they were measured in headless Chrome against the round-0 markup and work without any markup change. `.row` and `.badge` are shared with other panels and must stay exactly as they are; the new rules only apply where a waiting label is present. The suite cannot render components, so the test pins the style rules; a reviewer will render the page again. Affected workflow IDs is `none` because this project has no review suite.

## Files

### Touch
| Path | Action | Notes |
|------|--------|-------|
| `tests/http/page-waiting-layout.test.mjs` | create | the acceptance test, written first |
| `web/src/style.css` | modify | replace the one `.waiting-label` rule with the three rules under Interfaces |

### Do NOT touch
- `web/src/components/SystemView.tsx`, `web/src/components/MoonDetail.tsx` — the markup is correct; no class, element or attribute changes
- `tests/http/page-waiting.test.mjs` and every other `tests/http/page-*.test.mjs` — they must stay green unmodified
- In `web/src/style.css`: every rule other than `.waiting-label`. In particular the `.row`, `.badge`, `.system-moons .row code` and `.moon-detail-heading` rules stay byte-identical
- `web/src/components/Header.tsx`, `web/src/components/ActionBar.tsx`, `web/src/types.ts`, `web/src/store.ts`, `web/src/api.ts`, every other component
- `src/**` — no server changes
- Any file not listed under Touch. If completing the objective seems to require touching an unlisted file, STOP and report BLOCKED.

**Standing exclusions:**
- Security-routed files, never modified by this lane: `src/core/git.ts`, `src/validate/**`, `src/providers/claude-sdk/gate-hook.ts`, `src/server/dispatch.ts`, `src/db/migrations/**`, `src/server/http/auth.ts`, `src/server/lock.ts`
- Pipeline-owned paths: `docs/superpowers/plans/**`, `docs/superpowers/tasks/**`, `.superpowers/sdd/**`
- `package.json`, `package-lock.json` — no dependency changes

## Interfaces

`web/src/style.css` — the current rule

```css
.waiting-label { min-width: 0; max-width: 100%; white-space: normal; overflow-wrap: anywhere; }
```

is replaced, in the same place (directly after the `.badge` rule), by exactly these three rules (selectors exact; `border-radius` may be any whole px value from 4 to 12):

```css
.waiting-label { max-width: 100%; white-space: normal; overflow-wrap: anywhere; border-radius: 10px; }
.system-moons .row:has(> .waiting-label) { flex-wrap: wrap; }
.moon-detail > .waiting-label { display: block; width: fit-content; margin-bottom: 4px; }
```

Consumed, unchanged (exact current text):

```css
.row { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 4px; cursor: pointer; }
.badge { display: inline-block; padding: 0 7px; border-radius: 999px; border: 1px solid var(--border); font-size: 12px; color: var(--muted); }
```

## Constraints
- Stylesheet only. No markup, no script, no new class names, no new dependencies.
- Do not add `order`, `flex-basis` or any other declaration to the labels beyond the rules above; a label that fits beside the moon stays on the moon's line as it does today.
- A one-line comment above the new rules is allowed.
- The test follows the style of `tests/http/page-panels.test.mjs` (it reads `web/src/style.css` as text; see its "existing shared style selectors" test).

## Acceptance

**Test command (must exit 0):**
```bash
npm test -- "tests/http/page-waiting-layout.test.mjs"
```

**Behavioral criteria** (each must be covered by an assertion in `tests/http/page-waiting-layout.test.mjs`, which reads `web/src/style.css` with comments stripped and looks rules up by exact selector, whitespace-normalised):
1. A rule with selector `.system-moons .row:has(> .waiting-label)` declares `flex-wrap: wrap`.
2. The `.waiting-label` rule declares `max-width: 100%`, `white-space: normal`, `overflow-wrap: anywhere`, and a `border-radius` of its own in px between 4 and 12 inclusive.
3. A rule with selector `.moon-detail > .waiting-label` declares `display: block`, `width: fit-content` and `margin-bottom: 4px`.
4. The `.row` and `.badge` rule bodies equal the exact text under Interfaces (whitespace-normalised).

**Affected workflow IDs**: none

**Regression guard (task level — implementer runs this):**
```bash
npm test
```

## Out of Scope
- Do not change `SystemView.tsx`, `MoonDetail.tsx` or `tests/http/page-waiting.test.mjs`.
- Do not restyle `.row` or `.badge`, and do not add a narrow-viewport layout for the page (the page already scrolls sideways at a 400 px viewport; that is not this task).
- Do not move the failure badge or change the label copy.
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
