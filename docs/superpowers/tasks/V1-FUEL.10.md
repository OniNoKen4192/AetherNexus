# TASK: fuel-scheduler-plan-uses-the-limiter

## Meta
- **Task ID**: V1-FUEL.10
- **Parent plan**: docs/superpowers/plans/2026-11-15-v1-fuel.md
- **Depends on**: V1-FUEL.09
- **Estimated scope**: M
- **Model hint**: sol

## Objective
The scheduler's decision function asks the limiter which provider each freighter and customs ship would fly on: a ship the limiter holds is not planned and is reported as a hold instead, a rerouted or refuelled one is planned and says so, and a moon whose cargo awaits pickup is planned for its next freighter.

## Context
Slice 2 of v1. `plan()` is the pure half of the scheduler: it reads the galaxy and returns what should be done next; `loop.ts` (a later KEEP task) acts on it. Today `plan()` walks the role's providers itself, looking only at capacity and idle ships. `chooseProvider` (V1-FUEL.06) now does that walk and also knows about fuel, so the walk in `plan()` is replaced by it. A hold is information, not an action: the loop will record it once so the Bridge can show "waiting on fuel", and it must never be mistaken for a failed action. `plan()` stays pure — it appends nothing. Existing tests compare planned actions with `deepEqual` against `{ action, taskId, first }`, so a plain flight must keep exactly that shape; only a rerouted or refuelled flight carries extra keys. Wording rule for comments and test names: a *ship* is held or runs out of fuel; a moon never does; the moon's *cargo awaits pickup*. Affected workflow IDs is `none` because this project has no review suite.

## Files

### Touch
| Path | Action | Notes |
|------|--------|-------|
| `tests/server/scheduler-plan.test.mjs` | modify | add the tests below; every existing test stays unchanged and passing |
| `src/server/scheduler/plan.ts` | modify | |

### Do NOT touch
- `src/server/scheduler/loop.ts`, `tests/server/scheduler-loop.test.mjs` — owned by V1-FUEL.11 (the loop keeps calling `plan()`, whose signature does not change)
- `src/server/limiter/**` — owned by V1-FUEL.06 and .07; import `chooseProvider` and `Capacity`
- `src/server/commands/**` — owned by V1-FUEL.09 and .12
- `src/server/dispatch.ts` — security-routed
- Any file not listed under Touch. If completing the objective seems to require touching an unlisted file, STOP and report BLOCKED.

**Standing exclusions:**
- Security-routed files, never modified by this lane: `src/core/git.ts`, `src/validate/**`, `src/providers/claude-sdk/gate-hook.ts`, `src/server/dispatch.ts`, `src/db/migrations/**`, `src/server/http/auth.ts`, `src/server/lock.ts`
- Pipeline-owned paths: `docs/superpowers/plans/**`, `docs/superpowers/tasks/**`, `.superpowers/sdd/**`
- `package.json`, `package-lock.json` — no dependency changes

## Interfaces

Produced:

```ts
// src/server/scheduler/plan.ts
export type PlannedAction = {
  action: "dock" | "park_stale" | "inspect" | "launch";
  taskId: string;
  /** true when this would be the first freighter sent to the moon under its current assignment */
  first: boolean;
  /** Present only when the limiter sent the ship somewhere other than a plain flight: a reroute or a refuel. */
  provider?: string;
  /** Present only on a refuel: the cheaper model the freighter flies. */
  model?: string;
  /** Present (true) only on a refuel. */
  refuel?: true;
};
export type Hold = { taskId: string; role: Role; provider: string; reason: "dry" | "low"; until?: string };
export function planWithHolds(g: Galaxy, ctx: PlanCtx): { actions: PlannedAction[]; holds: Hold[] };
export function plan(g: Galaxy, ctx: PlanCtx): PlannedAction[];   // exactly planWithHolds(g, ctx).actions
// Rung, effectiveRung, PlanCtx: unchanged.
```

Consumed (exact current code):

```ts
// src/server/limiter/limiter.ts
export type Capacity = { free: number; providerUse: Map<string, number>; claimed: Set<string> };
export type Choice =
  | { kind: "fly"; provider: string; shipId: string; model?: string; reroutedFrom?: { provider: string; reason: "dry" | "low" }; refuelFor?: { provider: string; reason: "dry" | "low" } }
  | { kind: "held"; provider: string; reason: "dry" | "low"; until?: string; canRefuel?: { provider: string; model: string } }
  | { kind: "none"; message: string };
export function chooseProvider(g: Galaxy, p: { role: Role; tier: string | null; mayRefuel: boolean; requested?: string; override?: boolean; capacity?: Capacity }): Choice;
// With a capacity argument chooseProvider does the bookkeeping itself: on `fly` it decrements capacity.free,
// counts the provider in capacity.providerUse and adds the ship to capacity.claimed; it returns
// { kind: "none", message: "the concurrency limit is reached" } when capacity.free <= 0.

// src/server/scheduler/plan.ts today — the tail of plan(), which this task replaces:
//   const inFlight = g.db.all<{ provider: string }>("voyages.inFlight");
//   let free = g.config.scheduler.max_concurrent_ships - inFlight.length;
//   const providerUse = new Map<string, number>();  for (const voyage of inFlight) providerUse.set(…);
//   const ships = g.db.all<ShipRow>("ships.all");  const claimed = new Set<string>();
//   for (const candidate of candidates) { dock / park_stale → pushed as they are; launch / inspect → walk providers, take a ship }
// and the candidate rules above it, where a moon's `launch` action becomes a candidate for status audited,
// adrift / quarantined (after a reply) and emitted / gated (roundabout, dependencies settled).

// src/server/commands/query.ts (after V1-FUEL.09): availableActions returns ["launch", "drop"] for an awaiting_pickup moon.
// src/server/dispatch.ts: loadMoon(g, taskId) → MoonRow { status, tier: string | null, assignment_id, … }
```

## Constraints
- **Candidates.** One addition: a moon that is `awaiting_pickup` with `launch` available is a launch candidate at `verdicts` and `roundabout`, with `first: false` (it sorts with the other later-visit freighters; its dependencies are not consulted — it has been visited). Every other candidate rule and the sort order are unchanged.
- **Choosing.** One `Capacity` is built per call from the galaxy as the current tail does (`free` = `max_concurrent_ships` − voyages in flight; `providerUse` from the voyages in flight; `claimed` empty) and shared by every candidate in that call. For each `launch` or `inspect` candidate, in order, call `chooseProvider` with `role` (`implement` for launch, `review` for inspect), `tier` = the moon's tier, `mayRefuel: true`, that capacity, and no `requested` or `override`:
  - `fly` → push the action. A plain flight (neither `reroutedFrom` nor `refuelFor`) is exactly `{ action, taskId, first }`. A reroute adds `provider`. A refuel adds `provider`, `model` and `refuel: true`.
  - `held` → push a `Hold` `{ taskId, role, provider, reason }` plus `until` when the choice has one; no action. (`canRefuel` cannot occur here because `mayRefuel` is true; ignore it if present.)
  - `none` → neither an action nor a hold.
  - Do not keep a second copy of the capacity arithmetic: `chooseProvider` owns it. `dock` and `park_stale` candidates are pushed as they are and never touch capacity or fuel.
- **Order.** `actions` keeps the candidates' order, as today. `holds` is in the candidates' order too.
- **Manual.** At rung `manual`: `{ actions: [], holds: [] }`.
- **Purity.** Neither function appends an event or writes anything; `events.maxId` is the same before and after.
- No new dependencies. Tests import from `dist/`. Build worlds with the file's existing helpers (`world`, `withWorld`, `patchConfig`, `ctx`, `action`); extend `patchConfig`'s options if a test needs a pool, a second provider or a refuel declaration, without changing what it produces for existing callers. A pool is made low with a `fuel.reading` event (or `recordReading` from `dist/server/limiter/pool.js`), dry with a `fuel.exhausted` event whose `until` is in the future; see `tests/server/limiter-choose.test.mjs` for both, and for adding a second provider `probe: { adapter: "fake", pool: … }`.

## Acceptance

**Test command (must exit 0):**
```bash
npm test -- "tests/server/scheduler-plan.test.mjs"
```

**Behavioral criteria** (each a named test added to `tests/server/scheduler-plan.test.mjs`; "low" = pool `{ kind: "window", reserve_floor: 0.1 }` with a live reading of 0.95 whose `resets_at` is `R`; "dry" = a live `fuel.exhausted` with `until` `U`; expected values are literals written in the test):
1. `plan` is `planWithHolds(...).actions`: in a world with one first freighter to send at roundabout, both give `[{ action: "launch", taskId: "T1", first: true }]` and `holds` is `[]`.
2. A low pool holds the first freighter at roundabout: `actions` is `[]` and `holds` deep-equals `[{ taskId: "T1", role: "implement", provider: "fake", reason: "low", until: R }]`.
3. A low pool does not hold customs: with a holding freighter to inspect, `actions` is `[{ action: "inspect", taskId: "T1", first: false }]` and `holds` is `[]` (at `verdicts` and at `roundabout`).
4. A dry pool holds customs too: the same world with the pool dry → `actions` `[]`, `holds` `[{ taskId: "T1", role: "review", provider: "fake", reason: "dry", until: U }]`.
5. A dry pool holds a later-visit freighter (a moon reopened by a FIX verdict) at `verdicts`: one hold with `role: "implement"`, `reason: "dry"`.
6. Reroute: implement order `["fake", "probe"]`, `fake` low, `probe` with no readings: `actions` deep-equals `[{ action: "launch", taskId: "T1", first: true, provider: "probe" }]`, `holds` `[]`.
7. Refuel: order `["fake"]`, `fake` low with `refuel: { provider: "probe", models: { <the moon's tier>: "m-cheap" }, min_wait_minutes: 0 }`: `actions` deep-equals `[{ action: "launch", taskId: "T1", first: true, provider: "probe", model: "m-cheap", refuel: true }]`, `holds` `[]`. With `min_wait_minutes` larger than the time to `R`: no action and one hold on `fake` (which has no `canRefuel` key).
8. Capacity holds across reroutes: two moons with first freighters, `fake` low, `probe` fine with `per_provider_max.probe = 1`: exactly one action (rerouted to `probe`, for the earlier assignment) and one hold (the other moon, on `fake`). With `max_concurrent_ships` 1 and both pools fine: one plain action, no hold.
9. Two freighters planned on one fleet in one call take different ships: two moons, two freighters, pools fine → two actions; with one freighter in the fleet → one action and no hold.
10. Docking and parking a stale voyage ignore fuel: with the pool dry, an approved freighter still plans `dock` and a stale voyage still plans `park_stale`, and neither produces a hold.
11. Cargo awaiting pickup is planned once the pool is back: a moon left `awaiting_pickup` by a wall hit (script `wall` through `launchMoon` at `manual`, then the level raised, or by appending the events). While the exhaustion is live: `actions` `[]` and one hold with `reason: "dry"`. With `g.now` moved past `until` (`w.g.now = () => Date.now() + 10 * 60_000`): `actions` deep-equals `[{ action: "launch", taskId: "T1", first: false }]` at `verdicts` and at `roundabout`, `holds` `[]`. At `manual`: `{ actions: [], holds: [] }` in both states.
12. A busy task produces neither an action nor a hold (low pool, `busy: new Set(["T1"])`).
13. `planWithHolds` writes nothing: `events.maxId` is equal before and after a call that returns actions and after one that returns holds.
14. Every test that existed before this task still passes with no edit to its body.

**Affected workflow IDs**: none

**Regression guard (task level — implementer runs this):**
```bash
npm test
```

## Out of Scope
- Do not append `limiter.held` or any event (V1-FUEL.11 does, in the loop).
- Do not change `loop.ts`, how actions are executed, or what `launchMoon` / `inspectMoon` do with a planned action.
- Do not change `chooseProvider`, `availableActions` or the candidate rules other than the `awaiting_pickup` addition.
- Do not update documentation. Do not fix unrelated failing tests — report them instead (known flake: `tests/server/follow.test.mjs` under load).

## Report Format
Return exactly this structure:

```
STATUS: IMPLEMENTED | IMPLEMENTED_WITH_DEVIATIONS | BLOCKED | BACKEND_FAILURE | RATE_LIMITED
FILES_CHANGED: <list with one-line summary each>
TEST_OUTPUT: <last 20 lines of the acceptance command>
DEVIATIONS: <anything done differently than specified, and why — or "none".
  IMPLEMENTED requires "none"; IMPLEMENTED_WITH_DEVIATIONS requires a
  non-empty list>
BLOCKED_REASON: <only if BLOCKED: what was needed that the spec didn't provide>
```
