# Seed — 2026-11-20

**HEAD at close:** 42ec34f13c91bc4179219fb987d548e2eb15774a

**Where we left off:** v1 slices 1 and 2 and the command rename are merged to `main` (PRs #4–#6). The ship catalogue is complete on `design/ship-catalogue` (all ten plan tasks plus the stranded-ship fix; 764 tests / 760 pass / 4 live skipped) but is not pushed and has no PR. The next round is the follow-up items, one at a time; item 1 is proposed and waiting for the owner's go.

**Parked:**
- `design/ship-catalogue`: 27 commits ahead of `origin/main` (plus the rest-stop commit), no upstream, no PR. Needs the owner's explicit go to push.
- Follow-ups, in order: (1) `verdicts` never sends to a `gated` moon that was already visited (`src/server/scheduler/plan.ts`, the send rule); proposed fix: allow it when the moon was visited; (2) a newer wall hit can shorten a known longer hold; (3) a pickup after a wall hit in a fix round does not carry customs' instructions; (4) the test guard (`makeGalaxy`) does not cover a second galaxy handle or a CLI child process; (5) a crash between a customs return and its verdict leaves the moon `reviewing` with no action (`availableActions` in `src/server/commands/query.ts`; the verdict is in the `voyage.returned` report). Proposed branch: `fix/fuel-followups`.
- Merged branches not deleted: 26 local `lanes/*`; local and remote `design/v1-fuel`, `design/v1-scheduler`, `chore/npm-audit-fix`, `chore/send-freighter-rename`.
- 14 empty folders under `.lanes/worktrees/` (`V1-FUEL.*`, `V1-SCHEDULER.09`); git-ignored, delete by hand.
- Git-ignored ledgers under `.superpowers/sdd/` (scheduler, fuel, ship catalogue): the only copy of the reviewers' minors; keep or delete.
- Not seen in the browser for the ship catalogue: a truly narrow window, a Retire click, the rung selector.
- The stored words `dropped` / `moon.dropped` and the `drop` outcome need a migration; ship art per faction is not designed; v1 slices 3–6 are not designed.
- Carried from the 2026-11-14 seed, not re-checked: Bridge minors (`Routing.tsx`, `src/server/follow.ts`), no rendering tests for the page, older v0 items (see that seed in git history, commit 47ba846).

**See:** triplog.md (2026-11-20 entry) for the session narrative.

**First action on resume:** get the owner's answer on pushing `design/ship-catalogue` and opening its PR, then start follow-up 1 on `fix/fuel-followups`.
