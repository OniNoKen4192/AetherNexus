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

## Commands
- No dependencies to install; plain Node (CI tests Node 22 and 24).
- Validator selftest: `node bin/lanes-validate.mjs selftest`
- Full suite: `node --test` (~2 min). Single file: `node --test tests/<file>`
- CI (`.github/workflows/ci.yml`) runs both on Linux, Windows and macOS.

## Gotchas
- The upstream Lanes plugin (`lanes@lanes`) is installed in this Claude Code environment; editing files here does not change it. This fork's plugin is named `nexus` so the two can load side by side. Command/agent/config names inside are still `lanes-*` until ported (see `docs/2026-10-10-aether-nexus-design.md` §12).
