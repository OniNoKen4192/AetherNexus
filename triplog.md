# Triplog

Session-by-session project memory, newest first: what shipped, what
was decided and why, what was left loose. Written by /lanes-rest-stop;
the dated specs remain the deep record each entry links to.

## 2026-11-14 — v0.5 Bridge designed, built through Lanes, merged

**Shipped:** bbb92b9..2ed1514 (PR #2, merge commit) — `nexus serve`: a loopback HTTP server (127.0.0.1, per-start token exchanged for an HttpOnly SameSite=Strict cookie, Host and Origin checks, `.nexus/server.json` lock) with reads, a server-sent-events feed with `Last-Event-ID` replay, HTTP commands and a voyage runner that runs voyages concurrently and cancels them; limits enforced inside the launch transaction; per-voyage git log scope (`withGitLog`) replacing the single-flight ruling; main-tree change detection with a "was that you?" decision (`nexus decision answer`); `nexus events --follow`; the Bridge page (`web/`, Preact + Vite, built to `dist/web`) covering the whole moon lifecycle, routing order and ship retire. 379 tests (2 live skipped); CI green on 5 OS/Node jobs. Done-when proven twice: `tests/e2e/bridge.test.mjs` and a Chrome walkthrough (REJECT → reply → APPROVE → dock from the page).

**Decisions:**
- Server-sent events, not the WebSocket the parent design named: the feed is one-way, so SSE gives reconnect and replay for free; commands are plain HTTP POST. Spec `docs/superpowers/specs/2026-11-13-v0.5-bridge-design.md`.
- Cookie auth on loopback stands. The cookie is not port-scoped (browsers don't scope by port); cross-origin requests are refused and every `GET /api/*` is read-only. Documented as a known limitation in the README.
- The page decides nothing: it renders exactly the actions the server lists and applies nothing optimistically. Cost accepted: brief windows where the page shows old state.
- No idempotency guard on `moon.reply` (owner decision): a second reply is allowed by design and the server cannot tell a duplicate from a deliberate note. Plan Review Focus 3 amended.
- Drop is offered only once a moon is parked; on an audited moon the main-tree question is answered first. Spec §5.3 annotated with the as-built behaviour.
- A voyage with this server's pid that the runner no longer tracks is "stale" and parkable; HTTP `moon.park` refuses a voyage the runner is still running. Found by the final review (a failure just after launch orphaned the voyage and held a slot).
- `useCommand` keeps its request state across a change of the open moon; controls tied to a moon reset by remounting (keyed by task id, never by list position). Three task reviews failed on this class of defect before the hook was fixed at the root.
- Executed through Lanes at the `roundabout` level: Codex built the 11 DELEGATE tasks in worktrees, Claude did the 7 KEEP tasks (security-routed ones via the superpowers subagent loop) and every review. Codex's Windows sandbox set to `elevated` (the unelevated one cannot create pipes, so Node children failed `spawn EPERM`).
- Page components cannot be rendered under `node --test`; their tests check the built bundle and source text. Reviewers verified behaviour by rendering the real components on a fake DOM against a recording stub. A proper rendering test setup was not added.
- Fuel gauge, limiter and rung selector deferred to v1.
- Full ledger of rulings and deferred minors: `.superpowers/sdd/2026-11-13-v0.5-bridge/progress.md` (git-ignored).

**Loose ends:** see `.lanes/seed.md` (2026-11-14).

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
