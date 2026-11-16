# TASK: bridge-rung-selector-fix1

## Meta
- **Task ID**: V1-SCHEDULER.08-FIX1
- **Parent plan**: docs/superpowers/plans/2026-11-15-v1-scheduler.md
- **Depends on**: V1-SCHEDULER.07
- **Estimated scope**: M
- **Model hint**: terra

## Objective
Two things are wrong in the Bridge header's trust-rung selector.
1. When `roundabout` is awaiting confirmation and the live `ready_to_send` falls to 0 or goes missing, the confirmation line and its buttons vanish while the selector keeps showing `roundabout`, with nothing sent and no way to cancel. The line must instead stay up, showing the live number, until `Raise`, `Cancel` or another choice.
2. At widths below about 584 px the select is wider than the header and the page scrolls horizontally. It must shrink to fit.

## Context
This is fix round 1 of task V1-SCHEDULER.08; the round-0 work is committed in this worktree and this task edits on top of it. The confirmation line is currently rendered from `pending === "roundabout"` and the live count being above zero, so the count alone can remove it. The owner must never see the selector on a rung the server is not at without the line that explains it. The decision is made: the line is held by its own boolean state and stays up whatever the count does, reading "0 freighters now" when the count is 0. Do not auto-send and do not auto-cancel when the count changes. The same derivation also makes the line flash while an immediate `roundabout` command (chosen at count 0) is in flight if the count rises meanwhile; holding the line in its own state fixes that too. The overflow is a CSS matter: the select is a flex item inside `.rung-control` and cannot shrink below the label's full width. The suite cannot render components, so the tests are source-text checks; a reviewer renders the component separately. Affected workflow IDs is `none` because this project has no review suite.

## Files

### Touch
| Path | Action | Notes |
|------|--------|-------|
| `tests/http/page-rung-pending.test.mjs` | create | first; exactly the content given under Acceptance |
| `web/src/components/Header.tsx` | modify | the confirmation state only |
| `web/src/style.css` | modify | one declaration added to the existing `.rung-control .field` rule; nothing else |

### Do NOT touch
- `tests/http/page-rung.test.mjs` and every other `tests/http/page-*.test.mjs` — they must stay green unmodified
- `web/src/types.ts`, `web/src/components/ActionBar.tsx`, `SystemView.tsx`, `MoonDetail.tsx`, `Routing.tsx`, `Decisions.tsx`, `Fleet.tsx`, `web/src/store.ts`, `web/src/api.ts`, `web/src/main.tsx`
- `src/**` — no server changes
- Any file not listed under Touch. If completing the objective seems to require touching an unlisted file, STOP and report BLOCKED.

**Standing exclusions:**
- Security-routed files, never modified by this lane: `src/core/git.ts`, `src/validate/**`, `src/providers/claude-sdk/gate-hook.ts`, `src/server/dispatch.ts`, `src/db/migrations/**`, `src/server/http/auth.ts`, `src/server/lock.ts`
- Pipeline-owned paths: `docs/superpowers/plans/**`, `docs/superpowers/tasks/**`, `.superpowers/sdd/**`
- `package.json`, `package-lock.json` — no dependency changes

## Interfaces

```ts
// web/src/components/Header.tsx — signature unchanged
export function Header({ b }: { b: Bridge }): JSX.Element
```

Exact text (the test checks it character for character):

```text
must appear in Header.tsx:       const [confirming, setConfirming] = useState(false);
must appear in Header.tsx:       {confirming && (
must NOT appear in Header.tsx:   > 0 && (
must NOT appear in Header.tsx:   {snapshot.ready_to_send}
style.css, the existing rule:    .rung-control .field { width: auto; max-width: 100%; min-width: 0; }
```

Unchanged and still required: the option values and copy, `aria-label="Trust rung"`, the confirmation copy, the `Raise` and `Cancel` buttons, the command `config.automation` with body `{ level }`, and `useCommand` imported from `./ActionBar`.

## Constraints
- `confirming` becomes true only when `roundabout` is chosen while the count is above 0. It becomes false when the `Raise` command has been answered (accepted or refused), when `Cancel` is pressed, or when any other option is chosen.
- The confirmation line (the text and both buttons) is rendered exactly when `confirming` is true. No live value may remove it.
- The count is `snapshot.ready_to_send` when that is a number and `0` otherwise; compute it once and use that one value both for the decision in the change handler and for the number printed in the line. The copy is ` freighter now.` when the number is 1 and ` freighters now.` otherwise, so 0 reads `Raising to roundabout sends 0 freighters now.`
- While `confirming` is true the selector shows `roundabout`. `Raise` sends `config.automation` with `{ level: "roundabout" }` whatever the count is, including 0. `Cancel` sends nothing and puts the selector back on `snapshot.rung`.
- Choosing `roundabout` while the count is 0 sends the command at once and never sets `confirming`; the line must not appear while that command is in flight, even if the count rises meanwhile.
- All other behaviour stays exactly as it is now:
  - `manual` and `verdicts` are sent at once;
  - the selector and both buttons are disabled while a command is in flight;
  - a refused command shows `command.error` in the `.msg-error` line under the summary and leaves the selector on `snapshot.rung`;
  - the disabled fourth option appears for `highways` / `autopilot`;
  - no `confirm`, `alert` or dialog.
- CSS: add `min-width: 0` to the existing `.rung-control .field` rule and change nothing else in `style.css`.
- No new dependencies; Preact hooks only. TypeScript strict (`npm run build:web` type-checks `web/`).

## Acceptance

**Test command (must exit 0; it exits 1 today):**
```bash
npm test -- "tests/http/page-rung-pending.test.mjs"
```

**Also must exit 0:**
```bash
npm test -- "tests/http/page-*.test.mjs"
```

Create `tests/http/page-rung-pending.test.mjs` first, with exactly this content:

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const withoutCarriageReturns = (text) => text.split(String.fromCharCode(13)).join("");

test("the confirmation line is held by its own state, not by the live count", async () => {
  const source = withoutCarriageReturns(await readFile("web/src/components/Header.tsx", "utf8"));
  assert.ok(source.includes("const [confirming, setConfirming] = useState(false);"), "Header.tsx does not declare the confirming state");
  assert.ok(source.includes("{confirming && ("), "the confirmation line is not rendered from confirming alone");
  assert.ok(!source.includes("> 0 && ("), "a render guard in Header.tsx still depends on a count being above zero");
  assert.ok(!source.includes("{snapshot.ready_to_send}"), "the line prints the raw ready_to_send instead of the normalised number");
});

test("the rung selector can shrink inside its label", async () => {
  const css = withoutCarriageReturns(await readFile("web/src/style.css", "utf8"));
  const start = css.indexOf(".rung-control .field {");
  assert.notEqual(start, -1, "style.css has no .rung-control .field rule");
  const rule = css.slice(start, css.indexOf("}", start));
  assert.ok(rule.includes("min-width: 0"), "the .rung-control .field rule does not declare min-width: 0");
});
```

**Behavioral criteria** (1 to 3 are covered by the test above; 4 to 7 are checked by the reviewer's render, because the suite cannot render components):
1. `Header.tsx` declares the `confirming` state and renders the confirmation line from `{confirming && (`.
2. `Header.tsx` contains neither `> 0 && (` nor `{snapshot.ready_to_send}`.
3. The `.rung-control .field` rule in `style.css` declares `min-width: 0`.
4. With the line up, a snapshot with `ready_to_send` 0 or missing leaves the line and both buttons in place, reading `Raising to roundabout sends 0 freighters now.`; `Cancel` then restores the selector to `snapshot.rung` and sends nothing; `Raise` sends `config.automation` `{ level: "roundabout" }`.
5. `roundabout` chosen at count 0 is sent at once and no line appears, even if the count rises while the command is in flight.
6. Choosing another option while the line is up removes the line and sends that option at once.
7. At a 400 px viewport the select's right edge is not past the right edge of `.bridge-summary` and the document does not scroll horizontally.

**Affected workflow IDs**: none

**Regression guard (task level — implementer runs this):**
```bash
npm test
```

## Out of Scope
- Do not change what happens after a command is accepted (the selector following the next snapshot), and do not add optimistic updates.
- Do not change copy, option order, class names or markup structure beyond what the constraints require.
- Do not edit `tests/http/page-rung.test.mjs`; do not add other CSS rules or media queries.
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
