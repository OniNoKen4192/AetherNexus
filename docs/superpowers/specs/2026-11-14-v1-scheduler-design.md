# v1 slice 1 — scheduler and the lower rungs (design)

**Status:** draft, 2026-11-14
**Parent:** `docs/2026-10-10-aether-nexus-design.md` §6.3, §7, §14.1 (slice 1 of v1)
**Builds on:** `docs/superpowers/specs/2026-11-13-v0.5-bridge-design.md`

Marking used below: **(owner)** = decided by the owner in conversation; **(call)** = the designer's choice, open to correction.

---

## 1. Intent

The owner's principle **(owner)**: *the whole system should just run, unless something rises to the level of human attention.*

As of v0.5 the server does nothing on its own. Launch, inspect and dock are three commands, each started by a person. The trust rung (`automation.level`) is stored and shown but changes no behaviour, and a moon's `depends_on` is stored but never read.

This slice makes the server run the work on a moon, and then on all of a planet's moons, by itself. The rung decides how much it does alone, and the rung can be changed from the Bridge.

**Wording.** Places don't move; ships do (parent §1). A moon is a task and stays where it is. A **freighter** is sent to a moon (an implement voyage), **customs** inspects the freighter's cargo (a review voyage), and the freighter **docks** at the planet (the merge), after which the moon is **settled** (status `merged`). The existing command names `moon.launch` / `launchMoon` mean "send a freighter to this moon"; they are not renamed here.

## 2. Goals, non-goals, anti-goals

**Goals**
1. At `verdicts`: after a human sends a freighter to a moon, the server sends customs to inspect it, docks the freighter on APPROVE, and sends a new freighter on FIX up to `automation.max_fix_rounds`.
2. At `roundabout`: additionally, a freighter is sent to every assigned moon whose dependencies are settled, without a click. The rung alone is the consent **(owner)** — there is no per-planet "go".
3. `depends_on` is enforced.
4. The rung can be changed from the Bridge and from the CLI, validated before the write.
5. A server restart resumes from the event log with nothing remembered in memory.

**Non-goals (later slices)**
- Fuel readings and the limiter (slice 2). The existing caps (`scheduler.max_concurrent_ships`, `scheduler.per_provider_max`) are the only brake in this slice.
- Intake, `triage` / `decompose` / `plan` roles, `approve_map`, `highways`, carriers and Fleet HQ (slice 3). When every moon of a planet is settled, nothing further happens in this slice.
- `autopilot` and gravity (slice 4).
- Editing `max_fix_rounds` or the concurrency caps from the Bridge.
- Re-reading `.nexus/config.json` when it is edited by hand while the server runs.

**Anti-goals** — the slice has failed if any of these can happen:
- The scheduler acts at `manual`.
- The scheduler answers or resolves a decision, drops a moon, or sends a freighter to an adrift or quarantined moon that the human has not replied to.
- The scheduler exceeds a concurrency cap or sends a freighter to a moon before its dependencies are settled.
- Work on a moon stops silently: every stop is either a normal wait with a visible reason, or a decision on the Bridge.
- The scheduler retries a failing action in a tight loop.

## 3. Approaches

1. **A pure decision function plus a loop — chosen.** One function reads the projections and the rung and returns the next actions. A loop in `nexus serve` runs it whenever the event log moves and executes the actions through the existing commands. No scheduler state survives between runs, so restart safety and rung changes fall out of the design, and the function is testable as a table of state → actions without any adapter.
2. **Chain the commands.** The launch handler calls inspect, then dock. Least code, but "what is next" lives in a running promise: a restart strands the work on every moon mid-chain, and sending freighters to dependent moons needs a second mechanism anyway.
3. **A stored job queue.** The scheduler writes intended actions to a table that workers consume. Auditable, but it duplicates state the projections already hold and adds a second thing to keep consistent with the log.

The owner handed this choice to the designer; approach 1 is the designer's pick **(call)**.

## 4. Design

### 4.1 What each rung does unattended

| Situation (moon / freighter state) | Action | `manual` | `verdicts` | `roundabout` and above |
|---|---|---|---|---|
| `audited`, freighter `holding` | send customs to inspect | — | auto | auto |
| `reviewing`, last verdict APPROVE, freighter `cleared` / `en_route` / `docked` | dock the freighter | — | auto | auto |
| `audited`, last verdict FIX, round below the cap | send a freighter (next round) | — | auto | auto |
| `adrift` or `quarantined`, human reply newer than the park, **visited before** | send a freighter | — | auto | auto |
| `adrift`, human reply newer than the park, **never visited**, all dependencies settled | send a freighter | — | — | auto |
| voyage in flight whose owning process is dead (`stale`) | park the voyage | — | auto | auto |
| `emitted` or `gated`, all dependencies settled | send a freighter | — | — | auto |

Notes:
- "Visited" means a freighter has been sent to the moon under its current assignment (at least one implement voyage exists). A moon can be `adrift` without one (restricted space at assign, a gate failure while `emitted`, a `scheduler_refused` park). A reply to such a moon does not make its first freighter automatic at `verdicts`, where sending one is still the human's step; at `roundabout` it is a first freighter like any other **(call)**.
- The inspect, dock and next-round rows are exactly the `inspect`, `dock` and `launch` answers `availableActions` (`src/server/commands/query.ts`) already gives for those states. The decision function should be built on it, not beside it, so the Bridge's buttons and the scheduler can never disagree about what is possible.
- A moon with a pending `main_tree_changed` decision gets no automatic action (already what `availableActions` returns).
- A reply is the human act; sending a freighter after it is not a new decision, so it is automatic from `verdicts` up **(call)**.
- A stale voyage is parked automatically because parking opens a decision: it turns a silent stall into a visible one **(call)**.
- `highways` and `autopilot` are valid config values today. Until their slices land, the scheduler treats them as `roundabout` (rungs are cumulative) **(call)**.
- Human commands keep working at every rung. If a person and the scheduler race for the same step, the loser gets the existing refusal.

### 4.2 Dependencies

- A moon's dependencies are **settled** when every task id in its `depends_on` is assigned to a moon on the same planet and that moon's status is `merged`. An id that is not assigned on the planet, or whose moon is dropped, adrift or quarantined, is unsettled.
- `launchMoon` refuses a **first freighter** to a moon with unsettled dependencies **at every rung, manual included (call)**. A first freighter is any implement voyage to a moon whose current assignment has none yet, whatever the moon's status — so a never-visited moon that a human has replied to is checked too. Today a freighter can be sent before the moon's dependencies are settled, which cuts its worktree from a planet branch that lacks their work. A moon that has been visited (FIX round, reply after a voyage went adrift) is not re-checked.
- The snapshot and the moon detail gain `waiting_on: string[]` (unsettled task ids, empty when none) so the page can say why no ship has been sent.
- **Planet dependencies.** Planets also store `depends_on` (stream ids), and no carrier takes a planet's work to Fleet HQ until slice 3, so in this slice a planet-level dependency can never be met. The scheduler does **not** send first freighters to moons of a planet whose `depends_on` is non-empty: its branch lacks the upstream planet's work, which is the same fault the moon rule prevents. Those moons show `waiting on planet <stream>`. A human can still send a freighter by hand, as today — the hold is on the scheduler only, so nothing that works in v0.5 stops working **(call)**. Steps after the first freighter (inspect, dock, the next FIX round) are automatic on such a planet as on any other. Slice 3 replaces the hold with a real check against delivered planets.
- When a ship goes adrift at a moon, that moon's dependents wait and unrelated sibling moons carry on **(call)**. Nothing extra is opened for the dependents: the adrift moon's own decision is the thing that needs attention, and the dependents show `waiting on <task>`.

### 4.3 The decision function

`plan(g, rung) → Action[]`, pure with respect to the database and the rung: it reads projections and writes nothing.

- One action at most per moon.
- It only returns actions that can run **now**: before planning a freighter or customs voyage it checks there is room under `max_concurrent_ships` and that some provider in the role's order has an idle ship of the right class under its `per_provider_max`. A moon that is ready but has no ship available is simply not returned; it is picked up on a later pass. Capacity is consumed in order as actions are added, so one pass never plans more voyages than there is room for.
- Order within a pass: docks first (they free ships and unblock dependents), then inspections, then next-round freighters, then first freighters. Ties break by assignment order (oldest first) **(call)**.
- The provider is not chosen here; `launchMoon` / `inspectMoon` pick it from the role order as they do for a human click with no provider given.

### 4.4 The loop

- Lives in `nexus serve` only, created in `startServer` next to the feed and the voyage runner, stopped in `close()` before `runner.abortAll()`. CLI commands stay one-shot and never schedule **(call)**.
- **Wake-ups:** new events in the log (via `followEvents`, so events written by a CLI process in another terminal also wake it), plus a slow timer (5 s) for things that change without an event, such as a voyage's owning process dying. Wake-ups during a pass coalesce into one further pass.
- **One pass at a time.** A pass calls `plan`, then executes each action:
  - dock and stale-park run inline (they are synchronous);
  - freighter and customs voyages go through the same `VoyageRunner.start` the HTTP commands use, so cancel, failure reporting and shutdown behave identically. The pass waits only until the voyage is launched (or refused), not until the ship returns.
- **In-progress guard:** the loop keeps the set of task ids it has an action running for and skips them when planning. This is an optimisation; the commands' own state checks and the launch transaction remain the authority.
- **Marking:** before each automatic action the loop appends `scheduler.acted` with `{ action, task_id, rung }`, scoped to the moon. It appears in the moon's event list and in the feed; it has no projection of its own.

### 4.5 When an automatic action does not go through

| Outcome | What the scheduler does |
|---|---|
| The command parks the moon itself (gate failure on an `emitted` moon, audit violations, merge conflict, max fix rounds, a REJECT, any adapter failure) | Nothing more. The existing park and decision are the result. |
| Refusal because the state moved or capacity vanished between planning and acting (a race with a human or another process) | Nothing. The next pass plans again from the new state. |
| Any other refusal, or an unexpected error, on the **same moon and action twice in a row** | Park the moon: `moon.adrift` with reason `scheduler_refused` (or `scheduler_error`) and an `adrift` decision carrying the message. The human answers it with the existing reply / drop. |

To make the third row possible from every state the scheduler acts in, `moon.adrift` becomes legal from four more states (`MOON_TRANSITIONS` in `src/core/transitions.ts`); it is already legal from `audited` and `reviewing`:

- `emitted → adrift` and `gated → adrift`;
- `adrift → adrift` and `quarantined → quarantined` — a **re-park**. This covers a freighter sent automatically after a reply and refused twice (spec file missing, spec body changed, carry-over audit refusing the parked worktree, a gate failure on a moon that is no longer `emitted`). The status does not change, but the new `moon.adrift` event is newer than the reply, so `repliedSincePark` is false again and the scheduler stops; the fresh `adrift` decision puts it back on the Bridge, since the reply resolved the earlier one. The human replies again or drops **(call)**.

A moon parked by the scheduler has no live voyage, so the park is the moon-only form already used by the carry-over park in `launch.ts` (`moon.adrift` + `decision.opened`).

"Twice in a row" is tracked in memory per `(task id, action)` and cleared whenever that moon's status changes. After a restart the count starts again; the worst case is one extra attempt.

### 4.6 Changing the rung

- New command `config.automation` with field `level` (HTTP `POST /api/commands/config.automation`; CLI `nexus config set trust <level>`, the name ported from Lanes).
- Accepted values in this slice: `manual`, `verdicts`, `roundabout`. `highways` and `autopilot` are refused with a message saying they arrive in a later release **(call)**. A config file that already says one of them is still loaded (4.1).
- The write follows `setRoleOrder` in `src/server/commands/config.ts`: validate the candidate, `recordTreeWrite`, write to a temp file and rename, then swap `g.config`. The shared part should be factored out rather than copied.
- After the write the command appends `config.changed` with `{ key: "automation.level", from, to, pid }`. This is what wakes the loop and what makes the change visible in replay.
- **A change made from the CLI while a server is running** happens in another process, which swaps only its own copy of the config. So when the server sees a `config.changed` event it did not write (`pid` is not its own), it reloads `.nexus/config.json` through the normal validation and swaps `g.config`; if the file does not validate it keeps the config it has and records a failure notice for the Bridge. This is what makes `nexus config set trust manual` work as a stop control from a terminal **(call)**. It is not a general file watcher: a hand edit with no event is still picked up only on restart.
- **Raising** the rung takes effect on the next pass: at `roundabout` a freighter is sent to every assigned, ready moon on every planet, up to the caps. This is the intended behaviour **(owner)**.
- **Lowering** the rung starts nothing new; voyages already in flight finish and then wait for a person **(call)**. `manual` is therefore the stop control.
- The default for a new galaxy stays `manual` **(call)**.

### 4.7 The Bridge page

The header's read-only rung label becomes a selector:

```
AetherNexus · my-repo      Rung [ roundabout ▾ ]      3 of 6 ships in flight
                                 ├ manual      — you do every step
                                 ├ verdicts    — you send each freighter; the server inspects, docks and re-runs fixes
                                 └ roundabout  — the server also sends a freighter to every ready moon
```

- Selecting a value posts `config.automation`; the label follows the snapshot, as the routing order does.
- Raising to `roundabout` shows one confirmation line stating how many freighters would be sent now (ready moons, capped by free ships) **(call)**. This is the only extra click the slice adds, and it happens once per rung change, not per planet.
- A moon that is waiting shows `waiting on <task>, <task>` in the system view and its detail panel.
- Action buttons are unchanged at every rung.

The four Bridge minors parked on 2026-11-14 are not part of this slice.

### 4.8 Things deliberately left as they are

- A voyage interrupted by a server shutdown still parks as `interrupted` and needs a reply. Restarting the server at `roundabout` therefore leaves the ships that were in flight adrift **(call)** — a restart is rare and the conservative reading of "the dispatching process was interrupted" is to let a person look.
- No guard stops a real provider from running unattended before the limiter exists. Slice order (parent §14.1) puts the limiter next; until then the caps and the `manual` default are the protection **(call)**.

## 5. Testing and done-when

- **Decision function:** table tests over database states built with the fake adapter and direct event appends — one case per row of 4.1 at each rung, plus capacity exhaustion, dependency states (unassigned, dropped, adrift, merged), a pending main-tree question, and ordering.
- **Loop, end to end on the fake adapter** (in the suite, so on Linux, Windows and macOS):
  1. `roundabout`, one planet, three moons — A, B depending on A, C independent, with one FIX round scripted on A: all three are settled with no command after the assigns; B's freighter is sent only after A's has docked.
  2. Same planet with a scripted REJECT on C: C is quarantined with a pending decision; the freighters for A and B still dock.
  3. `verdicts`: no freighter is sent by the server; after a human sends one, the moon is settled unattended.
  4. `manual`: no `scheduler.acted` event is ever written.
  5. Rung lowered to `manual` mid-run: the voyage in flight returns; nothing further happens.
  6. Server stopped and started mid-run at `roundabout`: the run continues from the log (work that was between steps carries on; the interrupted voyage is adrift).
  7. Caps: with `max_concurrent_ships: 1`, never more than one voyage in flight.
  8. A repeated refusal parks the moon with `scheduler_refused` and does not loop — once from `gated`, and once for a replied-to `adrift` moon (re-park with a fresh decision).
  9. A planet with a non-empty `depends_on`: the server sends no first freighter at `roundabout`; one sent by hand is accepted and the rest of that moon's steps are automatic.
  10. `verdicts`: a reply to a never-visited adrift moon sends nothing; at `roundabout` a freighter is sent once the moon's dependencies are settled.
  11. The rung set to `manual` by a CLI process while the server runs: the server's next pass plans at `manual`.
- **Command:** `config.automation` accepts the three values, refuses the two later rungs and unknown values, writes atomically, appends `config.changed`.
- **Dependencies:** `launchMoon` refuses a first freighter to a moon with unsettled dependencies at `manual`.

**Done when:** on the fake adapter, the freighters for a three-moon planet with one dependency and one FIX round all dock at the planet with zero commands after the assigns, a REJECT on the same planet holds only its own moon and shows on the Bridge, and the rung can be switched from the page.

## 6. Left to the builder

- Module layout (suggested: `src/server/scheduler/plan.ts` for the function, `src/server/scheduler/loop.ts` for the loop).
- How `availableActions` is reshaped so both the Bridge and `plan` use it.
- How `scheduler.acted` and `config.changed` are registered so that `db rebuild` accepts them without a projection.
- The wording of the confirmation line and of the `waiting on` label.
- Debounce and timer values, within "no tight loop" and "reacts within about a second of an event".
