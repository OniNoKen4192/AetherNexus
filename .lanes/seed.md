# Seed — 2026-10-14

**HEAD at close:** bbb92b9c8921258c10dfef920c11316d98145194

**Where we left off:** v0 skeleton merged to main with CI green and both live adapters verified. Next phase per `docs/2026-10-10-aether-nexus-design.md` §14 is v0.5 — the Bridge: WebSocket event feed, decisions panel, routing matrix, and the daemon that enables concurrent voyages (retire the single-flight git-log ruling with a per-voyage hook).

**Parked:**
- `origin/design/v0-skeleton` still exists on GitHub (merged) — delete or keep.
- Git-ignored SDD ledger `.superpowers/sdd/2026-10-13-v0-skeleton/` — the only copy of every ruling; keep or delete.
- ~600 stray `nexus-repo-*` / `nexus-db-*` dirs in `%TEMP%` from earlier test runs (leak since fixed) — delete by hand.
- Spec drift vs. code: `.nexus/state/` is gitignored though spec §3.5 says committed; spec §3.4 lists kinds with no reducer (`moon.settled`, `moon.emitted`, `moon.quarantined`); `voyages.task_id`/`assignment_id` are NOT NULL so planet-level `plan` voyages cannot be stored yet.
- Accepted gaps to revisit: git refusal list is a denylist (an allowlist is a follow-up); Bash in the Claude implementer is only backstopped (audit + main-tree snapshot + baseline hash); `max_fix_rounds` counts relaunches; `decisions.target_id` is the task id; conformance §5.4 cross-reference check deleted while `commands/`/`agents/` still reference the retired validator.
- Codex: ChatGPT accounts currently offer `gpt-5.6-sol/terra/luna` and `gpt-6-*`; `~/.codex/config.toml` default is `gpt-5.6-sol`; `OPENAI_API_KEY` in the shell triggers a `codex doctor` mixed-auth warning.

**See:** triplog.md (2026-10-14 entry) for the session narrative.

**First action on resume:** brainstorm the v0.5 Bridge spec (superpowers:brainstorming), starting from spec §8.1's "every command is a thin wrapper the WebSocket handler calls" and the ledger's single-flight/daemon notes.
