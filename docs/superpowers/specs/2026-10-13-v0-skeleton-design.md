# Aether Nexus v0 — skeleton: design spec

**Status:** approved in conversation 2026-10-13; this document is the written form.
**Parent:** `docs/2026-10-10-aether-nexus-design.md` (the overall design). This spec covers the **v0** row of its §14 only.
**Decided here:** repo layout (server at root), Claude auth default (`login`), SQLite driver (`node:sqlite`), the ship/voyage split, Fleet HQ as the integration branch, the statement registry and `query_stats`, the `last_event_id` lineage column, and the v0 exit criterion (fake adapter in CI; Codex adapter is v0's last task, not its gate).

---

## 1. Scope

**In v0**

- A `nexus` CLI that boots a server for one galaxy (one repo) and drives one moon through `emitted → gated → implementing → audited → reviewing → merged` at `automation.level: "manual"`. Every transition is a CLI command; nothing runs unattended.
- SQLite event log (`.nexus/nexus.db`): `events` plus the projections `systems`, `planets`, `moons`, `ships`, `voyages`, `verdicts`, `decisions`. `nexus db rebuild` regenerates every projection from `events`.
- Validator ported from `bin/lanes-validate.mjs` to `src/validate/` with the selftest vectors as tests; the `.mjs` is deleted when parity is proven.
- `ProviderAdapter` interface with three implementations: `fake` (scripted; used by all tests), `claude-sdk` (auth default `login`), `codex-mcp`.
- Integration branch per system at every rung (`system/<id>/integration`), moon worktrees on `nexus/<moon-id>`, APPROVE merges moon → planet branch. The human's working branch is never written to; nothing is pushed.
- A spike that pins R2/R3 from the parent design before the adapter contract is frozen (§7).
- Query instrumentation: a statement registry and an opt-in `query_stats` table (§3.3).

**Out of v0** (config keys exist so files don't churn later; the server ignores them): intake adapters; `triage`/`decompose`/`plan` roles (the human hand-writes the stream map and spec); gravity; limiter; Bridge/WebSocket; any browser; failover edges; `review-bug`; Drydock; planet → HQ and HQ → `main` merges; carriers flying.

**Done when**

1. The full moon lifecycle passes in CI with the `fake` adapter on Windows, Linux and macOS, on every fixture script in §6.2.
2. The spike's raw logs and a one-page README are committed under `docs/spikes/`.
3. *Stretch, not gate:* a hand-written spec, run against a scratch repo via the CLI with `codex-mcp` as implementer and `claude-sdk` as reviewer, lands on a planet branch with an audit JSON and an APPROVE verdict in the DB. If this does not land in v0 it rolls into v0.5 unchanged.

CI never runs a real provider: it cannot log in. Real-adapter runs are a manual, documented step forever, not a v0 shortcut.

---

## 2. Repo layout and tooling

```
AetherNexus/
  package.json            # name "aether-nexus", version 0.1.0, "type": "module", engines node >=22.13 (node:sqlite unflagged from 22.13.0)
  .gitattributes          # `* text=auto eol=lf` — specs must hash identically on every OS (parent R6)
  tsconfig.json           # strict, module NodeNext, outDir dist/
  src/
    cli/                  # `nexus` entry and one file per command group
    server/               # galaxy bootstrap: open db, load config, build adapters, expose functions the CLI calls
    db/                   # schema + migrations, append/apply, reducers, rebuild, statements.ts, stats
    core/                 # state machine, dispatcher (assigns idle ships), git.ts (worktrees, merges, refusal list)
    validate/             # ported validator: match, tokenize, spec, gate, audit
    providers/            # adapter.ts (interface + AgentEvent), fake/, claude-sdk/, codex-mcp/
    config/               # schema v2 load, refuse-unknown-keys, defaults
  prompts/                # ported agent bodies as role prompts: implement.md, review.md (plan.md later)
  templates/              # TEMPLATE.md (NEXUS-SPEC header), ROUTING.md — kept
  tests/                  # node --test against dist/; see §8
  docs/spikes/            # raw stream logs from the spike
  assets/LICENSES.md      # every third-party asset: source URL + license (created empty in v0)
```

- **TypeScript compiled with `tsc` to `dist/`**, run with plain `node`. No bundler, no `tsx` at runtime. Tests import from `dist/`; `pretest` builds.
- **`node:sqlite`** (built in since Node 22.5; no flag needed since 22.13.0, hence the engines floor). No native build on Windows. It is experimental; CI on Node 22 and 24 surfaces API drift. If it bites, `better-sqlite3` has the same synchronous shape and swaps in behind `src/db/`.
- **`node --test`** kept, matching the existing suite.
- **Dependencies:** `@anthropic-ai/claude-agent-sdk`, `@modelcontextprotocol/sdk`, `typescript`. Nothing else until something earns it.
- **Lanes files** (`bin/`, `commands/`, `agents/`, `hooks/`, `skills/`) stay in place; each is deleted in the commit that lands its port. `.claude-plugin/` stays (name `nexus`) as the future thin plugin's manifest; the conformance test pinning manifest version = marketplace version stays.
- **Version** resets to 0.1.0.

---

## 3. Data model

`events` is the redo log. Every other table is a materialized projection that happens to be stored.

### 3.1 Schema (v0, migration `001`)

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);   -- schema_version, galaxy_id, created_ts

CREATE TABLE events (
  id        INTEGER PRIMARY KEY,                 -- rowid; monotonic. Not guaranteed gap-free (a rolled-back txn can burn a value)
  ts        TEXT    NOT NULL,                    -- ISO-8601 UTC
  kind      TEXT    NOT NULL,                    -- dotted, see §3.4
  system_id TEXT, planet_id TEXT, moon_id TEXT, voyage_id TEXT, ship_id TEXT,  -- nullable, denormalized for filtering
  task_id   TEXT,                                -- display/filtering only: a task id can be re-assigned after a drop
  assignment_id INTEGER,                         -- work events only: the moon.assigned event id of the assignment they belong to
  provider  TEXT,
  payload   TEXT    NOT NULL CHECK (json_valid(payload))
);
CREATE INDEX events_moon   ON events(moon_id, id);
CREATE INDEX events_task   ON events(task_id, id);
CREATE INDEX events_assignment ON events(assignment_id, id);
CREATE INDEX events_voyage ON events(voyage_id, id);
CREATE INDEX events_kind   ON events(kind, id);

-- Projections. Every projection carries last_event_id (lineage, for debugging; may be dropped once trusted).
CREATE TABLE systems  (id TEXT PRIMARY KEY, kind TEXT CHECK (kind IN ('feature','bug')), title TEXT, brief TEXT,
                       base_sha TEXT NOT NULL, integration_branch TEXT NOT NULL,
                       status TEXT NOT NULL CHECK (status IN ('open','landed','dropped')),
                       created_ts TEXT NOT NULL, landed_ts TEXT,
                       last_event_id INTEGER NOT NULL REFERENCES events(id));
-- Bodies exist before work (§4.0). The body columns are NOT NULL; the work columns are NULL while the body is barren.
CREATE TABLE planets  (id TEXT PRIMARY KEY, system_id TEXT NOT NULL REFERENCES systems(id),
                       name TEXT NOT NULL, orbit_index INTEGER NOT NULL,                       -- 0..5 inner; belt sits between 5 and 6; 6+ discovered
                       kind TEXT NOT NULL CHECK (kind IN ('rocky','gas_giant','ice_giant','dwarf')),
                       body_status TEXT NOT NULL CHECK (body_status IN ('barren','assigned','settled')),
                       stream_id TEXT, mission TEXT,                                           -- work: NULL while barren
                       territory TEXT CHECK (territory IS NULL OR json_valid(territory)), depends_on TEXT CHECK (depends_on IS NULL OR json_valid(depends_on)),
                       branch TEXT, worktree TEXT,
                       status TEXT CHECK (status IS NULL OR status IN ('open','merged','adrift','dropped')),   -- the stream's status
                       last_event_id INTEGER NOT NULL REFERENCES events(id),
                       UNIQUE (system_id, orbit_index));
CREATE TABLE moons    (id TEXT PRIMARY KEY, planet_id TEXT NOT NULL REFERENCES planets(id),
                       name TEXT NOT NULL, orbit_index INTEGER NOT NULL,
                       body_status TEXT NOT NULL CHECK (body_status IN ('barren','assigned','settled')),
                       task_id TEXT UNIQUE,                                                    -- the spec's task id; NULL while barren
                       assignment_id INTEGER,                                                  -- id of the moon.assigned event of the current assignment; NULL while barren
                       spec_path TEXT, spec_sha TEXT, touch TEXT CHECK (touch IS NULL OR json_valid(touch)),
                       depends_on TEXT CHECK (depends_on IS NULL OR json_valid(depends_on)), tier TEXT, round INTEGER NOT NULL DEFAULT 0,
                       worktree TEXT, branch TEXT,
                       status TEXT CHECK (status IS NULL OR status IN ('emitted','gated','implementing','audited','reviewing','merged','adrift','quarantined','dropped')),  -- the task's status
                       park_reason TEXT,
                       last_event_id INTEGER NOT NULL REFERENCES events(id),
                       UNIQUE (planet_id, orbit_index));
CREATE TABLE ships    (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
                       class TEXT NOT NULL CHECK (class IN ('freighter','customs','carrier','surveyor')),  -- surveyor: v1 planning role; in the schema now so it never migrates
                       fleet TEXT NOT NULL,                  -- provider id; hull tint in the viz
                       status TEXT NOT NULL CHECK (status IN ('idle','assigned','adrift','quarantined','retired')),
                       voyage_count INTEGER NOT NULL DEFAULT 0,
                       last_event_id INTEGER NOT NULL REFERENCES events(id));
CREATE TABLE voyages  (id TEXT PRIMARY KEY, ship_id TEXT NOT NULL REFERENCES ships(id),
                       moon_id TEXT REFERENCES moons(id), planet_id TEXT REFERENCES planets(id),  -- exactly one non-null
                       task_id TEXT NOT NULL, assignment_id INTEGER NOT NULL,                  -- copied from the moon at launch; history is keyed by assignment
                       role TEXT NOT NULL CHECK (role IN ('implement','review','carry','plan')), round INTEGER NOT NULL,  -- only implement/review are dispatched in v0
                       provider TEXT NOT NULL, model TEXT, session_id TEXT,
                       status TEXT NOT NULL CHECK (status IN ('launched','working','holding','cleared','en_route','docked','superseded','adrift','quarantined')),
                       launched_ts TEXT NOT NULL, returned_ts TEXT, docked_ts TEXT,
                       report TEXT CHECK (report IS NULL OR json_valid(report)), cost TEXT CHECK (cost IS NULL OR json_valid(cost)),
                       last_event_id INTEGER NOT NULL REFERENCES events(id));
CREATE TABLE verdicts (id INTEGER PRIMARY KEY, moon_id TEXT NOT NULL REFERENCES moons(id), task_id TEXT NOT NULL, assignment_id INTEGER NOT NULL, voyage_id TEXT NOT NULL REFERENCES voyages(id),
                       verdict TEXT NOT NULL CHECK (verdict IN ('APPROVE','FIX','REJECT')), delta_spec TEXT, reasoning TEXT, round INTEGER NOT NULL,
                       last_event_id INTEGER NOT NULL REFERENCES events(id));
CREATE TABLE decisions(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, target_kind TEXT NOT NULL, target_id TEXT NOT NULL,
                       status TEXT NOT NULL CHECK (status IN ('pending','resolved')), opened_ts TEXT NOT NULL, resolved_ts TEXT,
                       human_note TEXT, outcome TEXT,
                       last_event_id INTEGER NOT NULL REFERENCES events(id));

CREATE TABLE query_stats (name TEXT PRIMARY KEY, sql TEXT NOT NULL, calls INTEGER NOT NULL, total_ms REAL NOT NULL,
                          max_ms REAL NOT NULL, last_rows INTEGER, last_ts TEXT NOT NULL);
```

### 3.2 Rules

1. **One transaction per event; writers are serialized, not assumed single.** `append(event)` runs `BEGIN IMMEDIATE`, re-reads the current projection state it is about to transition, validates the transition, inserts the `events` row, applies it to the projections, `COMMIT`. `BEGIN IMMEDIATE` takes the write lock up front, so two processes (a blocking `launch` in one terminal, `status` or a second `launch` in another) cannot interleave a read-then-write; `PRAGMA busy_timeout = 5000` makes the loser wait rather than fail. Writes are short by rule: no transaction is held while an agent streams — each `voyage.event` is its own transaction. Projections are never ahead of or behind the log.
2. **Live and rebuild share one code path.** `rebuild` deletes every projection row, then replays `SELECT * FROM events ORDER BY id` through the same reducer functions `append` uses. A test byte-compares a projection dump before and after rebuild.
   **Reducers are pure:** they read only the event row and the current projection rows — never the clock, the filesystem, git, or config. Anything a reducer needs (timestamps, SHAs, paths) is put into the event payload by the command that appends it. This is what makes byte-equivalence hold.
3. **Payloads are JSON text**, queried with `json_extract`. A hot field is promoted to a column in the *projection*, never by changing `events`.
4. **IDs are human-readable:** `system_id` = `S-<yyyymmdd>-<slug>`; `planet_id` = `<system_id>/<planet-name>`; `moon_id` = `<planet_id>/<moon-name>`; `moons.task_id` = the spec's task id; `voyage_id` = `<ship_id>/<task_id>/<role>/<round>`; `ship_id` = a slug of the ship's name. They appear in branch names and the UI.
5. **Spec immutability:** `moons.spec_sha` is recorded at emit; launch refuses if the file hashes differently. Amendments append under `## Amendments` and re-hash (the Lanes rule, header renamed to `NEXUS-SPEC:`).
6. **Migrations:** `meta.schema_version`; `src/db/migrations/NNN.sql` applied in order on open; v0 ships `001`.
7. **Lineage:** every projection row's `last_event_id` is set by the reducer that last touched it.

### 3.3 Query instrumentation

- **Statement registry.** Every SQL statement is declared once, by name, in `src/db/statements.ts`. A test fails if any `.ts` file under `src/` other than `src/db/statements.ts` contains a string or template literal that starts with a SQL verb (`SELECT`, `INSERT`, `UPDATE`, `DELETE`, `CREATE`, `PRAGMA`, `EXPLAIN`, …). Migrations (`src/db/migrations/*.sql`) and prose are outside its reach by construction. `nexus db explain <name>` prints `EXPLAIN QUERY PLAN` for any registered statement.
- **`query_stats`**, written only when `config.db.stats` is `true`: the `run/get/all` wrapper times each call and upserts `calls`, `total_ms`, `max_ms`, `last_rows`. `nexus db stats` prints it sorted by `total_ms`.
- **`nexus db analyze`** runs `ANALYZE` + `PRAGMA optimize`; the server runs `PRAGMA optimize` on close.

### 3.4 Event kinds (v0)

```
system.created (payload: seed + the generated bodies)   planet.discovered   moon.discovered
planet.assigned   moon.assigned   moon.settled   moon.cleared (dropped task → barren)
moon.emitted  moon.gated  moon.gate_failed  moon.amended  moon.adrift  moon.quarantined  moon.merged
moon.restored (log-only: paths a relaunch put back to the baseline)
ship.registered  ship.released  ship.adrift  ship.quarantined   (voyage.launched takes the ship; there is no ship.assigned)
voyage.launched  voyage.event (one normalized AgentEvent)  voyage.returned  voyage.audited
voyage.cleared  voyage.departed  voyage.docked  voyage.superseded  voyage.adrift  voyage.quarantined
ship.retired  moon.dropped
verdict.issued
decision.opened  decision.resolved  human.message

moon.adrift / voyage.adrift reasons: audit_violations  audit_error  baseline_tampered  carryover_violations  dock_violations
  worktree_missing  merge_conflict  main_tree_modified  max_fix_rounds  timeout  interrupted  stale:<text>
  blocked  backend_failure  rate_limited (and other adapter classifications)
```

### 3.5 Files outside the DB

`.nexus/config.json` (schema v2 as in the parent §4, plus `db: { stats: boolean }` and `fleet: { freighters, customs, carriers, name_theme }`; unknown keys refuse), `.nexus/specs/`, `.nexus/plans/`, `.nexus/state/<moon>.json` (gate baselines) are committed. `.nexus/nexus.db*` and `.nexus/worktrees/` are gitignored; `nexus init` adds the entries.

---

## 4. Bodies, ships, voyages, and the moon lifecycle

### 4.0 Bodies are terrain; work is assigned to them

Planets and moons exist *before* any work does, and nothing ever disappears. A system is generated at creation and grows by discovery.

**Creation** (`system create`): a pure generator (`src/core/bodies.ts`, seed in → bodies out, so `rebuild` reproduces the same system) produces **6 planets inside an asteroid belt**, each with a seeded 1–4 moons, all `barren`, with generated names. A small bugfix system looks like a system from the first frame; most of its rocks simply stay untouched.

**Assignment**: `planet assign` puts a work stream on an existing barren planet; `moon assign` puts a spec on an existing barren moon of that planet. Branches and worktrees are created at assignment, not at creation. The spec's task id lives in `moons.task_id`; the body keeps its own id and name.

**Discovery** (automatic, inside `assign`): when an assignment needs a body that does not exist, the system grows, and the growth is an event:
- a planet with no barren moon → `moon.discovered` (a new moon captured into orbit);
- a system with no barren planet → `planet.discovered`, placed **outside the belt** in deterministic seed order: gas giants, then ice giants, then dwarf planets at the edge. The 7th planet of any system is always a gas giant.

**After work**: a merged task leaves its moon `settled` (a permanent record that something was built there). A dropped task returns the moon to `barren`; its branch is deleted, the rock remains.

**The asteroid belt** is scenery and a human-readable boundary of the inner system in v0. It is reserved for the idle director's free housekeeping (parent §10); no body in the belt is ever assigned a task.

Body IDs are human-readable like everything else: `planet_id` = `<system-id>/<planet-name>`, `moon_id` = `<planet-id>/<moon-name>`. Task branches stay `nexus/<task-id>`; planet branches stay `system/<system-id>/<planet-name>`.

### 4.1 Vocabulary correction (supersedes parent §1 where they differ)

Moons and planets are **places**; they do not move. **Ships** are the units of motion and carry **cargo** (a finished diff). A ship is a persistent, named entity in a per-galaxy roster, belonging to a **fleet** (one per provider; the hull tint). A **voyage** is one assignment of a ship to a moon or planet in one role. A ship outlives any single agent process; an agent process is a *phase* of a voyage.

| Concept | Term | Notes |
|---|---|---|
| Implementer run | **Freighter** voyage, role `implement` | Carries the moon's cargo to its planet |
| Reviewer run | **Customs** voyage, role `review` | Inspects a freighter's cargo in orbit; issues the verdict |
| Stream merge | **Carrier** voyage, role `carry` | Planet → Fleet HQ. Exists in the schema; does not fly in v0 |
| Integration branch | **Fleet HQ** | A station orbiting the system's home star |
| The star | the system's sun | Scenery; status light for the system |
| Landing on `main` | **the portal** | HQ → `main`; the one trip the human flies |
| The orchestrator | **the Nexus** | Galactic dispatch at the core |

### 4.2 Voyage lifecycle (freighter)

```
launched ──agent starts──▶ working ──agent returns──▶ holding (in orbit with cargo, awaiting customs)
   customs APPROVE ──▶ cleared ──▶ en_route ──▶ docked (= merge into planet branch; ship → idle)
   customs FIX     ──▶ superseded (terminal; ship → idle). A new implement voyage (round+1) launches to the
                       same moon, in the SAME worktree, carrying the previous voyage's cargo forward
   customs REJECT  ──▶ quarantined (cargo held at the moon; moon flagged; ship status quarantined)
   BLOCKED | BACKEND_FAILURE | RATE_LIMITED | audit violation | merge conflict ──▶ adrift (ship → adrift)
```

Every voyage reaches a terminal state (`docked`, `superseded`, or a park that a decision resolves), so a ship is never stuck `assigned`.

**Leaving a park.** A park opens a `decision`. Resolving it releases the ship:
- `reply` (adrift or quarantined) → the ship returns to `idle`; a new voyage, round+1, launches to the same moon and worktree with the amendment. The parked voyage becomes `superseded`.
- `drop moon` → the ship returns to `idle`; the voyage stays in its park state as history; the moon becomes `dropped`; the worktree is removed.
- `retire ship` (human choice, any time) → status `retired`; never assigned again. The only way the roster shrinks.

**Sessions belong to the moon's round chain, not to the ship.** `voyages.session_id` is recorded by the adapter that ran the voyage. When a FIX round launches on the same moon with the same provider, the adapter is handed the previous round's `session_id` and may continue it (`codex-reply`; SDK `resume`); a different provider, or a provider that can't resume, starts fresh. The ship assigned to the new voyage may differ — the name on the hull changes, the conversation does not.

The dispatcher assigns the lowest-`voyage_count` idle ship of the right class and fleet; if none is idle, `launch` refuses with "all freighters assigned" (later: a visible signal, not an abstract cap).

### 4.3 Moon lifecycle

```
emitted ──gate ok──▶ gated ──launch──▶ implementing ──voyage.returned + audit──▶ audited
   └─gate fails─▶ adrift                     inspect ──▶ reviewing ──verdict──▶ APPROVE → (dock) → merged
                                                                               FIX     → gated (round+1; ≤ automation.max_fix_rounds, then adrift)
                                                                               REJECT  → quarantined
```

Transitions are a table `from → event → to`; anything else is refused with the moon's current state in the message. **Side effects run after the commit and are idempotent**: if `git merge` fails halfway, the voyage is recorded as `en_route`, and the next command retries or parks it from that recorded state. The DB is never allowed to claim a merge that did not happen — and the converse is handled too: a retry from `en_route` first asks git whether the work is already there (`git merge-base --is-ancestor nexus/<moon> <planet-branch>`); if yes, it records `voyage.docked` and skips the merge, so a crash *after* the merge but *before* the event is written converges on the truth on the next command. The same check-before-act pattern applies to worktree creation (`git worktree list` first) and removal.

### 4.4 Git model

| Object | Branch | Checkout | Created by |
|---|---|---|---|
| System (Fleet HQ) | `system/<system-id>/integration` | none | `system create`, from the recorded base SHA |
| Planet (assigned) | `system/<system-id>/<planet-name>` | `.nexus/worktrees/<system-id>/<planet-name>` | `planet assign`, from the integration branch |
| Moon (assigned) | `nexus/<task-id>` | `.nexus/worktrees/<task-id>` | `moon launch`, from the planet branch's current HEAD |

Barren bodies have no branch and no worktree; they are rows only.

- **Dock:** commit inside the moon worktree (author `<role>/<provider>` so `git log` shows who wrote what) → `git merge --no-ff nexus/<task-id>` executed in the *planet* worktree → remove the moon worktree. Conflict → voyage `adrift`, reason `merge_conflict`, worktree kept. No auto-resolution.
- `git` runs via `child_process` with explicit `-C <path>`; never relies on CWD. Every git command is logged as `voyage.event` with `tool: "git"`.
- **Refusal list**, tested: never `push`; never `checkout`/`switch`/`reset`/`stash` in the main worktree; never `branch -D` outside `nexus/*` and `system/*`; never `worktree remove` on a path outside `.nexus/worktrees/`.
- **Base SHA** is the working branch's HEAD at `system create`. Later commits on the working branch are not seen by the system; the integration review (v0.5+) reconciles.

---

## 5. Validator port

`bin/lanes-validate.mjs` (1,315 lines) → `src/validate/`, one module per job. The selftest has three vector sets: `MATCH_VECTORS` (17, path matching), `TOKENIZER_VECTORS` (9), and `SCHEMA_VECTORS` (34) — the last of which validate a **schema-v1 `.lanes/config.json`**, not specs. Spec parsing (`parseSpec`, :210) has only ad-hoc "parse checks" and no vector set.

| Lanes subcommand / function | Module | Change |
|---|---|---|
| path matching (`MATCH_VECTORS`, 17) | `validate/match.ts` | none; `docs/PATH-MATCHING.md` kept; vectors ported as the oracle |
| tokenizer (`TOKENIZER_VECTORS`, 9) | `validate/tokenize.ts` | none; vectors ported as the oracle |
| `parseSpec` + the ad-hoc parse checks | `validate/spec.ts` | header `LANES-SPEC:` → `NEXUS-SPEC:`; optional `Gravity:` meta line parsed, ignored. **New vector set written in v0** (`tests/fixtures/specs/*.md`, good and bad), since none exists to port |
| config schema (`SCHEMA_VECTORS`, 34) | `config/schema.ts` | **rewritten for schema v2.** Each v1 vector is kept where the key survives (`routing.*`, `pipeline`, `automation.max_fix_rounds`, …), re-pointed where it moved (`backend.*` → `providers.*`), and new vectors cover v2-only keys. Unknown keys still refuse |
| `gate --spec` | `validate/gate.ts` | returns a result object; baseline at `.nexus/state/<moon>.json` |
| `audit --task` | `validate/audit.ts` | returns a result object; its JSON is what `review` reads, never the agent's report |
| `attention --spec` | `validate/attention.ts` | returns the matched `routing.attention` categories; run at `moon emit` so a restricted-space moon is flagged before launch (v0 parks it `adrift`, reason `restricted`) |
| `worktree create/remove` (task and stream) | `core/git.ts` | subsumed by §4.4 |
| `seed --check` | dropped | belongs to Drydock (parent §12); returns in v1 |
| `doctor`, `config get/set` | dropped here | config validation in `src/config/`; `doctor` returns as a CLI command in v0.5 |

Order: the three vector sets become `tests/validate/*.test.mjs` and `tests/config/schema.test.mjs` first (failing); modules are ported until green; `tests/validator.test.mjs` and `tests/worktree.test.mjs` are retargeted from the CLI to the library; `bin/lanes-validate.mjs` is deleted in the commit where the last vector passes against `dist/`. `nexus validate <spec>` keeps the debugging affordance.

Not carried over: the KEEP/no-spec asymmetry (every moon has a spec, parent §6.2) and `hooks/lanes-readonly-allow.mjs` (parent §12). The dispatch gate becomes a `PreToolUse` function for the Claude adapter; for Codex it runs server-side before spawn with the audit as backstop.

---

## 6. Provider adapters

### 6.1 Contract

```ts
interface ProviderAdapter {
  id: string;                                  // "fake" | "claude-sdk" | "codex-mcp"
  roles: Role[];                               // v0: "implement" | "review"
  dispatch(job: Job, ctx: DispatchCtx): AsyncIterable<AgentEvent>;
  classify(err: unknown): "rate_limited" | "capacity" | "backend_failure" | "unknown";
  fuel(): Promise<FuelReading>;                // v0: every adapter returns { source: "unknown" }
}
type Job         = { voyageId: string; role: Role; specPath: string; promptPath: string; round: number; deltaSpec?: string };
type DispatchCtx = { cwd: string; touch: string[]; timeoutMs: number; signal: AbortSignal };
type AgentEvent  = { kind: "text" | "tool_use" | "tool_result" | "file_changed" | "usage" | "done" | "error"; ts: string; data: unknown };
```

Above the adapter, the orchestrator sees only `AgentEvent`s; each is appended as `voyage.event`. `done.data` is the implementer's report (`IMPLEMENTED | IMPLEMENTED_WITH_DEVIATIONS | BLOCKED | BACKEND_FAILURE | RATE_LIMITED`, plus free text), treated as a claim. When `classify` returns `unknown`, the raw error is logged verbatim so the first real occurrence becomes a fixture.

### 6.2 Implementations

- **`fake`** reads `tests/fixtures/scripts/<name>.json`: an ordered list of events to emit, optional delays, and files to write into `ctx.cwd`. Scripts: `happy`, `scope-violation` (writes outside `touch`), `rate-limited`, `crash-midrun`, `fix-round` (first voyage incomplete, second completes), `review-approve`, `review-fix`, `review-reject`.
- **`claude-sdk`** wraps `query()` with `cwd: ctx.cwd`, `settingSources: ["project"]`, `strictMcpConfig: true`, `disallowedTools` for anything the role does not need, `maxTurns`, and the dispatch gate as a `PreToolUse` **function** refusing Edit/Write outside `touch`. Auth from `config.providers.claude.auth`: `"login"` (default) uses the subprocess's existing login **and deletes `ANTHROPIC_API_KEY` from the subprocess env** — an inherited key silently overrides login (parent §2.2) and would bill per token; `"api_key"` sets `ANTHROPIC_API_KEY` in the subprocess env from `config.providers.claude.api_key_env` and requires `maxBudgetUsd`. The adapter logs which mode it resolved to as the first `voyage.event`.
- **`codex-mcp`** uses `@modelcontextprotocol/sdk`'s stdio client to spawn `codex mcp-server` with `cwd: ctx.cwd`, calls its `codex` tool, and `codex-reply` for FIX rounds in the same session. `touch` is checked server-side before spawn; the audit catches anything after.
- **Prompts** (`prompts/implement.md`, `prompts/review.md`) are the ported Lanes agent bodies with the spec, audit JSON and delta interpolated. The review prompt states that the audit JSON is ground truth and the implementer's report is a claim.

---

## 7. The spike

A throwaway `spikes/probe.mjs`, run before the adapter contract is frozen (plan task 2 or 3), that:

- (a) runs one `query()` under login with `tools: ["Read"]` and asks the agent to run Bash — answers R3 (is `tools:` a strict allowlist, or is `disallowedTools` required);
- (b) runs one query with tiny `maxBudgetUsd` / `maxTurns` to observe the result subtypes;
- (c) makes one `codex` MCP call and records the tool's input/output schema.

Raw message streams go to `docs/spikes/2026-10-<dd>-sdk-probe/*.jsonl` with a README of findings. Rate-limit shapes (R2) are captured opportunistically via the `unknown`-classification logging; the spike does not try to trigger one.

---

## 8. CLI, testing, errors

### 8.1 CLI

```
nexus init                                   # .nexus/config.json, nexus.db, fleet roster, .gitignore entries
nexus system create <slug> --brief <file> [--seed <n>]   # records base SHA; creates system/<id>/integration; generates 6 planets + belt + moons
nexus planet assign <system> --stream <id> --territory <glob>... [--planet <name>]   # next barren planet (or named); discovers one if none
nexus moon assign <planet> <spec-path> [--moon <name>]    # next barren moon (or named); discovers one if none; parse + hash spec; gate baseline
nexus moon launch <task> [--provider fake|codex|claude]   # assigns an idle freighter; worktree; dispatch; streams events
nexus system show <system>                   # the bodies: orbit, name, kind, what's assigned where
nexus voyage inspect <task>                  # launches a customs ship (review) → verdict
nexus voyage dock <task>                     # APPROVE only: commit, merge to planet, remove worktree; moon → settled
nexus moon reply <task> --note <text>        # adrift/quarantined → amendment appended; new round; ship released
nexus moon drop <task>                       # adrift/quarantined → task dropped; ship released; worktree + branch removed; moon → barren
nexus fleet retire <ship>                    # ship never assigned again (the only way the roster shrinks)
nexus status [<system>]                      # moons, voyages, ship statuses
nexus events [--since <id>] [--moon <id>] [--follow]
nexus db rebuild | stats | explain <name> | analyze
nexus validate <spec>
nexus fleet                                  # roster: idle / assigned / adrift
```

`launch` blocks until the agent returns, streaming `AgentEvent`s to the terminal. Every command is a thin wrapper over a `src/server/` function; v0.5's WebSocket handler calls the same functions.

### 8.2 Tests (`node --test` against `dist/`)

- `tests/validate/` — the ported vectors.
- `tests/db/` — append/apply; rebuild byte-equivalence; migrations; statement registry enforcement.
- `tests/core/` — body generator is deterministic (same seed → identical bodies; 6 rocky planets, 1–4 moons each; the 7th is a gas giant); discovery fires only when no barren body exists; transition table (every illegal transition refused); git model against a temp repo per test; merge conflict → adrift with worktree kept; the refusal list.
- `tests/e2e/` — the full moon lifecycle with `fake` on every fixture script: happy → merged; scope violation → adrift; rate-limited → adrift; fix round → merged; max rounds → adrift; reject → quarantined; reply → new round.
- `tests/conformance/` — the Lanes conformance tests that still apply (manifest; no `git push` in `src/`), retargeted.
- `tests/live/` — skipped unless `NEXUS_LIVE=1`; never in CI.

### 8.3 Errors

One rule: **the log is never wrong about the repo.** Agent failures become events and park the voyage with a reason. Git failures after a commit are retried by the next command from the recorded state. DB open failure, bad config, or a spec that does not hash are refused up front with no event written. Nothing catches-and-continues silently.

---

## 9. Changes to the parent design doc made alongside this spec

- §1 vocabulary: ships/voyages/fleets/cargo; Fleet HQ = integration branch; the star is scenery; the portal = landing on `main`; "Docking" is a ship event.
- §5: `ships` split into `ships` (roster) + `voyages`; `last_event_id` on projections; `query_stats`.
- §6.3: `moon.docked` → `voyage.docked` + `moon.merged`; parks and quarantine attach to voyages/ships.
- §1, §5, §6, §11: bodies are terrain. Systems are generated at creation (6 planets + belt + moons) and grow by discovery; work is *assigned* to barren bodies; nothing disappears. The belt is reserved for idle housekeeping.
- §6.3: planet branches are `system/<system-id>/<planet-name>` (namespaced under the system; the parent had `system/<planet-id>`).
- §7: integration branch at *every* rung is stated as a deliberate tightening of Lanes.
- §11: assets rule (`assets/LICENSES.md`); roster names.
- §14: the v0 row's "done when" is replaced by this spec's §1 (fake adapter in CI is the gate; the real-adapter run is a stretch).
