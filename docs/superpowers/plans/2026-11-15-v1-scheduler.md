# Aether Nexus v1 slice 1 — scheduler and the lower rungs — Implementation Plan

> **For agentic workers:** this plan is lane-tagged for Lanes (`.lanes/config.json`). Run it with `/lanes-run`: DELEGATE tasks are emitted as specs and dispatched; KEEP tasks use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `nexus serve` runs the work on a moon, and on all of a planet's moons, by itself, as far as the trust rung allows; the rung can be changed from the Bridge and the CLI.

**Architecture:** A pure function `plan(g, ctx)` reads the projections and the rung and returns the next actions. A loop inside `nexus serve` runs it whenever the event log moves and executes each action through the existing `launchMoon` / `inspectMoon` / `dockMoon` / `parkStaleMoon` functions and the existing `VoyageRunner`. No scheduler state is stored; a restart resumes from the log.

**Tech Stack:** Node ≥ 22.13, TypeScript, `node:sqlite`, `node:http`; Preact + Vite for the page; tests with `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-14-v1-scheduler-design.md` (read it first; section numbers below refer to it).

## Global Constraints

- **Wording (spec §1).** Places don't move; ships do. In comments, messages, page copy and test names: a *freighter is sent to* a moon, *customs inspects*, the *freighter docks*, the moon is then *settled* (status `merged`). Never "the moon launches / flies / docks". Existing identifiers (`moon.launch`, `launchMoon`, action `"launch"`) are not renamed.
- No new dependencies of any kind.
- Every state change is an appended event with a reducer; after any test scenario `rebuild` must leave `dumpProjections` byte-equal.
- Behaviour lives in `src/server/commands/` and `src/server/scheduler/`; HTTP handlers and CLI cases are thin wrappers.
- `Git` (`src/core/git.ts`) stays the only caller of git from `src/server/`.
- SQL lives only in `src/db/statements.ts` (see `tests/db/registry.test.mjs`). This plan needs no new statements; if a task finds it does, add a named one there.
- The scheduler never acts at `manual`, never answers a decision, never drops a moon, never exceeds `scheduler.max_concurrent_ships` or `scheduler.per_provider_max`.
- Every existing CLI command and HTTP command keeps its behaviour, except that `launchMoon` now refuses a first freighter to a moon with unsettled dependencies (Task 2).
- Do not modify security-routed files (`.lanes/config.json` `routing.security_routed`), in particular `src/server/dispatch.ts`. Import from it; do not edit it.
- Tests import from `dist/`; `npm test` builds first. Run one area with `npm test -- "tests/<dir>/*.test.mjs"`.
- Timer defaults: scheduler event poll `250` ms (the server's existing `pollMs`), slow tick `5000` ms.
- Each task lands as one commit on branch `design/v1-scheduler` (a DELEGATE task is committed in its worktree and merged by the Lanes controller, using the task's commit message). End commit messages with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.

**Before the run:** set `pipeline.ledger` in `.lanes/config.json` to `.superpowers/sdd/2026-11-15-v1-scheduler/progress.md` (it still points at the v0.5 ledger).

## Task/Lane Map

| task | lane | tier | depends-on |
|---|---|---|---|
| 1 Log-only kinds, wider `moon.adrift`, moon-only park | DELEGATE | terra | — |
| 2 Dependencies | DELEGATE | sol | 1 |
| 3 Rung command and config reload | DELEGATE | sol | 2 |
| 4 Rung command over HTTP and CLI | DELEGATE | terra | 3 |
| 5 Decision function | DELEGATE | sol | 4 |
| 6 Scheduler loop | KEEP | — | 5 |
| 7 End-to-end scenarios | DELEGATE | sol | 6 |
| 8 Page: rung selector | DELEGATE | terra | 7 |
| 9 Page: waiting labels | DELEGATE | terra | 8 |
| 10 Browser walkthrough | KEEP | — | 9 |
| 11 Documentation | KEEP | — | 10 |

KEEP reasons: 6 is concurrency-sensitive, touches five files and is where a mistake spends real provider quota; 10 needs a browser; 11 edits project instructions. The chain is linear because neighbouring tasks edit the same files (`park.ts`, `query.ts`, `config.ts`, `http/commands.ts`, the page's `types.ts`).

## Review Focus

1. **A person and the scheduler act on the same moon at once** (a click on Dock while the scheduler docks). Exactly one dock happens; the other gets the existing refusal; the scheduler does not count it as a failure or park the moon. Test in Task 6.
2. **`.nexus/config.json` is broken by hand, then the rung is changed.** The command refuses without writing; a server that is told to reload keeps the config it has, shows a notice, and keeps scheduling. Tests in Tasks 3 and 6.
3. **A dependency on a task id that is never assigned** (a typo in a spec). The moon waits, `waiting_on` names the missing id, nothing crashes and nothing loops. Test in Task 2.
4. **A dependency cycle** (A depends on B, B on A). No freighter is sent to either, both show `waiting on`, and `plan` returns. Test in Task 5.
5. **The server is killed hard mid-run at `roundabout` and started again.** The orphaned voyage is parked with a decision, other moons carry on, and no moon gets a second freighter for the same round. Test in Task 7.

## File Structure

| File | Responsibility |
|---|---|
| `src/core/transitions.ts` (modify) | `moon.adrift` legal from four more states |
| `src/db/reducers/index.ts` (modify) | no-op reducers for `scheduler.acted`, `config.changed` |
| `src/server/commands/park.ts` (modify) | `parkMoonOnly` |
| `src/server/commands/deps.ts` (new) | `dependencyState` |
| `src/server/commands/launch.ts` (modify) | first-freighter dependency precheck |
| `src/server/commands/query.ts` (modify) | `waiting_on`, `waiting_on_planets`, `ready_to_send` in the reads |
| `src/server/commands/config.ts` (modify) | `setAutomationLevel`, `reloadConfig`, shared write helper |
| `src/server/http/commands.ts` (modify) | `config.automation` |
| `src/cli/run.ts` (modify) | `nexus config set trust <level>` |
| `src/server/scheduler/plan.ts` (new) | `plan`, `effectiveRung` |
| `src/server/scheduler/loop.ts` (new) | `createScheduler` |
| `src/server/http/runner.ts` (modify) | `report` (a failure notice not tied to a voyage) |
| `src/server/http/server.ts` (modify) | create and stop the scheduler; pass `readyToSend` to the snapshot |
| `web/src/components/Header.tsx`, `web/src/types.ts`, `web/src/style.css` (modify) | rung selector |
| `web/src/components/SystemView.tsx`, `web/src/components/MoonDetail.tsx` (modify) | waiting labels |

---

### Task 1: Log-only kinds, wider `moon.adrift`, moon-only park (LANE: DELEGATE, tier terra)

**Files:**
- Modify: `src/core/transitions.ts`, `src/db/reducers/index.ts`, `src/server/commands/park.ts`
- Test: `tests/server/scheduler-foundations.test.mjs` (create)

**Interfaces:**
- Consumes: `append` (`src/db/events.ts`), `loadMoon`, `moonScope` (`src/server/dispatch.ts`), `repliedSincePark` (`src/server/commands/launch.ts`), `replyMoon` (`park.ts`).
- Produces:
  ```ts
  // src/server/commands/park.ts
  /** Park a moon that has no live voyage: moon.adrift + an 'adrift' decision. Legal from emitted, gated, audited, reviewing, adrift, quarantined. */
  export function parkMoonOnly(g: Galaxy, p: { taskId: string; reason: string; details: string }): void;
  ```
  Event kinds `scheduler.acted` and `config.changed` are accepted by `append` and project nothing.

**Behaviour:**
- `MOON_TRANSITIONS["moon.adrift"]` gains `emitted: "adrift"`, `gated: "adrift"`, `adrift: "adrift"`, `quarantined: "quarantined"` (spec §4.5). The existing three entries stay.
- `parkMoonOnly` appends `moon.adrift` with payload `{ reason }`, then `decision.opened` with payload `{ kind: "adrift", target_kind: "moon", target_id: taskId, reasoning: `${reason}: ${details}` }`, both scoped with `moonScope`. It follows the moon-only park already in `launch.ts` (the `parkMoon` closure) and does not replace it.
- The two new kinds are registered next to `tree.written` in `reducers/index.ts`, each with a one-line comment saying why nothing is projected.

- [ ] **Step 1: Write the failing tests** in `tests/server/scheduler-foundations.test.mjs`, using `worldWithMoon` from `tests/fixtures/world.mjs`:
  - `moon.adrift is legal from emitted, gated, adrift and quarantined`: `nextMoonStatus("emitted", "moon.adrift", "T1") === "adrift"`, same for `gated`; `nextMoonStatus("adrift", "moon.adrift", "T1") === "adrift"`; `nextMoonStatus("quarantined", "moon.adrift", "T1") === "quarantined"`; `merged` and `dropped` still throw `TransitionRefused`.
  - `parkMoonOnly parks an emitted moon with a decision`: after `parkMoonOnly(g, { taskId: "T1", reason: "scheduler_refused", details: "spec body changed" })`, `loadMoon(g, "T1").status === "adrift"`, `park_reason === "scheduler_refused"`, and `decisions.pendingByTarget` has exactly one row with `kind === "adrift"` whose `reasoning` includes `"spec body changed"`.
  - `a re-park consumes the reply`: park, `replyMoon(g, { taskId: "T1", note: "try again" })`, assert `repliedSincePark(...) === true` and no pending decisions; `parkMoonOnly` again; assert `repliedSincePark(...) === false`, status still `adrift`, one pending decision.
  - `scheduler.acted and config.changed are log-only`: append one of each (`scheduler.acted` scoped to the moon with payload `{ action: "launch", task_id: "T1", rung: "roundabout" }`; `config.changed` with payload `{ key: "automation.level", from: "manual", to: "verdicts", pid: 1 }`); `dumpProjections` is byte-equal before and after `rebuild`.
- [ ] **Step 2: Run** `npm test -- "tests/server/scheduler-foundations.test.mjs"` — expected: FAIL (`parkMoonOnly` is not exported; `no reducer for 'scheduler.acted'`).
- [ ] **Step 3: Implement** the three changes above.
- [ ] **Step 4: Run** the same command — expected: PASS. Then `npm test` — expected: no failures (the transition table test in `tests/core/transitions.test.mjs` may enumerate legal arrows; update it only if it fails on the four new arrows).
- [ ] **Step 5: Commit** — `feat(scheduler): moon-only park, wider moon.adrift, log-only scheduler kinds`

---

### Task 2: Dependencies (LANE: DELEGATE, tier sol)

**Files:**
- Create: `src/server/commands/deps.ts`
- Modify: `src/server/commands/launch.ts`, `src/server/commands/query.ts`
- Test: `tests/server/deps.test.mjs` (create)

**Interfaces:**
- Consumes: named statements `moons.byTask`, `moons.byPlanet`, `planets.byId`, `voyages.latestByAssignmentRole`; `Refusal`.
- Produces:
  ```ts
  // src/server/commands/deps.ts
  export type DependencyState = {
    /** A freighter has been sent to this moon under its current assignment (an implement voyage exists). */
    visited: boolean;
    /** Task ids in the moon's depends_on that are not settled on the same planet. */
    waitingOn: string[];
    /** Stream ids in the planet's depends_on. In this slice every one of them counts as unmet (spec §4.2). */
    waitingOnPlanets: string[];
  };
  export function dependencyState(g: Galaxy, taskId: string): DependencyState;
  ```
  `Snapshot` moon rows and `MoonDetail.moon` gain `waiting_on: string[]` and `waiting_on_planets: string[]`.

**Behaviour (spec §4.2):**
- A dependency id is settled only when a moon on the **same planet** has that `task_id` and status `merged`. Not assigned, `dropped`, `adrift`, `quarantined` or any other status → it stays in `waitingOn`. Order follows the spec's `depends_on` order.
- `depends_on` is a JSON text column on both `moons` and `planets`; null, empty or unparseable reads as `[]`. Read the rows through the named statements with a local row type — do not edit `MoonRow` / `PlanetRow` in `dispatch.ts`.
- `launchMoon`: after its state precheck, if `!visited && waitingOn.length > 0`, throw `Refusal` with the message `moon <taskId> is waiting on <id>, <id> — a freighter can be sent once they are settled`. `waitingOnPlanets` is **not** enforced here; a human may still send a freighter to a moon of a dependent planet.
- A visited moon (FIX round, reply after a voyage) is never refused by this check.
- Reads: for an assigned moon that is not visited, `waiting_on` / `waiting_on_planets` carry the two lists; for a visited or unassigned moon both are `[]`.

- [ ] **Step 1: Write the failing tests** in `tests/server/deps.test.mjs`. Build worlds with `makeGalaxy`, `createSystem`, `assignPlanet`, `writeSpec`, `assignMoon` as `tests/fixtures/world.mjs` does; set a spec's dependencies by replacing its `- **Depends on**:` line (see `tests/fixtures/specs/good-deps.md`).
  - `a moon with no dependencies waits on nothing`: `{ visited: false, waitingOn: [], waitingOnPlanets: [] }`.
  - `an unsettled dependency is listed`: B depends on A, both assigned → `dependencyState(g, "B").waitingOn` deep-equals `["A"]`.
  - `a dependency that is never assigned is listed` (Review Focus 3): B depends on `NOPE` → `waitingOn` deep-equals `["NOPE"]`; `snapshot(...)` and `moonDetail(g, "B", ...)` return without throwing and carry `waiting_on: ["NOPE"]`.
  - `a settled dependency clears`: run A through `launchMoon`, `inspectMoon`, `dockMoon` → `dependencyState(g, "B").waitingOn` deep-equals `[]`.
  - `a dependency on another planet's task does not count`: A assigned on planet P1, B on P2 depending on A, A settled → `waitingOn` deep-equals `["A"]`.
  - `launchMoon refuses a first freighter while dependencies are unsettled, at manual`: `await assert.rejects(launchMoon(g, { taskId: "B" }), /is waiting on A/)`; the moon is still `emitted`; no `voyage.launched` event exists for B.
  - `a visited moon is not re-checked`: a moon with a FIX verdict on record is sent its next freighter although a dependency was dropped meanwhile.
  - `planet dependencies are reported and not enforced`: planet assigned with `dependsOn: ["P0"]` → `waitingOnPlanets` deep-equals `["P0"]`, `waiting_on_planets` in the snapshot matches, and `launchMoon` succeeds.
- [ ] **Step 2: Run** `npm test -- "tests/server/deps.test.mjs"` — expected: FAIL (module `deps.js` not found).
- [ ] **Step 3: Implement** `dependencyState`, the `launchMoon` precheck, and the two read fields.
- [ ] **Step 4: Run** the same command — expected: PASS. Then `npm test` — expected: no failures. If an existing test sends a freighter to a moon whose spec lists unsettled dependencies, change that test's spec, not the check.
- [ ] **Step 5: Commit** — `feat(scheduler): enforce moon dependencies and report what a moon is waiting on`

---

### Task 3: Rung command and config reload (LANE: DELEGATE, tier sol)

**Files:**
- Modify: `src/server/commands/config.ts`
- Test: `tests/server/config-automation.test.mjs` (create)

**Interfaces:**
- Consumes: `normalizeConfig`, `validateConfig` (`src/config/schema.ts`), `recordTreeWrite`, `append`, `Refusal`.
- Produces:
  ```ts
  // src/server/commands/config.ts
  export type SelectableRung = "manual" | "verdicts" | "roundabout";
  export function setAutomationLevel(g: Galaxy, input: { level: string }): { level: SelectableRung; from: string; changed: boolean };
  /** Re-read .nexus/config.json into g.config. On any error g.config is left untouched. */
  export function reloadConfig(g: Galaxy): { ok: true } | { ok: false; error: string };
  ```

**Behaviour (spec §4.6):**
- `setAutomationLevel` starts from the file on disk, exactly as `setRoleOrder` does (parse, refuse if not a plain object or not valid, clone, change one key, validate the candidate, `recordTreeWrite`, temp file + rename, swap `g.config`). Factor the part the two functions share into one private helper in this file; `setRoleOrder`'s behaviour and messages must not change (`tests/server/config-roles.test.mjs` stays green untouched).
- It preserves every other key and the file's `automation.max_fix_rounds`; it creates the `automation` block if the file has none.
- Refusals, exact text: `highways` or `autopilot` → `'<level>' is not available yet — it arrives in a later release`; anything else outside the three values → `level must be manual, verdicts or roundabout`.
- `from` is the level the file had (default `manual`). If `from === level`: no write, no event, `changed: false`.
- After a successful write: `append(g.db, { kind: "config.changed", payload: { key: "automation.level", from, to: level, pid: process.pid } })`.
- `reloadConfig` returns `{ ok: false, error }` for a missing file, invalid JSON or a config that does not validate, with the same message text `setRoleOrder` would give for that file.

- [ ] **Step 1: Write the failing tests** in `tests/server/config-automation.test.mjs` (model on `tests/server/config-roles.test.mjs`):
  - `sets each of the three rungs`: for `verdicts`, `roundabout`, `manual` in turn → result `{ level, from, changed: true }`, `g.config.automation.level` matches, the file on disk matches, `automation.max_fix_rounds` and `roles` in the file are unchanged.
  - `appends config.changed with from, to and pid`: last event has `kind === "config.changed"` and payload `{ key: "automation.level", from: "manual", to: "verdicts", pid: process.pid }`.
  - `setting the current rung changes nothing`: `changed === false`, file bytes identical, no new event.
  - `refuses highways and autopilot`: `assert.throws(..., /is not available yet/)`, file bytes identical.
  - `refuses an unknown level`: `/level must be manual, verdicts or roundabout/` for `"turbo"` and `""`.
  - `refuses without writing when the file on disk is invalid` (Review Focus 2): overwrite the file with `{ not json`, expect a `Refusal` mentioning `.nexus/config.json is not valid JSON`, file bytes identical, `g.config` unchanged.
  - `starts from the file on disk, not the server's copy`: edit `roles.implement` order in the file by hand, call `setAutomationLevel`; the hand edit survives in the file.
  - `the write is recorded as the system's own`: a `tree.written` event with `paths` containing `.nexus/config.json` precedes the `config.changed` event.
  - `reloadConfig picks up a change made on disk`: edit `automation.level` in the file → `{ ok: true }` and `g.config.automation.level` follows.
  - `reloadConfig keeps the old config when the file is invalid`: `{ ok: false, error }` with a non-empty `error`; `g.config` deep-equals what it was.
- [ ] **Step 2: Run** `npm test -- "tests/server/config-automation.test.mjs"` — expected: FAIL (`setAutomationLevel` is not exported).
- [ ] **Step 3: Implement** both functions and the shared helper.
- [ ] **Step 4: Run** `npm test -- "tests/server/config-*.test.mjs"` — expected: PASS for both files.
- [ ] **Step 5: Commit** — `feat(scheduler): set the trust rung, with config reload`

---

### Task 4: Rung command over HTTP and CLI (LANE: DELEGATE, tier terra)

**Files:**
- Modify: `src/server/http/commands.ts`, `src/cli/run.ts`
- Test: `tests/http/commands.test.mjs`, `tests/cli/cli.test.mjs` (add cases)

**Interfaces:**
- Consumes: `setAutomationLevel(g, { level })` from Task 3.
- Produces: HTTP `POST /api/commands/config.automation` with body `{ "level": "<string>" }` → `200 { result: { level, from, changed } }`; CLI `nexus config set trust <level>`.

**Behaviour:**
- HTTP: add `"config.automation": { fields: { level: s() }, run: ... }` to `COMMANDS`, in the style of `config.roles`. Do **not** restrict `level` with `values`: an unavailable rung must reach `setAutomationLevel` and come back as `409` with its message, not as a `400`.
- CLI: `config` joins the list of galaxy commands in `run`; `nexus config set trust <level>` prints `rung: <from> -> <level>` (or `rung: <level> (unchanged)`), and the result object under `--json`. Any other `config` form is a usage error. Add one line to `USAGE`: `  config set trust <manual|verdicts|roundabout>`.

- [ ] **Step 1: Write the failing tests.**
  - `tests/http/commands.test.mjs`: `config.automation sets the rung` (200, `result.level === "verdicts"`, a following `GET /api/snapshot` has `rung === "verdicts"`); `config.automation refuses a later rung with 409` (`error` matches `/not available yet/`); `config.automation rejects a missing or non-string level with 400`; `config.automation rejects an unexpected field with 400`.
  - `tests/cli/cli.test.mjs`: `config set trust changes the rung` (exit 0, stdout `rung: manual -> verdicts`, file on disk updated); `config set trust refuses autopilot` (exit 2, stderr matches `/not available yet/`); `config with no subcommand prints usage` (exit 1).
- [ ] **Step 2: Run** `npm test -- "tests/http/commands.test.mjs"` and `npm test -- "tests/cli/cli.test.mjs"` — expected: FAIL (404 unknown command; usage error).
- [ ] **Step 3: Implement** the HTTP entry and the CLI case.
- [ ] **Step 4: Run** both commands — expected: PASS.
- [ ] **Step 5: Commit** — `feat(scheduler): config.automation over HTTP and 'nexus config set trust'`

---

### Task 5: Decision function (LANE: DELEGATE, tier sol)

**Files:**
- Create: `src/server/scheduler/plan.ts`
- Test: `tests/server/scheduler-plan.test.mjs` (create)

**Interfaces:**
- Consumes: `availableActions(g, taskId, ctx)` and its `Action` type (`src/server/commands/query.ts`); `dependencyState(g, taskId)` (Task 2); `loadMoon`, `providerAtCap`, `shipClassFor` (`src/server/dispatch.ts`); named statements `systems.all`, `planets.bySystem`, `moons.byPlanet`, `voyages.inFlight`, `ships.all`; `g.config.roles`, `g.config.scheduler`, `g.config.automation.level`, `g.adapters`.
- Produces:
  ```ts
  // src/server/scheduler/plan.ts
  export type Rung = "manual" | "verdicts" | "roundabout";
  /** highways and autopilot behave as roundabout until their slices land (spec §4.1). */
  export function effectiveRung(level: string): Rung;
  export type PlannedAction = {
    action: "dock" | "park_stale" | "inspect" | "launch";
    taskId: string;
    /** true when this would be the first freighter sent to the moon under its current assignment */
    first: boolean;
  };
  export type PlanCtx = {
    ownPid: number;
    tracks?: (voyageId: string) => boolean;
    /** task ids that already have a scheduler action running; never planned */
    busy?: ReadonlySet<string>;
    /** plan as if at this rung; default effectiveRung(g.config.automation.level) */
    rung?: Rung;
  };
  export function plan(g: Galaxy, ctx: PlanCtx): PlannedAction[];
  ```

**Behaviour (spec §4.1, §4.3):** `plan` writes nothing. For every assigned moon not in `ctx.busy`, take `availableActions` and keep at most one action:

| `availableActions` contains | moon status | condition | planned at |
|---|---|---|---|
| `dock` | `reviewing` | — | `verdicts`, `roundabout` |
| `park_stale` | `implementing` / `reviewing` | — | `verdicts`, `roundabout` |
| `inspect` | `audited` | — | `verdicts`, `roundabout` |
| `launch` | `audited` | (FIX on record) | `verdicts`, `roundabout` |
| `launch` | `adrift` / `quarantined` | `visited` | `verdicts`, `roundabout` |
| `launch` | `adrift` / `quarantined` | not `visited`, `waitingOn` and `waitingOnPlanets` both empty | `roundabout` |
| `launch` | `emitted` / `gated` | `waitingOn` and `waitingOnPlanets` both empty | `roundabout` |

- At `manual` the result is always `[]`.
- A moon whose `availableActions` is `["answer", ...]` (a pending main-tree question) gets nothing.
- **Capacity.** A `launch` or `inspect` is returned only if it can run now. Start with `free = max_concurrent_ships − (voyages in flight)`. For each such action, walk the role's provider order (`roles.implement` for `launch`, `roles.review` for `inspect`) and take the first provider that is configured in `g.adapters`, is under its `per_provider_max` counting voyages in flight plus voyages already planned in this pass, and still has an idle ship of the class (`freighter` / `customs`) not already claimed in this pass. If none, or `free` is 0, skip the moon. Otherwise decrement the counters and include the action. `dock` and `park_stale` consume nothing.
- **Order of the result:** `dock`, then `park_stale`, then `inspect`, then `launch` with `first: false`, then `launch` with `first: true`; within a group, ascending `assignment_id`. Capacity is handed out in this order.

- [ ] **Step 1: Write the failing tests** in `tests/server/scheduler-plan.test.mjs`. Build states with the fake adapter and the real command functions (as `tests/server/launch.test.mjs` and `review.test.mjs` do); set the rung by passing `ctx.rung`.
  - `effectiveRung`: `manual → manual`, `verdicts → verdicts`, `roundabout`, `highways`, `autopilot → roundabout`.
  - `manual plans nothing` — for an emitted moon, an audited moon with a holding freighter, and an approved moon.
  - One test per table row, asserting the action at each rung it is planned at and `[]` at each rung it is not: `an emitted moon gets a first freighter only at roundabout` (`[{ action: "launch", taskId: "T1", first: true }]`); `a holding freighter is inspected from verdicts up`; `an approved freighter is docked from verdicts up`; `a FIX verdict gets the next freighter from verdicts up` (`first: false`); `a replied-to visited moon gets a freighter from verdicts up`; `a replied-to never-visited moon gets one only at roundabout`; `a stale voyage is parked from verdicts up` (use `ctx.ownPid` equal to the launching pid with `tracks: () => false`).
  - `an adrift moon with no reply gets nothing`; `a quarantined moon with no reply gets nothing`.
  - `a pending main-tree question blocks every action`.
  - `unsettled dependencies hold the first freighter` (B depends on A → only A planned); `a dependency cycle plans nothing and returns` (Review Focus 4: A depends on B, B on A → `[]`).
  - `a planet with dependencies gets no first freighter, but later steps are planned`: planet assigned with `dependsOn: ["P0"]` → `[]` at `roundabout`; after a manual `launchMoon`, `inspect` is planned.
  - `capacity: no more voyages than max_concurrent_ships` (three ready moons, `max_concurrent_ships: 2`, none in flight → exactly two `launch`); `capacity: per_provider_max is respected`; `capacity: no more than the idle ships of the class` (fleet with 2 freighters, 3 ready moons → 2); `capacity: docks are planned even when no ship is free`.
  - `order: dock, park_stale, inspect, next freighter, first freighter; oldest assignment first`.
  - `busy moons are skipped`.
  - `plan writes nothing`: `events.maxId` is unchanged by a call.
- [ ] **Step 2: Run** `npm test -- "tests/server/scheduler-plan.test.mjs"` — expected: FAIL (module `scheduler/plan.js` not found).
- [ ] **Step 3: Implement** `effectiveRung` and `plan`.
- [ ] **Step 4: Run** the same command — expected: PASS.
- [ ] **Step 5: Commit** — `feat(scheduler): the decision function`

---

### Task 6: Scheduler loop (LANE: KEEP)

**Files:**
- Create: `src/server/scheduler/loop.ts`
- Modify: `src/server/http/runner.ts`, `src/server/http/server.ts`, `src/server/commands/query.ts`
- Test: `tests/server/scheduler-loop.test.mjs` (create)

**Interfaces:**
- Consumes: `plan`, `PlannedAction` (Task 5); `parkMoonOnly` (Task 1); `reloadConfig` (Task 3); `launchMoon`, `inspectMoon`, `dockMoon`, `parkStaleMoon`; `followEvents` (`src/server/follow.ts`); `VoyageRunner`; `loadMoon`, `moonScope`; `Refusal`, `TransitionRefused`, `GitRefusal`.
- Produces:
  ```ts
  // src/server/http/runner.ts — added to VoyageRunner
  /** Record a failure notice that is not tied to a voyage (shown with the others on the Bridge). */
  report(f: { taskId: string; message: string }): void;

  // src/server/scheduler/loop.ts
  export type Scheduler = {
    /** Ask for a pass. Calls during a pass coalesce into one further pass. */
    wake(): void;
    /** Resolves when no pass is running and none is pending. */
    settled(): Promise<void>;
    /** Stop the follower and the timer, wait for the running pass. Voyages in flight are not touched. */
    stop(): Promise<void>;
  };
  export function createScheduler(g: Galaxy, opts: { runner: VoyageRunner; pollMs: number; tickMs?: number }): Scheduler;

  // src/server/http/server.ts — startServer opts gain
  schedulerTickMs?: number;   // default 5000

  // src/server/commands/query.ts — snapshot ctx gains readyToSend?: number; Snapshot gains
  ready_to_send: number;      // first freighters that would be sent now at roundabout; 0 when not supplied
  ```

**Behaviour (spec §4.4, §4.5, §4.6):**

- `startServer` creates the scheduler after the runner and calls `wake()` once. `close()` calls `scheduler.stop()` **before** `runner.abortAll()`.
- The snapshot route passes `readyToSend: plan(g, { ownPid: process.pid, tracks: (id) => runner.tracks(id), rung: "roundabout" }).filter((a) => a.action === "launch" && a.first).length`.
- **Wake-ups:** `followEvents(g.db, { since: <current max event id>, pollMs, onEvents })` plus `setInterval(wake, tickMs)` (unref'd). In `onEvents`, for each `config.changed` row whose `payload.pid !== process.pid`, call `reloadConfig(g)`; on `{ ok: false }` call `runner.report({ taskId: "config", message: `.nexus/config.json was changed by another process and could not be reloaded: ${error}` })`. Then `wake()`.
- **One pass at a time.** A pass:

  ```
  actions = plan(g, { ownPid: process.pid, tracks: runner.tracks, busy })
  forget failure records whose moon status has changed since they were recorded
  for each action, in order:
    append scheduler.acted { action, task_id, rung }   (scoped with moonScope)
    try: execute(action)
         forget the failure record for (taskId, action)
    catch e:
         if plan(g, same ctx) no longer contains (taskId, action): continue        # the state or capacity moved: a race, not a failure
         if no failure record for (taskId, action): record { status: moon status }; continue
         forget the record
         parkMoonOnly(g, { taskId, reason: e is Refusal | TransitionRefused | GitRefusal ? "scheduler_refused" : "scheduler_error", details: message of e })
         (if parkMoonOnly itself throws: runner.report({ taskId, message }) and continue)
  ```

- **Executing an action:**
  - `dock` → `dockMoon(g, { taskId })`, inline.
  - `park_stale` → `parkStaleMoon(g, { taskId, reason: "the voyage's process is gone" })`, inline.
  - `launch` / `inspect` → `await runner.start(taskId, ({ signal, onLaunched }) => launchMoon | inspectMoon(g, { taskId, signal, onLaunched }))`. The pass waits only for `start` to resolve (voyage launched, or returned without launching) or reject (refused before launch). Add `taskId` to `busy` before `start` and remove it when the wrapped run settles, whatever the outcome. No provider is passed.
- A voyage that fails **after** launch is the runner's business (it records the failure; the voyage shows as stale and the next pass parks it). The loop does not count it.
- A thrown error must never escape a pass or stop the loop; anything unexpected outside the per-action `try` goes to `runner.report` and the loop carries on.
- Wording of comments and messages follows Global Constraints.

- [ ] **Step 1: Write the failing tests** in `tests/server/scheduler-loop.test.mjs`. Use `startWorld` (`tests/http/helpers.mjs`) with `{ server: { pollMs: 20, schedulerTickMs: 200 } }`, set the rung with `setAutomationLevel(x.w.g, { level })`, and wait on state with a small polling helper local to the file (`until(fn, ms = 5000)`).
  - `manual: nothing is ever written by the scheduler`: at `manual`, after 300 ms, no `scheduler.acted` event exists and T1 is still `emitted`.
  - `verdicts: after a human sends a freighter the moon is settled unattended`: POST `moon.launch` for T1 → `until` T1 is `merged`; `scheduler.acted` events for T1 are, in order, `inspect` then `dock`; no `scheduler.acted` with `action: "launch"`.
  - `roundabout: a freighter is sent to a ready moon`: set `roundabout` → T1 reaches `merged` with no command.
  - `caps: never more than max_concurrent_ships in flight`: patch config `scheduler.max_concurrent_ships = 1`, three ready moons with the `slow` script; sample `voyages.inFlight` on every event of the feed until all three are settled; the maximum seen is 1.
  - `a refusal twice in a row parks the moon and stops`: at `roundabout`, after assign, append a line to T1's spec body on disk (so `launchMoon` refuses with `spec body changed`); `until` T1 is `adrift` with `park_reason === "scheduler_refused"`; exactly two `scheduler.acted` events for T1; one pending `adrift` decision whose reasoning includes `spec body changed`; after another 300 ms still exactly two.
  - `a replied-to adrift moon that is refused twice is re-parked`: continue the case above with `replyMoon` (leaving the spec body changed) → two more `scheduler.acted`, then a fresh pending decision and `repliedSincePark === false`.
  - `a click racing the scheduler is not a failure` (Review Focus 1): wrap `x.w.g.adapters.fake.dispatch` to hold the review's `done` event behind a promise; when T1 is `reviewing`, release it and immediately POST `voyage.dock` in a loop until T1 is `merged`; afterwards T1 is `merged`, there is exactly one `voyage.docked` event, and T1 was never `adrift` (no `moon.adrift` event).
  - `a rung change from another process is picked up`: start at `verdicts`; write `automation.level: "manual"` into the file and append `config.changed` with `pid: 0`; POST `moon.launch`; after the freighter is `holding`, wait 300 ms: no `scheduler.acted` event exists.
  - `an unreadable config after a foreign change keeps the old one and shows a notice` (Review Focus 2): write `{ not json` to the file, append `config.changed` with `pid: 0`; `GET /api/snapshot` → `failures` has an entry whose `message` matches `/could not be reloaded/`, `rung` is unchanged, and a following manual launch is still carried through to `merged` at `verdicts`.
  - `snapshot reports ready_to_send`: at `manual` with T1 emitted → `ready_to_send === 1`; after T1 is settled → `0`.
  - `stop waits for the pass and leaves voyages alone`: `await x.close()` during a `slow` voyage resolves, and the voyage's park reason is `interrupted` (the runner's abort), not `scheduler_error`.
- [ ] **Step 2: Run** `npm test -- "tests/server/scheduler-loop.test.mjs"` — expected: FAIL (`schedulerTickMs` ignored; nothing advances; `ready_to_send` undefined).
- [ ] **Step 3: Add `report` to the runner** (`recorded.unshift`, cap 50, `opts.onFailure()` — the same path a voyage failure takes, with `voyageId: null`).
- [ ] **Step 4: Implement `createScheduler`** as specified above.
- [ ] **Step 5: Wire it into `startServer` and the snapshot route**; add `ready_to_send` to `Snapshot` and `snapshot`.
- [ ] **Step 6: Run** `npm test -- "tests/server/scheduler-loop.test.mjs"` — expected: PASS. Run it five times in a row to look for timing flakes; a test that fails once in five is a bug in the loop or the test, not noise.
- [ ] **Step 7: Run** `npm test` — expected: no failures. Existing HTTP tests start a server at `manual`, so the scheduler must be inert for them.
- [ ] **Step 8: Commit** — `feat(scheduler): the loop in nexus serve`

---

### Task 7: End-to-end scenarios (LANE: DELEGATE, tier sol)

**Files:**
- Modify: `tests/fixtures/world.mjs`
- Test: `tests/e2e/scheduler.test.mjs` (create)

**Interfaces:**
- Consumes: `startWorld`, `readFeed` (`tests/http/helpers.mjs`); HTTP commands `moon.assign`, `moon.launch`, `moon.reply`, `config.automation`, `planet.assign`; `GET /api/snapshot`; `startServer`.
- Produces:
  ```js
  // tests/fixtures/world.mjs
  /** Write and commit one spec per entry and return their paths. deps: task ids; scripts: FAKE-SCRIPT names (an implement script and optionally a review-* script). */
  export function writeSpecs(w, entries /* [{ id, deps?: string[], scripts?: string[] }] */) // → string[]
  ```

**Behaviour:** no product code changes. Every scenario drives the server over HTTP only, ends with `rebuild` leaving `dumpProjections` byte-equal, and closes the server in `finally`. A fake review is steered by a `<!-- FAKE-SCRIPT: review-reject -->` comment in the spec (see the adapter's `pick` in `src/providers/fake/index.ts`); "one FIX round" needs the adapter wrapped so only the first review of that spec is prefixed with `FAKE-SCRIPT: review-fix` (the pattern in `tests/e2e/bridge.test.mjs`).

- [ ] **Step 1: Write the scenarios** (they are expected to pass against Task 6; a failure is a finding to report, not something to work around in the test):
  1. `roundabout settles a three-moon planet unattended` — A, B depending on A, C independent, one FIX round on A. Assign all three, then `config.automation` → `roundabout`. All three reach `merged` with no further command. In the event log the `voyage.launched` (implement) for B has a higher id than the `voyage.docked` for A. A has two implement voyages (rounds 1 and 2).
  2. `a REJECT holds only its own moon` — same planet, C scripted `review-reject`. C ends `quarantined` with one pending `reject` decision; A and B end `merged`.
  3. `verdicts sends no first freighter` — at `verdicts`, 300 ms after assign no `voyage.launched` exists; after `moon.launch` for A, A reaches `merged`.
  4. `lowering the rung mid-run starts nothing new` — at `roundabout` with the `slow` script on A and B depending on A: once A is `implementing`, set `manual`; A's freighter ends `holding`, A stays `audited`, and B gets no voyage.
  5. `a restart resumes from the log` (Review Focus 5) — at `roundabout`, A `slow`, C independent. Once A is `implementing`, close the server and start a new one on the same galaxy. C reaches `merged`. A is `adrift` with a pending decision. A has exactly one implement voyage for round 1.
  6. `a planet with dependencies gets no first freighter` — second planet assigned with `dependsOn: ["P1"]` and one moon D: at `roundabout` D gets no voyage and the snapshot shows `waiting_on_planets: ["P1"]`; after a manual `moon.launch` D reaches `merged` unattended.
  7. `a reply to a never-visited adrift moon` — the moon must be `adrift` with no implement voyage and must be sendable after a reply. Get there by calling `parkMoonOnly(x.w.g, { taskId, reason: "test_hold", details: "held for the test" })` on the galaxy object (the one step in this file that is not HTTP; a restricted-space park is not suitable because the gate may keep refusing it). Then: at `verdicts`, `moon.reply` sends nothing (300 ms, no voyage); after `config.automation` → `roundabout` a freighter is sent and the moon reaches `merged`.
- [ ] **Step 2: Run** `npm test -- "tests/e2e/scheduler.test.mjs"` — expected: PASS. Run it five times in a row.
- [ ] **Step 3: Run** `npm test` — expected: no failures.
- [ ] **Step 4: Commit** — `test(scheduler): end-to-end scenarios over HTTP`

---

### Task 8: Page — rung selector (LANE: DELEGATE, tier terra)

**Files:**
- Modify: `web/src/components/Header.tsx`, `web/src/types.ts`, `web/src/style.css`
- Test: `tests/http/page-rung.test.mjs` (create)

**Interfaces:**
- Consumes: `useCommand(b)` from `web/src/components/ActionBar.tsx` (`command.send(name, body)` resolves to a boolean; `command.busy`; `command.error`), as `Routing.tsx` uses it; `snapshot.rung`; `snapshot.ready_to_send` (Task 6).
- Produces: `Snapshot` in `web/src/types.ts` gains `ready_to_send: number`.

**Behaviour (spec §4.7):**
- The header's `rung: <value>` text becomes `rung: ` followed by a `<select aria-label="Trust rung">` with three options, exact copy:
  - `manual — you do every step`
  - `verdicts — you send each freighter; the server inspects, docks and re-runs fixes`
  - `roundabout — the server also sends a freighter to every ready moon`
- The selected option follows `snapshot.rung`. If the snapshot's rung is `highways` or `autopilot`, add it as a fourth, disabled, selected option showing just its name.
- Choosing `manual` or `verdicts`, or choosing `roundabout` when `snapshot.ready_to_send === 0`, sends `config.automation` with `{ level }` at once.
- Choosing `roundabout` when `ready_to_send > 0` shows one inline line instead of sending — never `window.confirm`: `Raising to roundabout sends <n> freighter now.` / `…<n> freighters now.` with buttons `Raise` and `Cancel`. `Raise` sends the command; `Cancel` puts the selector back.
- While a command is in flight the selector and both buttons are disabled. A refusal shows in a `.msg-error` line under the header.
- The existing bundle copy `rung: ` and `in flight ` must remain (`tests/http/page-panels.test.mjs`).

- [ ] **Step 1: Write the failing test** `tests/http/page-rung.test.mjs`, in the style of `tests/http/page-panels.test.mjs` (built-bundle strings and source text): the bundle contains each of the three option strings, `Trust rung`, `Raising to roundabout sends `, `Raise`, `Cancel` and `config.automation`; `Header.tsx` does not contain `confirm(`; `web/src/types.ts` contains `ready_to_send: number`.
- [ ] **Step 2: Run** `npm test -- "tests/http/page-rung.test.mjs"` — expected: FAIL (bundle is missing the option copy).
- [ ] **Step 3: Implement** the selector, the confirmation line and the type field; add only the CSS the new line needs.
- [ ] **Step 4: Run** `npm test -- "tests/http/page-*.test.mjs"` — expected: PASS for all page tests.
- [ ] **Step 5: Commit** — `feat(bridge): trust rung selector`

---

### Task 9: Page — waiting labels (LANE: DELEGATE, tier terra)

**Files:**
- Modify: `web/src/components/SystemView.tsx`, `web/src/components/MoonDetail.tsx`
- Test: `tests/http/page-waiting.test.mjs` (create)

**Interfaces:**
- Consumes: moon rows in `snapshot.systems[].planets[].moons[]` and `MoonDetail.moon`, each carrying `waiting_on: string[]` and `waiting_on_planets: string[]` (Task 2). Rows are typed `Row` (`Record<string, unknown>`): read the two fields defensively (treat anything that is not an array of strings as empty).

**Behaviour (spec §4.7):**
- In the system view's moon row and at the top of the moon detail panel, when the list is non-empty: `waiting on <id>, <id>` and, separately, `waiting on planet <stream>, <stream>`. Both can show at once. Nothing is rendered when both are empty.
- Action buttons are unchanged.

- [ ] **Step 1: Write the failing test** `tests/http/page-waiting.test.mjs` (bundle strings and source text): the bundle contains `waiting on ` and `waiting on planet `; both component sources reference `waiting_on` and `waiting_on_planets`.
- [ ] **Step 2: Run** `npm test -- "tests/http/page-waiting.test.mjs"` — expected: FAIL.
- [ ] **Step 3: Implement** the two labels (one small shared helper in whichever of the two files the other already imports from, or duplicated if neither does — do not add a new file).
- [ ] **Step 4: Run** `npm test -- "tests/http/page-*.test.mjs"` — expected: PASS.
- [ ] **Step 5: Commit** — `feat(bridge): show what a moon is waiting on`

---

### Task 10: Browser walkthrough (LANE: KEEP)

**Files:** none (findings go to the ledger; a defect found here becomes a fix task).

Rendering is not covered by the suite (bundle-string and source-text checks only), so this task is the only evidence the page works.

- [ ] **Step 1:** Build (`npm run build`), create a scratch galaxy in a temp directory with the fake adapter (as the v0.5 walkthrough did; see `reference-lanes-codex-windows` in memory for how page components were verified), with one planet and three specs: A, B depending on A, C scripted `review-reject`. Start `node dist/cli/main.js serve` and open the printed URL in Chrome.
- [ ] **Step 2:** With the rung at `manual`, assign the three moons. Check: B shows `waiting on A`; the selector shows `manual`; nothing moves for 10 seconds.
- [ ] **Step 3:** Choose `roundabout`. Check: the line reads `Raising to roundabout sends 2 freighters now.`; `Cancel` restores `manual` and sends nothing; choosing again and pressing `Raise` changes the selector and the page shows voyages starting without a reload.
- [ ] **Step 4:** Watch to the end. Check: A and B end settled, B's freighter was sent only after A's docked, C is quarantined with a decision in the Decisions panel, and no console errors were logged.
- [ ] **Step 5:** Choose `manual`. From a terminal run `node dist/cli/main.js config set trust verdicts` in the scratch galaxy. Check: the selector follows within a second.
- [ ] **Step 6:** Narrow the window to about 400 px. Check: the selector and the confirmation line stay usable.
- [ ] **Step 7:** Record what was checked and anything that failed in the ledger. Delete the scratch galaxy.

---

### Task 11: Documentation (LANE: KEEP)

**Files:**
- Modify: `CLAUDE.md`, `docs/2026-10-10-aether-nexus-design.md`

- [ ] **Step 1:** `CLAUDE.md` → *Fork notes*: add a `v1 slice 1 (<date>)` line: the scheduler lives in `src/server/scheduler/` and runs only inside `nexus serve`; `automation.level` now changes behaviour (`manual`, `verdicts`, `roundabout`; later rungs load as `roundabout` and cannot be selected yet); a first freighter is refused until the moon's dependencies are settled, at every rung.
- [ ] **Step 2:** `CLAUDE.md` → *Commands*: add `nexus config set trust <manual|verdicts|roundabout>`. *Gotchas*: add the lock note parked on 2026-11-14 — `npm install` / `npm audit fix` on Windows can drop the optional `@emnapi/core` and `@emnapi/runtime` lock entries, and `npm ci` then fails on Linux and macOS CI; check `git diff package-lock.json` before pushing.
- [ ] **Step 3:** Parent design §14.1: mark slice 1 as built, with the design doc's path.
- [ ] **Step 4:** `npm test` — expected: no failures (docs only; confirms nothing else moved).
- [ ] **Step 5: Commit** — `docs: v1 slice 1 — scheduler and the lower rungs`
