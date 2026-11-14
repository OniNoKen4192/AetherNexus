# Seed — 2026-11-14

**HEAD at close:** 2ed15142f84cfbf6e0960190bb2b6f11fa99080c

**Where we left off:** v0.5 Bridge is merged to main (PR #2) with CI green. `nexus serve` and the browser page cover the whole moon lifecycle; the release's done-when (a REJECT handled entirely from the browser) is proven by an e2e test and a Chrome walkthrough. Next phase per `docs/2026-10-10-aether-nexus-design.md` §14 is v1 — Nexus: fuel gauge, limiter and rung selector on the Bridge, intake adapters, triage/decompose/plan roles, `highways` + `autopilot`, gravity, the bug path, Drydock.

**Parked:**
- Merged branches not deleted: local `design/v0.5-bridge` and eleven `lanes/V0.5-BRIDGE.*`; remote `origin/design/v0.5-bridge`.
- Empty folders under `.lanes/worktrees/V0.5-BRIDGE.*` (deregistered; Windows held the handles) and a stale record `.lanes/state/V0.5-BRIDGE.12.json.stale-53d70a3` — git-ignored, delete by hand.
- Git-ignored SDD ledger `.superpowers/sdd/2026-11-13-v0.5-bridge/` — the only copy of every ruling, the walkthrough report and the final-review triage; keep or delete.
- `~/.codex/config.toml` has `[windows] sandbox = "elevated"` (backup `config.toml.bak-2026-11-13`); needed for Lanes runs on this machine.
- Bridge minors left open by the final review: routing buttons can stay disabled until reload if another client restores the exact previous order mid-move (`web/src/components/Routing.tsx`); a persistently failing db read logs every poll with no backoff (`src/server/follow.ts`); a voyage whose other-process owner dies shows as running elsewhere until the next refresh; Fleet lists every ship of unused providers.
- Not exercised in the browser: Drop, Park stale, "Not me", an errored spec in the assign list, a voyage failure notice, a narrow window; the final fix wave's page changes were reviewed by reading only.
- No rendering tests for the page in the suite (bundle-string and source-text checks only).
- `npm audit`: 5 advisories in transitive packages (hono, qs), predating v0.5; no `audit fix` run.
- When adding npm packages on Windows, the lock can miss optional cross-platform entries: PR #2 needed `@emnapi/core` and `@emnapi/runtime` added by hand before `npm ci` passed on CI.
- Carried from 2026-10-14, not re-checked, still listed as open: `origin/design/v0-skeleton` on GitHub; ledger `.superpowers/sdd/2026-10-13-v0-skeleton/`; stray `nexus-repo-*` / `nexus-db-*` dirs in `%TEMP%`; spec drift (`.nexus/state/` gitignored vs spec §3.5; kinds with no reducer; planet-level `plan` voyages cannot be stored); git refusal list is a denylist; Bash in the Claude implementer is only backstopped; `commands/`/`agents/` still reference the retired validator.

**See:** triplog.md (2026-11-14 entry) for the session narrative.

**First action on resume:** go through the Parked list above with the owner and clear or re-park each item, then brainstorm the v1 scope (superpowers:brainstorming) from parent design §14's v1 row, deciding first which slice comes first — the limiter and fuel gauge on the Bridge, or intake adapters.
