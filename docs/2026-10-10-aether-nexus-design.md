# Aether Nexus — design spec

**Status:** draft v0.1, 2026-10-10
**Lineage:** fork of [Lanes 3.5.0](https://github.com/OniNoKen4192/Lanes). Lanes stays a Claude Code plugin; Aether Nexus is a standalone orchestrator with a runtime, a database, and a browser control surface. 4fun4work.
**One line:** an always-on dispatch layer that turns features and bug reports into routed, reviewed, merged work across multiple model providers — rendered as an intergalactic logistics company you can actually steer from.

---

## 0. Decisions already made

Everything below was settled in conversation. Anything *not* in this table is a proposal and marked as such in the body.

| # | Decision |
|---|---|
| D1 | Fork Lanes into a new project. Not a Lanes release. |
| D2 | Runtime: Node/TypeScript server built on the **Claude Agent SDK**, one server instance **per project**. |
| D3 | State: **SQLite**. Append-only event log is the source of truth; everything else is a projection. |
| D4 | Superpowers skills are **cloned** into the fork (writing-plans, brainstorming, SDD execution loop), not depended on. |
| D5 | Providers: Codex is the ground floor; Gemini, Grok, OpenRouter, local models are additional **provider adapters**. Abstraction is "provider," not "subscription" — cost model is a per-provider field. |
| D6 | Routing is a **roles × providers matrix**, editable from the browser (toggle/assign). |
| D7 | Human decisions come to the browser: **safety parks, REJECTs, parks, failed bug fixes**. Reviewer issues verdicts; orchestrator acts on APPROVE/FIX; **REJECT always parks for the human** with reasoning attached. The orchestrator can decline to merge; it cannot declare work dead unseen. |
| D8 | Human → harness: v1 is **reply-to-parked** (fresh agent, original spec + human note as amendment). **Live steering of a running agent is a documented future possibility**, not v1. |
| D9 | Intake: **per-project settings**; sources may be GitHub issues, a box in the browser, the whiteboard file. |
| D10 | Quota: a **limiter**, not just a gauge. Per-provider pools with reserve floors. |
| D11 | Concurrency: **configurable**, intended to be stress-tested hard. |
| D12 | Bugs run the **same pipeline as features**, with a **mandatory failing test first**, confirmed by a **skeptical specialized reviewer**, then accepted/rejected per D7. |
| D13 | Idle: the UI stays alive with **free** activity only — cosmetic traffic driven by the server clock, and optionally zero-cost housekeeping (local models / no-model jobs). **Never spend a pooled provider on idle.** |
| D14 | Difficulty scoring of work ("gravity") is first-class: drives attention, routing, and pre-dispatch gating. |
| D15 | Visualization: **Three.js**, in a browser, hierarchy galaxy → solar system → planet → ships. |
| D16 | Company name: **Aether Nexus**. |

---

## 1. Vocabulary

The metaphor is load-bearing in the UI and in event names. Internals keep plain names where Lanes already has them (`worktree`, `spec`, `verdict`) so the validator and tests port cleanly.

**Places don't move; ships do.** Galaxies, systems, planets and moons are places with a status. Ships are the units of motion: persistent, named entities in a per-galaxy roster, each belonging to a fleet (one fleet per provider; the hull tint). A **voyage** is one assignment of a ship to a moon or planet in one role; a ship outlives any single agent process, which is a *phase* of a voyage. Finished work is **cargo**, and a ship carries it upward. *(Revised 2026-10-13; see `docs/superpowers/specs/2026-10-13-v0-skeleton-design.md` §4.)*

| Concept | Aether Nexus term | Lanes term | Notes |
|---|---|---|---|
| Project (one repo, one server) | **Galaxy** | project | One server instance = one galaxy. |
| A feature/bug run | **System** (solar system) | highway run | The home star is scenery; its light = run health. |
| Integration branch | **Fleet HQ** | highway/integration | A station orbiting the system's home star. Carriers deliver finished streams here. |
| Landing on `main` | **The portal** | (human merges) | HQ → `main`, the one trip the human flies. The work leaves the system. |
| Work stream inside a run | **Planet** | stream | Territory = the planet's surface; disjoint globs = no overlapping orbits. |
| Task (one spec, one worktree) | **Moon** | task | Orbits its planet. Moon mass = difficulty score. |
| A named vessel in the roster | **Ship** | — | Classes: **Freighter** (implements; carries a moon's cargo to its planet), **Customs** (reviews; inspects cargo in orbit, issues the verdict), **Carrier** (hauls a finished stream planet → HQ), **Surveyor** (plans). Fleet = provider. |
| One assignment of a ship | **Voyage** | subagent run | `launched → working → holding → cleared → en_route → docked`. The agent process is the `working` phase. |
| The orchestrator | **The Nexus** (dispatch) | — | Station at the galactic core. |
| Provider usage pool | **Fuel** (per provider: Claude fuel, Codex fuel, OpenRouter credits, local = reactor) | quota | Reserve floor = "reserve tanks." |
| Parked work | **Adrift** | parked | A *ship* goes adrift, beacon on, waiting for a human. |
| REJECT | **Quarantined** | REJECT | The freighter and its cargo are held at the moon; the moon is flagged because something unsafe is parked there. |
| Security/attention-routed work | **Restricted space** | security_routed / attention | Always human-gated; shown as a no-fly zone. |
| Human decision queue | **Bridge** | — | The human's console in the browser. |
| Difficulty score | **Gravity** | — | §9. |
| Delivering cargo | **Docking** | merge | A *ship* docks: freighter at a planet = task merge to stream; carrier at Fleet HQ = stream merge to integration. |
| Session close-out | **Drydock** | rest stop | Same ritual, renamed. |
| Ledger | **Manifest** | ledger / triplog | §5 table, plus the markdown export Lanes writes. |

Provider tiers can keep Lanes' example names (`sol`, `terra`, `luna`) — they already fit.

---

## 2. Architecture

```
┌────────────────────────────────────────────────────────────┐
│  Browser  (Three.js scene + Bridge panel)                  │
│    ▲ WebSocket: event stream        │ commands (REST/WS)   │
└────┼────────────────────────────────┼──────────────────────┘
     │                                ▼
┌──────────────────────────────────────────────────────────────┐
│  Nexus server (Node/TS, one per galaxy)                      │
│  ├─ intake adapters   (github issues · bridge box · whiteboard)│
│  ├─ orchestrator      (decompose · plan fan-out · schedule)   │
│  ├─ scheduler         (DAG walk · concurrency · limiter)      │
│  ├─ provider adapters (claude-sdk · codex-mcp · acp · openai) │
│  ├─ worktree manager  (ported lanes-validate.mjs)             │
│  ├─ event log + projections (SQLite, WAL)                     │
│  └─ idle director     (cosmetic traffic · free housekeeping)  │
└──────────────────────────────────────────────────────────────┘
     │ spawns, per task, in its own git worktree
     ▼
  Claude Agent SDK query()  ─or─  codex mcp-server  ─or─  ACP agent (gemini/grok/opencode/goose)
```

### 2.1 Why one process, why SDK

Lanes' highways spec had to fan planning out in parallel but drive execution from one top-level session because *subagents can't spawn subagents*. That constraint is gone: the Nexus server is the top level, and every agent — planner, implementer, reviewer — is a peer `query()` with its own `cwd`. Each `query()` is its own subprocess; concurrency is bounded by RAM (docs suggest ~1 GiB/agent as a starting point) and by fuel, not by the harness.

Verified SDK facts the design relies on (TypeScript SDK, code.claude.com/docs/en/agent-sdk):
- `settingSources` defaults to `["user","project","local"]` → `.claude/skills`, `.claude/agents`, CLAUDE.md, project hooks load from `cwd`. Plugins load via `plugins: [{type:"local", path}]`.
- `mcpServers` is per-query; `strictMcpConfig: true` blocks claude.ai connectors from leaking in. **`allowedTools` only auto-approves; `disallowedTools` is what removes tools.** Whether `tools:` is a strict allowlist is undocumented — test it in v0.
- Hooks (`PreToolUse`/`PostToolUse`) can be supplied as **functions** in `options.hooks`. The Lanes dispatch gate ports to a function; no settings.json matcher lockstep needed.
- Interrupt: `q.interrupt()` in streaming-input mode; resume with `options.resume: sessionId`. This is the seam D8's future live-steer plugs into.
- Result message carries `total_cost_usd` (client estimate), `usage`, `modelUsage`, `num_turns`, `session_id`, subtypes `success | error_max_turns | error_max_budget_usd | error_during_execution`. `maxBudgetUsd` exists per query.
- Rate-limit detection: `SDKRateLimitEvent` / `SDKAPIRetryMessage` exist in the message union; field shapes unverified. The errors page documents cap strings (`You've hit your session limit · resets 3:45pm`). **Log one live run in v0 to capture the real event shape before building the limiter on string matching.**

### 2.2 Auth — unresolved, flagged

The SDK overview states: *"Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods."* A personal, undistributed tool is not obviously "offering a product," but that reading is **unverified**. Mechanically the subprocess honors a Max login or a `claude setup-token` OAuth token; an exported `ANTHROPIC_API_KEY` overrides login.

Design response: `providers.claude.auth` is a config switch (`"login" | "api_key"`), and the Claude provider is confined by default to the **frontier roles** (planning, review, decomposition) so the API-key case is bounded spend. Which mode to run is the human's decision, recorded in config, not the server's.

### 2.3 Per-galaxy layout

```
<repo>/
  .nexus/
    config.json          # schema v2 (Lanes v1 + §4 additions)
    nexus.db             # SQLite, WAL mode, gitignored
    worktrees/           # ported from .lanes/worktrees
    state/<task>.json    # gate baselines, ported
    specs/               # emitted task specs (tasks_dir)
    plans/               # stream maps + stream plans (plans_dir)
  docs/nexus/manifest.md # markdown ledger export, committed (the Lanes ledger)
```

---

## 3. Provider layer

### 3.1 Transports (verified Oct 2026)

| Provider | Agentic mode | Transport | Cost model | Headless/structured | Rate-limit signal |
|---|---|---|---|---|---|
| Claude (Agent SDK) | `query()` | in-process SDK | login or API key (§2.2) | typed message stream | `SDKRateLimitEvent` (shape TBD) |
| OpenAI Codex | `codex mcp-server`, `codex exec --json` | MCP (stdio) or JSONL subprocess | ChatGPT plan (5-hr windows + weekly) or API key | yes | `turn.failed`/`error` events; usage-limit string unverified |
| Google Gemini CLI | `gemini -p`, `gemini --acp` | ACP (stdio) or JSON subprocess | Google account tiers (1000–2000 req/day) or API key | `--output-format stream-json`, `--approval-mode yolo\|auto_edit` | **exit codes 0/1/42/53**, HTTP 429 `RESOURCE_EXHAUSTED` |
| xAI Grok Build | `grok -p`, `grok agent stdio` | ACP (stdio) or JSON subprocess | SuperGrok/Premium+ or `XAI_API_KEY` | `--output-format json\|streaming-json`, `--always-approve` | **unverified**; young CLI, expect churn |
| OpenRouter | none first-party | OpenAI-compatible API behind an ACP agent | pay-per-token | via OpenCode/Goose/Aider | HTTP 429 |
| Local (Ollama/LM Studio/llama.cpp) | via OpenCode (`opencode run --format json`), Goose (`goose run --output-format stream-json`), Aider | ACP (stdio) / JSON subprocess | free | yes | none; connection errors only |

Two transports cover everything: **MCP-server** (Codex; Claude via `claude mcp serve` exposes tools, not an agent loop — don't use it for dispatch) and **ACP over stdio** (Gemini, Grok, OpenCode, Goose). Plus the in-process Claude SDK. OpenRouter and local models are *endpoints* consumed by an ACP agent, not providers in their own right; the config models them as `provider: opencode, endpoint: openrouter|ollama`.

### 3.2 Adapter contract

Every adapter implements:

```ts
interface ProviderAdapter {
  id: string;                               // "codex", "gemini", "opencode@ollama"
  roles: Role[];                            // which roles it's eligible for (§3.3)
  dispatch(job: Job, ctx: {cwd, spec, worktree}): AsyncIterable<AgentEvent>;
  reply?(sessionId, message): AsyncIterable<AgentEvent>;   // follow-up in same session
  costModel: "pool-window" | "pool-daily" | "per-token" | "free";
  fuel(): Promise<FuelReading>;             // best-effort; may be "unknown"
  classify(err): "rate_limited" | "capacity" | "backend_failure" | "unknown";
}
```

`AgentEvent` is the normalized stream (`text`, `tool_use`, `tool_result`, `file_changed`, `usage`, `done`, `error`). The event log stores these; the viz animates from them.

### 3.3 Roles × providers matrix (D6)

Roles, from frontier-judgment to tool-free:

| Role | Needs tools? | Default provider | Notes |
|---|---|---|---|
| `decompose` (feature/bug → stream map) | read-only | Claude frontier | Always frontier in v1. |
| `plan` (stream → lane-tagged plan) | read-only | Claude frontier | The ported `lanes-stream-planner`. |
| `implement` | **yes** (edit, run) | Codex | Any agentic provider. |
| `review` | read + run tests | Claude frontier | The ported `lanes-reviewer`; skeptical by design. |
| `review-bug` | read + run tests | Claude frontier | D12's specialized skeptic: must independently confirm the failing test existed, failed, and now passes for the stated reason. |
| `triage` (is this bug real / duplicate / a feature?) | read-only | cheapest capable | Local or Gemini-flash class. |
| `second-opinion` (optional parallel review) | read-only | any | Advisory only; never a verdict. |
| `summarize` (run reports, manifest prose) | none | local/free | Idle-eligible. |
| `score` (gravity re-estimation) | read-only | local/free | Idle-eligible. |

Stored in SQLite (`routing_matrix`), editable from the Bridge, with per-task override. Lanes' KEEP/DELEGATE collapses into "which provider does `implement` for this task" — KEEP = Claude, DELEGATE = anything else. ROUTING.md's hard rules port unchanged: security-routed → Claude only, >4 files/structural → Claude only, auth-bearing endpoints → Claude only unless ratified.

---

## 4. Config (`.nexus/config.json`, schema v2)

Lanes v1 schema ports whole (`project`, `commands`, `routing`, `pipeline`, `review_suite`, `automation.max_fix_rounds`) with these changes:

```jsonc
{
  "schema_version": 2,
  "providers": {
    "claude":  { "adapter": "claude-sdk", "auth": "login|api_key", "models": {"frontier": "...", "fast": "..."},
                 "pool": { "kind": "window", "reserve_floor": 0.25 } },
    "codex":   { "adapter": "codex-mcp", "tiers": ["sol","terra","luna"],
                 "ratelimit_signal": ["usage limit", "rate limit"], "pool": { "kind": "window", "reserve_floor": 0.10 } },
    "gemini":  { "adapter": "acp", "command": "gemini --acp", "pool": { "kind": "daily", "reserve_floor": 0.10 } },
    "local":   { "adapter": "acp", "command": "opencode acp", "endpoint": "ollama", "pool": { "kind": "free" } }
  },
  "routing": {
    "security_routed": [...], "do_not_touch": [...], "attention": {...},   // ported verbatim
    "matrix": "db"                     // matrix lives in SQLite; this key just says so
  },
  "scheduler": {
    "max_concurrent_ships": 6,         // total agents in flight
    "max_concurrent_systems": 1,       // concurrent highway runs (see §6.4)
    "per_provider_max": { "codex": 4, "claude": 2 }
  },
  "automation": { "level": "manual|verdicts|roundabout|highways|autopilot", "max_fix_rounds": 2 },
  "intake": { "github_issues": { "repo": "...", "labels": ["nexus"] }, "bridge": true, "whiteboard": "whiteboard.md" },
  "idle": { "cosmetic": true, "housekeeping": ["summarize", "score"] },   // housekeeping only on pool.kind == "free"
  "gravity": { "weights": { "files": 1, "security": 5, "attention": 3, "depth": 1, "history": 2 }, "gate_above": 8 }
}
```

Unknown keys refuse, as in Lanes. `automation.level: "autopilot"` is the new rung (§7).

---

## 5. Data model (SQLite)

Event-sourced. `events` is append-only; every other table is rebuildable from it (and a `rebuild` command does exactly that, which is also how the viz gets replay).

```sql
events(id INTEGER PK, ts, kind, system_id, planet_id, moon_id, ship_id, provider, payload JSON)
-- kinds (dotted): intake.received, intake.triaged, system.created, system.gated, system.approved,
--   planet.planned, planet.plan_checked, moon.emitted, moon.gated, moon.scored,
--   ship.registered, ship.assigned, ship.released,
--   voyage.launched, voyage.event (normalized AgentEvent), voyage.returned, voyage.audited, voyage.cleared,
--   voyage.departed, voyage.docked, voyage.adrift, voyage.quarantined, verdict.issued, moon.merged, moon.adrift,
--   moon.quarantined, planet.merged, system.reviewed, system.landed, human.decision, human.message,
--   fuel.reading, limiter.held, limiter.rerouted, idle.tick, drydock.closed

systems(id, kind feature|bug, title, brief, base_sha, integration_branch, status, created_ts, landed_ts)
planets(id, system_id, mission, territory JSON, depends_on JSON, interfaces, plan_path, branch, status)
moons(id, planet_id, spec_path, spec_sha, touch JSON, depends_on JSON, tier, gravity, status, worktree, branch)
ships(id, name UNIQUE, class freighter|customs|carrier|surveyor, fleet, status idle|assigned|adrift|quarantined|retired, voyage_count)
voyages(id, ship_id, moon_id|planet_id, role, round, provider, model, session_id, status, launched_ts, returned_ts, docked_ts, report JSON, cost JSON)
verdicts(id, moon_id, voyage_id, verdict APPROVE|FIX|REJECT, delta_spec, reasoning, round)
decisions(id, kind, target_id, status pending|resolved, opened_ts, resolved_ts, human_note, outcome)
fuel(provider, ts, remaining, window_resets_ts, source estimated|reported)
routing_matrix(role, provider, enabled, priority)
gravity_history(moon_id, ts, score, inputs JSON)
query_stats(name, sql, calls, total_ms, max_ms, last_rows, last_ts)   -- opt-in; the SQLite stand-in for Query Store
```

Every projection row carries `last_event_id` (the event that last touched it) for debugging; it can be dropped once the rebuild path is trusted. Event kinds that were `ship.*` are now `voyage.*` with `ship_id` carried alongside, plus `ship.registered / ship.assigned / ship.released`. *(Revised 2026-10-13.)*

Intelligence this unlocks with plain SQL: FIX-round rate per provider per touch-glob; park rate vs. gravity; cost per landed moon per provider; which attention categories park most; whether a provider's RATE_LIMITED correlates with time-of-day. These become Bridge panels later, not v1.

---

## 6. Pipeline

### 6.1 Intake → system

1. An intake adapter emits `intake.received` (GitHub issue, Bridge box, whiteboard entry).
2. `triage` role (cheap) classifies: `feature | bug | duplicate | needs-info | decline`, with a one-paragraph draft brief. Emits `intake.triaged`.
3. `decompose` role (frontier) writes the **stream map** exactly as Lanes' `/lanes-highway` step 1: planets with id, mission, disjoint territory globs, depends-on, interfaces; records base commit. Emits `system.created`, `system.gated`.
4. **Gate.** At every rung below `autopilot`, the map goes to the Bridge as a `decision(kind: approve_map)`. At `autopilot`, it self-approves unless gravity or restricted space says otherwise (§7).

### 6.2 Plan fan-out → moons

Per planet, a `plan` ship writes the stream plan (ported `lanes-stream-planner`), then the ported **plan check** runs (territory containment, same-stream deps only, well-formed task map). Violation → planet adrift. Specs are emitted per DELEGATE-class moon via the ported emit logic; Claude-implemented moons get specs too in this design (uniform handling; the "KEEP tasks have no spec file" asymmetry is dropped — every moon is a spec in a worktree, the only difference is which adapter flies it).

### 6.3 Moon lifecycle

```
moon:    emitted → scored → (gate_above? → decision) → gated → implementing → audited → reviewing → verdict
             APPROVE → merged   (the freighter docks at the planet: merge nexus/<moon> → planet branch, worktree removed)
             FIX     → gated    (a new freighter voyage, round+1, with the delta spec; ≤ max_fix_rounds, then adrift)
             REJECT  → quarantined → decision(kind: reject)
         any BLOCKED / BACKEND_FAILURE / RATE_LIMITED-after-failover / attention / security → adrift → decision

freighter voyage:  launched → working → holding (in orbit with cargo) → cleared → en_route → docked
customs voyage:    launched → working → docked (returns to the Nexus with the verdict)
```

Parks and quarantine attach to the *voyage* (and its ship); the moon's status mirrors them so it can be queried either way. *(Revised 2026-10-13.)*

Ported verbatim from Lanes: gate (`LANES-SPEC:` header → `NEXUS-SPEC:`), audit after every implementer return (the audit JSON — not the agent's claim — is what review sees), spec immutability + `## Amendments`, worktree-per-moon on `nexus/<moon-id>`, planet worktrees on `system/<system-id>/<planet-id>`, integration on `system/<system-id>/integration`. Claude-failover (RATE_LIMITED → one re-dispatch to a Claude implementer, mapped by tier index, mandatory audit re-run, no dry-state latch) ports as a general **failover edge in the routing matrix**: any provider may declare a failover provider per tier.

**Parallelism rule:** planets run concurrently (disjoint territories make this safe, as in Lanes). Within a planet, Lanes ran moons serially; here the scheduler launches every moon whose `depends_on` have docked, up to the concurrency caps — parallel where the DAG allows, serial where it doesn't. Each moon's worktree is cut from the planet branch at launch, so two sibling moons docking in sequence means the second merge may conflict; a conflict on dock parks the moon (`adrift`, reason `merge_conflict`) rather than auto-resolving.

### 6.4 Systems in parallel

`scheduler.max_concurrent_systems` defaults to **1**. Two systems in flight = two integration branches that can conflict and must rebase on each other when landing. The scheduler supports >1 for stress testing; the integration review for the second system to land must run against `main` after the first lands, and the design does not try to be clever about it. (Proposal: leave at 1 for real work until the limiter and viz are stable.)

### 6.5 Bug path (D12)

Same pipeline with three extra invariants enforced by the server, not by prose:
1. The first moon in a bug system is `repro`: write a failing test. Its acceptance is *the test fails for the stated reason*. No fix moon launches until `repro` docks.
2. The fix moon's acceptance includes the repro test passing **and** the regression guard.
3. Review runs under `review-bug`, whose skeptic prompt must independently re-run the repro test at the base commit (fails) and at head (passes), and must reject fixes that make the test pass by altering the test. Verdict then follows D7.

### 6.6 Human-in-the-loop (D7, D8)

The **Bridge** is a queue of `decisions`. Kinds in v1:

| Kind | Opened by | Human options |
|---|---|---|
| `approve_map` | decompose (below autopilot) | approve / edit map / decline system |
| `reject` | reviewer REJECT | re-plan with note / drop moon / drop system |
| `adrift` | any park | reply with note (re-launch) / reroute to provider X / drop |
| `restricted` | security/attention match | authorize this moon once / drop |
| `gravity_gate` | gravity ≥ `gate_above` | launch anyway / split moon (back to plan) / drop |
| `bug_unfixed` | fix rounds exhausted on a bug | reply / escalate tier / drop |
| `limiter_held` | fuel below floor, nothing free | wait / override once / reroute |

"Reply with note" = `human.message` event → new `ship.launched` for the same moon, same worktree, spec + amendment `### A<n> — <date> — human: <note>`. Never resumes the dead session. The `human.message` event carries a `target: {moon|ship}` so a later version can target a *live* ship via `q.interrupt()` + `resume` without changing the schema.

---

## 7. Trust rungs

Lanes' four rungs port unchanged in meaning. One new rung on top.

| Rung | Human still does | Unattended |
|---|---|---|
| `manual` | everything | nothing |
| `verdicts` | plan, emit, launch | APPROVE→dock, FIX→relaunch (≤cap) |
| `roundabout` | approve the plan | the whole moon graph of one planet |
| `highways` | approve one stream map | the whole system, parallel planets, integration review |
| **`autopilot`** | answer the Bridge | intake → triage → decompose → **self-approved map** → everything |

Safety floor at every rung, including autopilot (ported, plus two additions):
- Restricted space (security/attention) always parks. REJECT is always human. Nothing is ever pushed. The human's working branch is never touched; a system's product is its integration branch (Fleet HQ) + review doc. **This is a deliberate tightening of Lanes**, which merged into the working branch at every rung below `highways`: here every system gets an integration branch even at `manual`, because the server, not a prompt, does the merging.
- **New:** gravity ≥ `gate_above` parks pre-launch even at autopilot.
- **New:** the limiter can hold any launch; it never overrides to spend reserve.

Rung is declared in config and flippable from the Bridge (ported `config set trust`), validated before write.

---

## 8. Limiter (D10)

Per provider, a pool with `kind: window | daily | per-token | free` and `reserve_floor` (fraction). Readings come from the adapter (`fuel()`), which for most providers is **estimated** from observed usage plus known window boundaries, because none of them expose a clean remaining-quota API; the `fuel` table records `source: estimated|reported` honestly.

Rules, in order, evaluated at every launch:
1. `free` pools are never held.
2. A launch for a **frontier role** (`decompose`, `plan`, `review*`) may spend down to zero. These are the roles that make implementer spend worth anything; starving them is the failure mode the limiter exists to prevent.
3. A launch for `implement` on provider P is held if P's remaining < `reserve_floor`. The scheduler then tries the next enabled `implement` provider in matrix priority order (`limiter.rerouted`); if none, `limiter.held` and the moon waits (not adrift — a hold is not a park) until a window resets or a human overrides once from the Bridge.
4. Idle housekeeping launches only on `free` pools, ever (D13).
5. On a `rate_limited` classification from an adapter mid-run, the pool is marked exhausted until its next known reset, the moon takes the failover edge if declared, else parks. No persistent "dry" latch beyond the reset time (Lanes' reasoning holds: zero failover state to corrupt).

Fuel is also the first-class gauge in the viz (§11).

---

## 9. Gravity (D14)

A per-moon score computed at emit and re-scored on free providers at idle. Inputs available for free from the spec and the DB:

| Input | Weight (default) | Source |
|---|---|---|
| Touch file count | 1 × n | spec |
| Any security_routed match | +5 | routing globs |
| Any attention match | +3 per category | routing globs |
| Dependency depth in planet DAG | 1 × depth | plan |
| Historical FIX/park rate for overlapping touch globs | 0–2 (scaled) | `verdicts`, `moons` history |
| Interfaces present but non-trivial | +1 | spec |
| Tier (`sol`=+2, `terra`=+1, `luna`=0) | | spec Model hint |

Uses: (a) viz — moon mass, camera attention, the Bridge sorts by gravity; (b) routing — the scheduler prefers higher-priority providers for heavy moons; (c) gating — `gate_above` opens a `gravity_gate` decision before launch. Weights are config; the formula is deliberately dumb and visible. A learned score is a later idea, not v1.

---

## 10. Idle director (D13)

When no moon is launchable, the director runs on the server's animation clock:
- **Cosmetic traffic** (zero model calls): freighters on milk runs between docked planets, survey ships on patrol loops in restricted space, station traffic at the Nexus. Every cosmetic entity is labeled `idle` in the event (`idle.tick`) and renders visibly distinct (dimmer hull, no cargo glyph) so no patrol is mistaken for work.
- **Free housekeeping** (only on `pool.kind == "free"` providers): `summarize` the last landed system into manifest prose; `score` re-gravity moons whose history changed; a no-model `flake` job that re-runs the test suite N times and records variance. These are real ships; they fly on reactor power, labeled `housekeeping`.

The director checks the limiter like everything else; it simply never asks for pooled fuel.

---

## 11. Visualization

### 11.1 Stack

- **Three.js** (r17x) + `three/examples/jsm` controls, **postprocessing** for bloom (stars, engine trails). No framework requirement; vanilla TS + Vite is enough. If a component layer is wanted for the Bridge panel, Svelte or Preact — keep the scene imperative regardless.
- **Assets:** procedural geometry first (primitives + emissive materials + instancing; no files, trivially recolored per fleet). CC0 sources (Kenney space kits, NASA imagery, Google Fonts) only when a hand-built shape looks too crude. Every third-party file gets a row in `assets/LICENSES.md` in the commit that adds it. Ship names come from a seeded generator with themed lists; pop-culture callbacks are fine as *names* — no logos or art.
- **WebSocket** feed of `events` from a cursor (replay on connect: the client asks for events since its last id; cold start replays the projection snapshot then tails).
- **Camera levels** with a tween between them: Galaxy → System → Planet → Moon. `OrbitControls` within a level; double-click a body to descend; Esc ascends. URL hash encodes `#system/<id>/planet/<id>` so a Bridge decision deep-links to its moon.

### 11.2 Scene graph mapping

| Level | Bodies | Visual encodings |
|---|---|---|
| **Galaxy** | the Nexus station at center; one star per system, placed on a spiral arm by creation order; landed systems drift outward and dim; systems in flight glow | star color = status (planning/launching/integrating/review/landed/adrift); size = moon count |
| **System** | home star at center with Fleet HQ (the integration branch) in orbit around it; planets on orbits ordered by dependency (depends-on → outer orbit); moons around planets; the portal at the system's edge | planet ring = territory size; moon mass/scale = gravity; moon surface state = status (barren/emitted, forge-lit/implementing, inspector-lit/review, green/docked, beacon-red/adrift, hazard-striped/quarantined); restricted space = translucent red no-fly volume around affected moons |
| **Planet** | the planet, its moons close up, ships in transit | ships: freighter (implement), inspector (review), surveyor (plan); hull tint by provider (Claude/Codex/Gemini/Grok/local each a fixed tint); engine trail intensity = recent token throughput from `usage` events; a ship *adrift* tumbles slowly with a strobe |
| **Moon** | the worktree | a panel, not a planet: spec, audit JSON, diff stat, verdict history, fuel spent; the reply box when adrift/quarantined (this *is* the Bridge item, docked in-scene) |

### 11.3 Events → animation

Every `events` row maps to one animation or state change; the client is a pure function of the event stream, which is what makes replay work ("watch last night's run at 20×" is free).

| Event | Animation |
|---|---|
| `system.created` | star ignites at the arm's end; planets condense from a disk over ~2s |
| `voyage.launched` | the named ship departs the Nexus station, warps to the moon (galaxy-level: a brief lane line from core to system) |
| `voyage.event:tool_use` (Edit/Write) | forge flash on the moon surface; `file_changed` adds a surface scar in the touched region (hash of path → position) |
| `voyage.returned` | freighter enters orbit and holds, cargo glyph = report status |
| `verdict.issued` APPROVE | customs ship stamps; freighter's cargo glyph turns green |
| `voyage.departed` → `voyage.docked` (freighter) | freighter leaves orbit, flies to the planet, docks; planet ring thickens; ship returns to the Nexus and goes idle |
| `voyage.docked` (carrier) | carrier delivers the stream to Fleet HQ; HQ brightens |
| `voyage.adrift` / `voyage.quarantined` | ship cuts engines, tumbles, beacon strobe; Bridge counter increments; a soft chime (toggleable) |
| `limiter.held` | ship sits at the station with "fuel" overlay; fuel gauge on the station flashes the floor |
| `limiter.rerouted` | ship repaints its hull mid-dock to the new provider's tint |
| `fuel.reading` | the station's tanks (one per provider) update; reserve floor drawn as a line |
| `idle.tick` | cosmetic traffic spawns/moves/despawns; distinct dim shader |
| `human.decision` | a pulse from the Bridge to the target body |

### 11.4 Bridge panel

A dockable side panel: decisions sorted by gravity then age; each decision shows the reasoning (reviewer report / audit JSON / gravity inputs) and the actions from §6.6; the routing matrix editor (role × provider toggles, priority drag); fuel tanks with reserve floors editable inline; concurrency sliders; rung selector. Every control emits a command the server validates (config refusal semantics ported) before applying.

### 11.5 Performance envelope

Stress-test target: 15 ships in flight, ~50 moons across 3 systems, 60 fps on a mid-range GPU. Instanced meshes for moons and ships; ships' positions tweened client-side between events (no per-frame server traffic); event batching on the socket at 10 Hz. Cosmetic traffic capped at a config count. LOD: at galaxy level planets and moons aren't drawn at all.

---

## 12. What ports from Lanes verbatim vs. changes

| Lanes artifact | Disposition |
|---|---|
| `bin/lanes-validate.mjs` (`gate`, `audit`, `attention`, `worktree *`, `doctor`, `config`) | **Port** as a library module inside the server (`src/validate/`), keep CLI entry for debugging. Branch prefixes renamed (§6.3). `selftest` vectors kept. |
| `docs/PATH-MATCHING.md` + `MATCH_VECTORS` | **Port verbatim.** |
| `templates/TEMPLATE.md` (spec format) | **Port**; header `NEXUS-SPEC:`; add `Gravity:` meta line (written by emit). |
| `templates/ROUTING.md` hard rules (a)(b)(c) + tier guidance | **Port** as the seed rows of `routing_matrix` + a `routing_rules` check in the server. |
| `agents/lanes-implementer.md` backend seam | **Replaced** by `ProviderAdapter`; the Phase-1 preflight and Phase-3 verification logic become the server's pre/post hooks around any adapter, so every provider gets the same audit. |
| `agents/lanes-reviewer.md` | **Port** as the `review` role prompt; fork a `review-bug` variant (§6.5). |
| `agents/lanes-stream-planner.md` | **Port** as the `plan` role prompt. |
| `agents/lanes-claude-implementer.md` | **Port** as the Claude-SDK implement adapter prompt. |
| `hooks/lanes-dispatch-gate.mjs` | **Port** as an SDK programmatic `PreToolUse` function for the Claude adapter; for MCP/ACP adapters the gate runs in the server before spawn (there is no in-agent hook point for a foreign CLI — the audit is the backstop, exactly as Lanes documents for the failover path). |
| `hooks/lanes-readonly-allow.mjs` | **Dropped** — no interactive permission prompts in a server; tool policy is per-query `disallowedTools` + hooks. |
| `commands/*` (slash commands) | **Replaced** by server commands + Bridge actions. A thin Claude Code plugin with `/nexus-status`, `/nexus-bridge` wrappers is a later nicety. |
| `commands/lanes-rest-stop.md`, `triplog.md`, `seed.md` | **Port** as Drydock: same ritual, driven from the Bridge, writes `docs/nexus/manifest.md` + `.nexus/seed.md`. |
| superpowers `writing-plans`, `brainstorming`, SDD loop | **Cloned** into `skills/` (D4), loaded into Claude-SDK queries via `settingSources`/`plugins`. |
| `tests/*` (validator, worktree, conformance) | **Port** validator/worktree tests; conformance tests rewritten for the new layout; **add** an adapter contract test suite with a fake provider that emits scripted events (also the viz's demo data source). |
| `whiteboard.md` | Keep the file; it's an intake source (D9). |

---

## 13. Risks and open items

| # | Item | Status |
|---|---|---|
| R1 | Claude auth policy for SDK-built tools (§2.2) | **Human decision.** Design supports both modes. |
| R2 | Rate-limit event shapes (Claude SDK, Codex usage-limit string, Grok anything) | Unverified; capture from live runs in v0 before the limiter trusts them. Gemini is the only one with documented exit codes. |
| R3 | Whether SDK `tools:` is a strict allowlist | Test in v0; fall back to `disallowedTools`. |
| R4 | Grok Build CLI flag churn | Adapter marked experimental; pin version. |
| R5 | Foreign-CLI agents (ACP) can't be gated in-process | Accepted; server-side pre-gate + mandatory audit, same as Lanes' failover path. |
| R6 | Windows: worktree ACLs (Lanes' `worktree_acl` doctor check), long paths, line endings in spec hashing | Port the check; CI on Windows from day one since that's where it runs. |
| R7 | Multiple systems landing (§6.4) | Default 1; stress-test mode only. |
| R8 | Fuel readings are estimates | Shown as such; never used to *spend* reserve, only to hold. |
| R9 | Live steering (D8 future) | Schema supports it (`human.message.target`); UI and interrupt plumbing deferred. |

---

## 14. Build phases (proposal)

| Phase | Deliverable | Done when |
|---|---|---|
| **v0 — skeleton** | server boots per galaxy; SQLite + events; ported validator; fake adapter; Claude-SDK adapter + Codex-MCP adapter; one moon end-to-end at `manual` (launch → audit → review → dock) from a CLI. Spec: `docs/superpowers/specs/2026-10-13-v0-skeleton-design.md` | the full moon lifecycle passes in CI with the fake adapter on Windows/Linux/macOS; the SDK/MCP spike's logs are committed. *Stretch:* a real spec lands on a planet branch via Codex; rate-limit shapes are captured opportunistically, not forced |
| **v0.5 — Bridge** | WebSocket feed; Bridge panel (decisions, matrix, fuel, rung) with no 3D; reply-to-adrift works | a REJECT is handled entirely from the browser |
| **v1 — Nexus** | intake adapters; triage/decompose/plan roles; `highways` + `autopilot`; limiter; gravity; bug path with repro invariant; Drydock | an issue labeled `nexus` becomes a landed integration branch unattended, with every park visible on the Bridge |
| **v1.5 — Galaxy** | Three.js scene, four camera levels, event→animation table, replay, idle cosmetic layer | last night's run replays at 20× and you can find the adrift moon by looking |
| **v2 — Providers** | Gemini + OpenCode/Goose ACP adapters, OpenRouter/local endpoints, free housekeeping, matrix reroute under limiter | a stress run with ≥10 ships across ≥3 providers holds 60 fps and never spends reserve |

Viz last on purpose: it's a projection of the event log, and the log has to be right first. The fake adapter gives the viz realistic data to develop against without burning anything.
