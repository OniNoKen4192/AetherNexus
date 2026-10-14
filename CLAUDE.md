# AetherNexus

Fork of Lanes (https://github.com/OniNoKen4192/Lanes), a Claude Code plugin for cross-model task routing. Substantial changes planned — see "Fork notes" below.

## Communication
- Keep replies concise: lead with the answer or result, then only the detail needed to act on it.
- Teach as you go: when making a non-obvious choice, give the one-sentence "why" (the principle, tradeoff, or mechanism), not a tutorial.
- Separate fact from inference. State what was verified (file read, command run, test output) versus what is assumed, and label guesses as guesses.
- Don't speculate beyond the evidence. If something is unknown, say so and name the check that would resolve it — then run that check when it's cheap.
- Never claim something works without evidence: show the command and its result.

## Workflow
- Read the relevant code before proposing changes; cite locations as `path:line`.
- For multi-file or unclear changes, explore and plan before editing. Small, obvious fixes: just do them.
- Keep diffs scoped to the task. No drive-by refactors; flag them instead.
- Fix root causes, not symptoms. Don't suppress errors or skip hooks/tests to get green.
- Commit only when asked. Work on feature branches, never directly on `main`.
- Every third-party file (3D model, texture, font, sound) gets a line in `assets/LICENSES.md` — source URL and license — in the same commit that adds it.

## Fork notes
- `origin` = OniNoKen4192/AetherNexus, `upstream` = OniNoKen4192/Lanes. Sync with `git fetch upstream` + merge/rebase. Push to `upstream` is disabled locally.
- Record divergences from upstream here as they're decided (architecture, renamed modules, dropped features).
- v0 (2026-10-14): `bin/lanes-validate.mjs` and `hooks/` retired; ported to `src/validate`, `src/core/git.ts`, `src/providers/claude-sdk/gate-hook.ts`.

## Commands
- `npm install` (SDK + MCP client deps); `npm run build` (tsc to `dist/`).
- `npm test`: full suite, ~70 s, builds first. One area: `npm test -- "tests/<dir>/*.test.mjs"` (Node 22.14 rejects a bare directory argument).
- Real adapters: `NEXUS_LIVE=1 npm test -- "tests/live/*.test.mjs"`. Never CI; spends the user's pool, so ask first.
- Validator selftest: `node dist/cli/main.js validate --selftest`
- CI (`.github/workflows/ci.yml`) runs the suite on Linux, Windows and macOS.

## Gotchas
- `npm test` builds first; a stale `dist/` is the usual cause of a test importing a function that "does not exist".
- `node:sqlite` prints an ExperimentalWarning unless run via the npm scripts or the `nexus` entry.
- The upstream Lanes plugin (`lanes@lanes`) is installed in this Claude Code environment; editing files here does not change it.
