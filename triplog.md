# Triplog

Session-by-session project memory, newest first: what shipped, what
was decided and why, what was left loose. Written by /lanes-rest-stop;
the dated specs remain the deep record each entry links to.

## 2026-10-14 — Fork Lanes → Aether Nexus; v0 skeleton designed, built, merged

**Shipped:** c5991ab..bbb92b9 (PR #1, merge commit) — standalone Node/TypeScript orchestrator: append-only SQLite event log with pure-reducer projections and byte-equal rebuild; generated terrain (systems→planets→moons) and a named ship roster per provider; `Git` class as the only git caller (refusal list, ceiling dirs, scrubbed env, worktrees under `.nexus/worktrees/`); ported gate/audit; moon/voyage transition tables; launch/inspect/dock/reply/drop/park/retire commands; fake, claude-sdk and codex-mcp adapters; `nexus` CLI; e2e suite on every fake script (CI gate, green on 5 OS/Node jobs); `bin/lanes-validate.mjs` and `hooks/` retired. Live: Claude and Codex adapters pass; stretch (Codex implements, Claude approves, dock) proven in a scratch repo.

**Decisions:**
- Places don't move, ships do: tasks are moons (terrain generated at system create, grown by discovery), work travels as voyages of named ships; Fleet HQ = integration branch. Why: the UI tracks ship movement; moons popping in/out made no sense. Spec `docs/superpowers/specs/2026-10-13-v0-skeleton-design.md` §4.0–4.2.
- Integration branch at every rung (tightening Lanes, which merged into the working branch below `highways`): the server does the merging, so the cost is nil. Parent design §7.
- Fake adapter is v0's CI gate; real adapters are a stretch, because CI can't log in. Spec §1.
- History keyed by assignment id, not task id or moon body — drop + re-assign (same or different id) must not inherit history. Two rounds of fixes; rejected: task-id keying (not unique across assignments).
- Git safety judged by the repository git resolves to, not the path string (`GIT_CEILING_DIRECTORIES`, stripped `GIT_*` env, registration check) after a probe committed onto `main` from a leftover worktree shell.
- Dock and FIX carry-over re-audit before committing; audit exempts exact `carried_sha` values instead of a spoofable author email; allowlist narrowed so `.nexus/config.json` edits are out of scope.
- `tools:` is a strict allowlist in the Agent SDK (spike-proven, `docs/spikes/2026-10-14-sdk-probe/`) → per-role tools lists, not `disallowedTools`.
- Paths canonicalized with `realpathSync.native` — GitHub Windows runners use 8.3 short TEMP paths.
- Schema stayed on migration 001 throughout (pre-release; no persisted DBs).
- Full ledger of ~30 rulings and deferred minors: `.superpowers/sdd/2026-10-13-v0-skeleton/progress.md` (git-ignored).

**Loose ends:** see `.lanes/seed.md` (2026-10-14).
