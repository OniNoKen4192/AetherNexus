# TASK: fuel-reads

## Meta
- **Task ID**: V1-FUEL.12
- **Parent plan**: docs/superpowers/plans/2026-11-15-v1-fuel.md
- **Depends on**: V1-FUEL.11
- **Estimated scope**: M
- **Model hint**: terra

## Objective
The snapshot and the moon detail say how much fuel each provider's pool has, which moons are waiting on fuel and why, which of them could be refuelled, and which voyages flew as a refuel — so the Bridge can show all of it without asking anything else.

## Context
Slice 2 of v1. The limiter (`src/server/limiter/`) already decides everything; this task only exposes its answers in the two reads the Bridge page uses. Nothing here decides or writes: both reads must stay free of appends. The page itself changes in later tasks (V1-FUEL.14, .15), so `web/**` is not touched. Wording rule for comments and test names: a *ship* runs out of fuel or hits the wall, a moon never does; a moon *waits on fuel*; its *cargo awaits pickup*; `adrift` means only "needs a person". Affected workflow IDs is `none` because this project has no review suite.

## Files

### Touch
| Path | Action | Notes |
|------|--------|-------|
| `tests/server/query-fuel.test.mjs` | create | criteria 1–12 |
| `tests/http/reads.test.mjs` | modify | add criteria 13–14; existing tests stay byte-identical |
| `src/server/commands/query.ts` | modify | `Snapshot`, `MoonDetail`, `snapshot`, `moonDetail`, the voyage-row helper |

### Do NOT touch
- `src/server/limiter/**` — owned by V1-FUEL.06 and .07; import from it
- `src/server/commands/launch.ts`, `review.ts`, `park.ts` — owned by V1-FUEL.09 and .19
- `src/server/scheduler/**` — owned by V1-FUEL.10 and .11
- `src/server/http/**`, `web/**` — the routes already serialise whatever the reads return; the page is V1-FUEL.14 and .15
- In `query.ts`: `availableActions`, `status`, `events`, `fleet` keep their behaviour.
- Any file not listed under Touch. If completing the objective seems to require touching an unlisted file, STOP and report BLOCKED.

**Standing exclusions:**
- Security-routed files, never modified by this lane: `src/core/git.ts`, `src/validate/**`, `src/providers/claude-sdk/gate-hook.ts`, `src/server/dispatch.ts`, `src/db/migrations/**`, `src/server/http/auth.ts`, `src/server/lock.ts`
- Pipeline-owned paths: `docs/superpowers/plans/**`, `docs/superpowers/tasks/**`, `.superpowers/sdd/**`
- `package.json`, `package-lock.json` — no dependency changes

## Interfaces

Produced:

```ts
// src/server/commands/query.ts
export type PoolView = {
  provider: string;
  kind: string;                                   // providers[p].pool.kind, or "free" when the provider has no pool block
  state: "dry" | "free" | "low" | "ok" | "unknown";
  remaining?: number; resets_at?: string; until?: string; reading_ts?: string;   // copied from poolState when it has them
  reserve_floor: number;                          // providers[p].pool.reserve_floor, or 0 when absent
  refuel?: { provider: string; models: Record<string, string> };                 // only when pool.refuel is declared
  windows: { window: string; used: number; resets_at?: string; model_family?: string; ts: string }[];   // poolReadings(g, p)
};
export type FuelWait = { provider: string; reason: string; until?: string };
export type RefuelOffer = { provider: string; model: string };

export type Snapshot = { /* everything it has today */ pools: PoolView[];
  voyages: (Row & { owner: Owner | null; refuel_for: string | null })[] };
export type MoonDetail = { /* everything it has today */
  voyages: (Row & { owner: Owner | null; refuel_for: string | null })[] };
// Every ASSIGNED moon row in Snapshot.systems[].planets[].moons[] and MoonDetail.moon gains:
//   waiting_on_fuel: FuelWait | null;   can_refuel: RefuelOffer | null;
```

Consumed (exact current code):

```ts
// src/server/limiter/pool.ts
export type Reading = { window: string; used: number; resets_at?: string; model_family?: string; ts: string };
export type PoolState =
  | { state: "dry"; until: string }
  | { state: "free" }
  | { state: "low" | "ok"; remaining: number; window: string; resets_at?: string; reading_ts: string }
  | { state: "unknown" };
export function poolReadings(g: Galaxy, provider: string): Reading[]
export function poolState(g: Galaxy, provider: string, model?: string): PoolState
// src/server/limiter/limiter.ts
export function fuelHold(g: Galaxy, taskId: string, action: "launch" | "inspect"): (Choice & { kind: "held" }) | null
//   a held Choice: { kind: "held"; provider: string; reason: string; until?: string; canRefuel?: { provider: string; model: string } }
// src/config/schema.ts — providers[id].pool?: { kind; reserve_floor?; refuel?: { provider: string; models: Record<string, string>; min_wait_minutes: number } }
// src/server/commands/query.ts
type OwnerCtx = { ownPid: number; tracks?: (voyageId: string) => boolean };
function voyageOwner(g: Galaxy, voyage: Row, ctx: OwnerCtx): Owner | null     // finds the voyage's voyage.launched event in events.byAssignment
export function availableActions(g: Galaxy, taskId: string, ctx: OwnerCtx): Action[]
export function snapshot(g: Galaxy, ctx: OwnerCtx & { failures: Failure[]; readyToSend?: number }): Snapshot
export function moonDetail(g: Galaxy, taskId: string, ctx: OwnerCtx): MoonDetail
// src/server/dispatch.ts — the voyage.launched payload carries refuel_for: string only when the voyage flew as a refuel
```

## Constraints
- **Pools.** One `PoolView` per provider named in `roles.implement` and then `roles.review`, in that order, each provider once. `state` and the optional fields come from `poolState(g, provider)` (no model). `window` from `poolState` is not copied (the `windows` list carries it). Optional keys are absent, not `undefined` or `null`, when there is nothing to say. `refuel` carries `provider` and `models` only — not `min_wait_minutes`.
- **Waiting on fuel.** For an assigned moon, take `availableActions(g, taskId, ctx)`: if it includes `launch`, ask `fuelHold(g, taskId, "launch")`; else if it includes `inspect`, ask `fuelHold(g, taskId, "inspect")`; else both fields are `null`. When `fuelHold` returns a hold: `waiting_on_fuel` is `{ provider, reason }` plus `until` when the hold has one, and `can_refuel` is the hold's `canRefuel` or `null`. When it returns `null`, both are `null`. A barren (unassigned) moon row gains neither key.
- **Refuel mark.** `refuel_for` is the string from the voyage's `voyage.launched` payload, or `null`. The voyage's launch event is looked up once per voyage, shared with the owner lookup; the events of an assignment are read once per assignment, not once per voyage. `owner` keeps exactly today's values.
- **Reads write nothing.** `events.maxId` is the same before and after `snapshot` and `moonDetail`, whatever the pools look like.
- Every existing key of both reads keeps its value. No new dependencies. Tests import from `dist/`.
- In tests: "low" is a `fuel.reading` event for the provider with `used: 0.95` and a `resets_at` an hour ahead; "ok" is `used: 0.2`; "dry" is a `fuel.exhausted` event whose `until` is an hour ahead (append it without a `ts`). A pool block is `{ kind: "window", reserve_floor: 0.1 }`. Unless a criterion says otherwise, `c.roles = { implement: ["fake"], review: ["fake"] }` — the default test world lists other providers first, and a low pool would be routed around.
- Each test's name in `query-fuel.test.mjs` starts with its criterion number (`1.` … `12.`); the two added to `reads.test.mjs` start with `fuel:`.

## Acceptance

**Test command (must exit 0):**
```bash
npm test -- "tests/http/reads.test.mjs" "tests/server/query-fuel.test.mjs"
```

**Behavioral criteria** (each a named test):
1. **Order.** Roles `implement: ["codex", "fake"]`, `review: ["claude", "fake"]` → `snapshot(...).pools.map(p => p.provider)` is `["codex", "fake", "claude"]`.
2. **No pool block.** A provider with no `pool` block: `kind` `"free"`, `state` `"free"`, `reserve_floor` 0, `windows` `[]`, and no `remaining`, `resets_at`, `until`, `reading_ts` or `refuel` key. The same provider with a live exhaustion: `state` `"dry"` and `until` equal to the event's.
3. **Unknown.** A pool block and no fuel events: `kind` `"window"`, `state` `"unknown"`, `reserve_floor` 0.1, `windows` `[]`.
4. **Ok and low.** One reading at 0.2: `state` `"ok"`, `remaining` within 1e-9 of 0.8, `resets_at` and `reading_ts` set, `windows` has that one reading with its `window`, `used`, `resets_at` and `ts`. A later reading at 0.95 in the same window: `state` `"low"`, `remaining` within 1e-9 of 0.05.
5. **Dry.** A reading at 0.2 and a live exhaustion: `state` `"dry"`, `until` the event's, no `remaining` key, and `windows` still lists the reading.
6. **Refuel declared.** `pool.refuel = { provider: "probe", models: { terra: "m-cheap" }, min_wait_minutes: 30 }` → the pool's `refuel` deep-equals `{ provider: "probe", models: { terra: "m-cheap" } }`.
7. **A moon waiting on fuel.** `fake` low, an `emitted` moon: its row in the snapshot and `moonDetail(...).moon` both carry `waiting_on_fuel` deep-equal to `{ provider: "fake", reason: "low", until: <the reading's resets_at> }` and `can_refuel` `null`.
8. **A refuel on offer.** As 7 with refuel declared (`probe: { adapter: "fake", pool: { kind: "window", reserve_floor: 0.1 } }`, `min_wait_minutes: 0`, a spec whose Model hint tier is the key in `models`), level `manual`: `can_refuel` deep-equals `{ provider: "probe", model: "m-cheap" }` and `waiting_on_fuel` is as in 7.
9. **Customs.** An `audited` moon awaiting inspection: with `fake` low both fields are `null` (a low pool does not hold customs); with `fake` dry, `waiting_on_fuel` deep-equals `{ provider: "fake", reason: "dry", until: <the exhaustion's until> }` and `can_refuel` is `null`.
10. **Nothing to send.** A `merged` moon, and a moon that is `adrift` with no reply, each carry `waiting_on_fuel: null` and `can_refuel: null` even with `fake` dry. A barren moon row has neither key.
11. **Cargo awaiting pickup.** After a `wall` launch (the moon is `awaiting_pickup`, the pool dry): `waiting_on_fuel.reason` is `"dry"` and its `until` equals the `fuel.exhausted` event's `until`.
12. **Refuel mark.** A freighter launched with `refuel: true` under the setup of 8 has `refuel_for` `"fake"` in `snapshot(...).voyages` and in `moonDetail(...).voyages`; a plain voyage has `refuel_for` `null` in both; every voyage's `owner` equals what it is at the base commit for the same state (assert `null` for a returned voyage).
13. **fuel: over HTTP.** `GET /api/snapshot` carries `pools` (an array with one entry per provider in the roles) and every assigned moon row carries both new keys; `GET /api/moons/T1` carries `moon.waiting_on_fuel` and `moon.can_refuel`; with `fake` low the two reads agree with criterion 7.
14. **fuel: reads append nothing.** With a low reading and a live exhaustion in the log, `events.maxId` is unchanged across `GET /api/snapshot` and `GET /api/moons/T1`.

**Affected workflow IDs**: none

**Regression guard (task level — implementer runs this):**
```bash
npm test
```

## Out of Scope
- Do not change `web/**` or its types; do not add labels for park reasons (V1-FUEL.14, .15).
- Do not change what the limiter decides, and do not cache its answers.
- Do not add an HTTP route or change a route's shape.
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
