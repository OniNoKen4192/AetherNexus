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
- v0.5 (2026-11-13): `nexus serve` — loopback HTTP server (`src/server/http/`) plus the Bridge page (`web/`, Preact + Vite, built to `dist/web`). The feed is server-sent events, not the WebSocket the parent design first named; commands are HTTP POST. Voyages run concurrently; the single-flight git log is replaced by a per-voyage scope (`withGitLog`). Fuel, limiter and rung selector deferred to v1.
- v1 slice 1 (2026-11-15): the scheduler lives in `src/server/scheduler/` (`plan.ts` decides, `loop.ts` acts) and runs only inside `nexus serve`. `automation.level` now changes behaviour: `manual` does nothing by itself, `verdicts` inspects, docks and re-runs fixes after a human sent the first freighter, `roundabout` also sends the first freighter to every ready moon; `highways` and `autopilot` load as `roundabout` and cannot be selected yet. A first freighter is refused until the moon's dependencies are settled, at every rung. An action refused twice in a row parks the moon (`scheduler_refused` / `scheduler_error`). Design: `docs/superpowers/specs/2026-11-14-v1-scheduler-design.md`.
- v1 slice 2 (2026-11-18): fuel and the limiter (`src/server/limiter/`). Adapters report `fuel` readings, stored as `fuel.reading` (proven on fixtures and the fake adapter; the real adapters' readings await the live check, plan Task 16); each provider's pool is `ok`, `low` (below `pool.reserve_floor`), `dry` (a ship hit the wall, until the reset), `unknown` or `free`. Every launch and inspection asks the limiter first, whoever sends it: a low pool holds freighters, a dry pool holds customs too, a held ship is rerouted down the role order or waits (`limiter.held`, never a park). A ship that hits the wall mid-run ends `out_of_fuel`, is released, and the moon's cargo is `awaiting_pickup` (customs: back to `audited`); the scheduler sends the next ship after the reset. A second hit in a row on the same provider parks the moon `rate_limited`. `adrift` now means only "needs a person". `pool.refuel { provider, models, min_wait_minutes }` lets a held freighter fly a cheaper model on another provider instead of waiting (`limiter.refuelled`, `refuel_for`). A pickup whose cargo fails its audit parks with the Bridge wording "contraband in the cargo" (`carryover_violations`) or "raided by pirates" (`baseline_tampered`). Bridge: fuel gauge per provider, "waiting on <provider> fuel", `Refuel`, `Send anyway`; CLI `--override`, `--refuel`. Migration 002 adds the two statuses. Design: `docs/superpowers/specs/2026-11-15-v1-fuel-design.md`; plan: `docs/superpowers/plans/2026-11-15-v1-fuel.md`.
- Renames still open (wording only, no behaviour): `moon.launch` → send a freighter; `moon.drop` → cancel the delivery.

## Commands
- `npm install` (SDK + MCP client deps; Preact + Vite as dev deps); `npm run build` (tsc to `dist/`, then `npm run build:web` builds the Bridge page from `web/` to `dist/web`).
- `npm test`: full suite, ~105 s, builds first. One area: `npm test -- "tests/<dir>/*.test.mjs"` (Node 22.14 rejects a bare directory argument).
- Real adapters: `NEXUS_LIVE=1 npm test -- "tests/live/*.test.mjs"`. Never CI; spends the user's pool, so ask first.
- Validator selftest: `node dist/cli/main.js validate --selftest`
- Bridge: `node dist/cli/main.js serve [--port <n>]` (127.0.0.1, default 7341; open the printed URL). Also `nexus events --follow` and `nexus decision answer <id> --mine | --not-mine`.
- Trust rung: `nexus config set trust <manual|verdicts|roundabout>` (a running server picks the change up), or the selector in the Bridge header.
- CI (`.github/workflows/ci.yml`) runs the suite on Linux, Windows and macOS.

## Gotchas
- `npm test` builds first; a stale `dist/` is the usual cause of a test importing a function that "does not exist".
- `node:sqlite` prints an ExperimentalWarning unless run via the npm scripts or the `nexus` entry.
- `npm install` / `npm audit fix` on Windows can drop the optional `@emnapi/core` and `@emnapi/runtime` lock entries, and `npm ci` then fails on Linux and macOS CI: check `git diff package-lock.json` before pushing.
- The default `roles.implement` is `["codex", "fake"]` and `roles.review` is `["claude", "fake"]`. A reroute walks that order, so a galaxy that keeps the default sends a held freighter to the `fake` provider, which does no real work: set the roles before running unattended.
- Tests: `makeGalaxy` (tests/helpers.mjs) makes every non-fake adapter throw, so a test cannot spend a real pool. A config patch must still pin `c.roles` to fake providers, or its voyages park `backend_failure` with that guard's message. The guard does not cover a second `openGalaxy` handle or a CLI child process.
- The limiter's clock is `g.now()`; a wall hit holds a pool for at least 60 s whatever reset the provider gave. Tests move `g.now` instead of sleeping.
- The upstream Lanes plugin (`lanes@lanes`) is installed in this Claude Code environment; editing files here does not change it.
