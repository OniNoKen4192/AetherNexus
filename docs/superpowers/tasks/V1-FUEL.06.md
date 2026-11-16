# TASK: fuel-pool-state-and-limiter

## Meta
- **Task ID**: V1-FUEL.06
- **Parent plan**: docs/superpowers/plans/2026-11-15-v1-fuel.md
- **Depends on**: V1-FUEL.05
- **Estimated scope**: L (two new pure modules plus three small edits; the modules are the task)
- **Model hint**: sol

## Objective
Given the event log and the config, pure functions answer: what state is each provider's pool in, may a ship of this role fly on it now, and which provider (and model) should the next ship use — including falling back to a later provider and to a declared cheaper "refuel" provider. Nothing calls them yet.

## Context
Slice 2 of v1. Vocabulary: a *pool* is a provider's allowance; a ship is *held* when the limiter will not send it (not the same as parked/`adrift`, which needs a person); a freighter is *refuelled* when it flies on the provider and model declared under the held pool's `refuel` key. Readings arrive as `fuel.reading` events and wall hits as `fuel.exhausted` events (both log-only kinds from V1-FUEL.02); a later KEEP task makes the dispatcher write them, so tests here append them directly. Decisions already made, not to be relitigated: readings are reported only, never estimated — a pool nobody has reported on is `unknown` and is **allowed**; `dry` outranks `free`; customs (review) is never held by the reserve floor, only by a dry pool; there is no latch — every choice is computed fresh from the log, nothing is cached in memory; time comes from `g.now()` so tests can move the clock. The same chooser will be used by the commands, the scheduler's planner and the Bridge's reads so that they cannot disagree. Affected workflow IDs is `none` because this project has no review suite.

## Files

### Touch
| Path | Action | Notes |
|------|--------|-------|
| `tests/config/pool-refuel.test.mjs` | create | |
| `tests/server/limiter-pool.test.mjs` | create | |
| `tests/server/limiter-choose.test.mjs` | create | |
| `src/config/schema.ts` | modify | `pool.refuel`: type, validation, `min_wait_minutes` default |
| `src/server/galaxy.ts` | modify | `Galaxy.now` |
| `src/db/statements.ts` | modify | two statements |
| `src/server/limiter/pool.ts` | create | |
| `src/server/limiter/limiter.ts` | create | |

### Do NOT touch
- `src/server/dispatch.ts` — security-routed; import `providerAtCap`, `shipClassFor`, `shipsNoun`, `loadMoon` from it, never edit it
- `src/server/commands/**`, `src/server/scheduler/**`, `src/server/http/**` — the callers are wired in V1-FUEL.09, .10, .12; the two `pickProvider` functions stay as they are in this task
- `src/providers/**` — owned by V1-FUEL.03–.05
- `tests/helpers.mjs`, `tests/fixtures/**` — use them as they are (a test moves the clock by assigning `w.g.now = () => t`)
- `templates/**`, `CLAUDE.md`, `docs/**` — documentation is a later task
- Any file not listed under Touch. If completing the objective seems to require touching an unlisted file, STOP and report BLOCKED.

**Standing exclusions:**
- Security-routed files, never modified by this lane: `src/core/git.ts`, `src/validate/**`, `src/providers/claude-sdk/gate-hook.ts`, `src/server/dispatch.ts`, `src/db/migrations/**`, `src/server/http/auth.ts`, `src/server/lock.ts`
- Pipeline-owned paths: `docs/superpowers/plans/**`, `docs/superpowers/tasks/**`, `.superpowers/sdd/**`
- `package.json`, `package-lock.json` — no dependency changes

## Interfaces

Produced:

```ts
// src/config/schema.ts — ProviderConfig
pool?: { kind: "window" | "daily" | "per-token" | "free"; reserve_floor?: number;
         refuel?: { provider: string; models: Record<string, string>; min_wait_minutes: number } };   // normalizeConfig fills min_wait_minutes with 30 when absent

// src/server/galaxy.ts
export type Galaxy = { /* existing fields */ now: () => number };   // openGalaxy sets () => Date.now()

// src/db/statements.ts
"events.latestByKindProvider": "SELECT * FROM events WHERE kind = @kind AND provider = @provider ORDER BY id DESC LIMIT @limit",
"voyages.returnedByProviderSince": "SELECT model FROM voyages WHERE provider = @provider AND returned_ts > @ts",

// src/server/limiter/pool.ts
export type Reading = { window: string; used: number; resets_at?: string; model_family?: string; ts: string };
export type PoolState =
  | { state: "dry"; until: string }
  | { state: "free" }
  | { state: "low" | "ok"; remaining: number; window: string; resets_at?: string; reading_ts: string }
  | { state: "unknown" };
/** Live readings for the provider, the newest per (window, model_family). */
export function poolReadings(g: Galaxy, provider: string): Reading[];
/** First matching row of: dry, free, low, ok, unknown. With `model`, only readings and exhaustions that apply to that model count. */
export function poolState(g: Galaxy, provider: string, model?: string): PoolState;
/** Append fuel.reading (envelope: scope + provider) unless the newest stored reading for this provider, window and family is within 0.01 of `used` and has the same resets_at. Returns whether it appended. */
export function recordReading(g: Galaxy, scope: Partial<NexusEvent>, provider: string, data: { window: string; used: number; resets_at?: string; model_family?: string }): boolean;

// src/server/limiter/limiter.ts
export type FuelVerdict = { allow: true } | { allow: false; reason: "dry" | "low"; until?: string };
export function fuelCheck(g: Galaxy, role: Role, provider: string, model?: string): FuelVerdict;
/** A planning pass's running view of capacity. Omitted: read from the database. */
export type Capacity = { free: number; providerUse: Map<string, number>; claimed: Set<string> };
export type Choice =
  | { kind: "fly"; provider: string; shipId: string; model?: string;
      reroutedFrom?: { provider: string; reason: "dry" | "low" };
      refuelFor?: { provider: string; reason: "dry" | "low" } }
  | { kind: "held"; provider: string; reason: "dry" | "low"; until?: string; canRefuel?: { provider: string; model: string } }
  | { kind: "none"; message: string };
export function chooseProvider(g: Galaxy, p: { role: Role; tier: string | null; mayRefuel: boolean; requested?: string; override?: boolean; capacity?: Capacity }): Choice;
/** The hold a click on `action` for this moon would meet right now, or null. Never refuels (mayRefuel false), so canRefuel is reported when refuelling is possible. */
export function fuelHold(g: Galaxy, taskId: string, action: "launch" | "inspect"): (Choice & { kind: "held" }) | null;
```

Event payloads read and written (envelope column `provider` is how they are found):

```text
fuel.reading    payload { window, used, resets_at?, model_family?, source: "reported" }
fuel.exhausted  payload { until, voyage_id, model_family? }        (written by a later task; tests append it directly)
```

Consumed (exact current code):

```ts
// src/server/dispatch.ts
export function providerAtCap(g: Galaxy, provider: string): boolean          // per_provider_max, from voyages in flight
export const shipClassFor = (role: Role): ShipClass                          // implement → "freighter", review → "customs"
export const shipsNoun = (cls: ShipClass): string                            // "freighters" | "customs"
export function loadMoon(g: Galaxy, taskId: string): MoonRow                 // MoonRow has tier: string | null
// src/core/fleet.ts
export function pickIdleShip(db: NexusDb, cls: ShipClass, fleet: string): ShipRow | undefined
// src/db/statements.ts: "ships.all" (rows have id, fleet, class, status), "voyages.inFlight" (rows have provider)
// src/db/events.ts
export function append(db: NexusDb, ev: NexusEvent, precheck?: () => void): EventRow     // ev.ts may be given; default is the real clock
export function rowToEvent(r: Row): EventRow
// config: g.config.providers[id].pool, g.config.roles.implement / .review (ordered provider ids), g.config.scheduler.per_provider_max, g.adapters[id]
// Today's refusal wording, which `none.message` must reproduce exactly:
//   `no provider is configured for the ${role} role`
//   `provider '${id}' is not configured`
//   `provider '${id}' is at its limit of ${max} (scheduler.per_provider_max)`
//   `all ${shipsNoun(cls)} in fleet '${id}' are assigned`
```

## Constraints

**Pool state (`poolState`), first match wins:**
1. `dry` — the pool is *exhausted*: the newest `fuel.exhausted` for the provider that applies to `model` has `until` later than `g.now()`, **and** no voyage on that provider has `returned_ts` later than that event's `ts` (when the exhaustion carries a `model_family`, only a returned voyage whose `model` belongs to that family clears it). `until` is the event's.
2. `free` — the provider has no `pool` block, or `pool.kind` is `"free"`.
3. `low` — the *tightest* live reading that applies has `1 - used` strictly below `pool.reserve_floor` (absent floor = 0, so never low).
4. `ok` — there is a live reading that applies.
5. `unknown`.
- A reading or exhaustion with `model_family` applies only when `model` is given and the family name occurs in the model id, case-insensitively; one without a family applies to every model; with no `model` argument everything applies.
- A reading is *live* when its `resets_at` is later than `g.now()`, or it has no `resets_at` and its `ts` is within 24 hours of `g.now()`. Only the newest reading per (window, model_family) counts — an older one for the same window is superseded even if it is higher.
- *Tightest* = highest `used`. `remaining = 1 - used`.
- A stored reading whose `used` is not a finite number in 0..1 is ignored (it never yields `NaN`). An `until` or `resets_at` that does not parse as a date is treated as absent (an exhaustion without a usable `until` is not an exhaustion).
- Read at most a bounded number of recent events per kind and provider (`@limit` of 200 is plenty); do not scan the whole log.

**Fuel check (`fuelCheck`), in order:** `dry` → hold `{ reason: "dry", until }` for every role · `free` → allow · role `review` → allow · role `implement` and `low` → hold `{ reason: "low", until: resets_at }` · otherwise allow.

**Provider choice (`chooseProvider`):**
- The *order* is `[requested]` when `requested` is given, else `roles[role]`. Empty order → `none` (`no provider is configured for the <role> role`).
- A provider is *available* when it has an adapter, is under `per_provider_max`, and has an idle ship of the role's class that is not claimed. Without `capacity`, use `providerAtCap` and `pickIdleShip`; with `capacity`, use its `providerUse` counts against `per_provider_max`, and the first idle unclaimed ship from `ships.all`. With `capacity.free <= 0` → `none` (message `the concurrency limit is reached`).
- `override: true` → the first available provider in the order flies, fuel not consulted, no `reroutedFrom`.
- Otherwise walk the order. An unavailable provider is skipped silently. An available one that fails `fuelCheck` (asked with no model) is *skipped for fuel*. The first that passes → `fly` with `model` absent, and `reroutedFrom` naming the **first** provider skipped for fuel, if there was one.
- Nothing flew and nothing was skipped for fuel → `none`, message as today's code would give for the first provider in the order (not configured / at its limit / all ships assigned — in that precedence).
- Nothing flew and at least one was skipped for fuel → let *held* be the first such provider. For role `implement`, test the refuel conditions below; all hold and `mayRefuel` → `fly` on the refuel provider with the mapped `model` and `refuelFor { provider: held, reason }`; all hold and not `mayRefuel` → `held` with `canRefuel { provider, model }`; otherwise `held`. For role `review` → `held`. `held.until` is the verdict's.
- **Refuel conditions (all five):** the held provider's pool declares `refuel`; `tier` is non-null and has an entry in `refuel.models`; `fuelCheck(g, "implement", refuel.provider, mappedModel)` allows; the held verdict's `until` is absent/unparseable or more than `min_wait_minutes` after `g.now()`; the refuel provider is available.
- On every `fly`, when `capacity` was given it is updated: `free--`, `providerUse` for the chosen provider `+1`, the ship id added to `claimed`.
- `chooseProvider` and `fuelHold` append nothing and change nothing in the database.

**`fuelHold`:** role is `implement` for `"launch"`, `review` for `"inspect"`; tier is the moon's; `mayRefuel: false`, no capacity. Returns the choice when it is `held`, else null. An unknown task id → null (it must not throw into a read).

**Config validation (`pool.refuel`), each a refusal at load with the key path in the message (follow the existing style, e.g. `'providers.codex.pool.refuel.provider' must name a configured provider other than 'codex'`):** `refuel` must be an object; unknown keys refuse; `provider` is a string naming a key of `providers` other than the declaring one; `models` is a non-empty object whose values are non-empty strings; `min_wait_minutes`, when present, is an integer ≥ 0. `pool`'s own unknown-key check must now accept `refuel`. `DEFAULT_CONFIG` declares no `refuel`.

**General:** no new dependencies; SQL only in `src/db/statements.ts`; no `Date.now()` in the two limiter modules — time is `g.now()`; tests import from `dist/` and build worlds with `makeGalaxy` / `worldWithMoon`, patching the config for pools, fleets and roles (a second provider with `adapter: "fake"` gives a second fleet — see how `tests/server/scheduler-plan.test.mjs` sets up providers and fleets).

## Acceptance

**Test command (must exit 0):**
```bash
npm test -- "tests/config/*.test.mjs" "tests/server/limiter-*.test.mjs" "tests/db/*.test.mjs"
```

**Behavioral criteria** (each covered by a named test in the new files):

Pool state and readings (`limiter-pool.test.mjs`)
1. No events: a provider with a `window` pool is `unknown`; one with no pool block is `free`; one with `kind: "free"` is `free`.
2. A reading `used: 0.95` with floor 0.1 → `low`, `remaining` 0.05 (within 1e-9), with `window`, `resets_at`, `reading_ts`; `used: 0.2` → `ok`; `used: 0.9` exactly at floor 0.1 → `ok` (not below).
3. Two windows live, 0.3 and 0.8 → the state reports the 0.8 one. A newer reading 0.1 for the 0.8 window supersedes it → the 0.3 one is reported.
4. A reading whose `resets_at` has passed is not live; one without `resets_at` is live at 23 h and not at 25 h (move `g.now`).
5. A live `fuel.exhausted` → `dry` with its `until`; after `until` passes → not dry. A provider with **no pool block** and a live exhaustion is `dry`, not `free`.
6. A voyage on the provider returned after the exhaustion → not dry; one returned before it → still dry; one on another provider → still dry.
7. Families: an Opus-family reading at 0.99 with floor 0.25 → `poolState(g, p, "claude-haiku-5-5")` is not `low`; `poolState(g, p, "claude-opus-5-5")` is `low`; `poolState(g, p)` (no model) is `low`. The same three for an Opus-family exhaustion and `dry`.
8. Stored readings with `used` of `NaN` (stored as null), `7`, `-1`, `"x"` are ignored: state `unknown`, and `poolReadings` returns none of them.
9. `recordReading` appends the first reading and returns true; an identical one returns false and appends nothing; `used` differing by 0.005 → false; by 0.02 → true; a changed `resets_at` → true; another window or family → true. The appended event has kind `fuel.reading`, the provider in the envelope and `source: "reported"`.

Fuel check and choice (`limiter-choose.test.mjs`)
10. `fuelCheck`: `dry` holds implement and review; `low` holds implement and allows review; `ok`, `unknown`, `free` allow both.
11. One provider, `ok` → `fly` with that provider, an idle ship's id, no `reroutedFrom`.
12. First provider `low`, second `ok` → `fly` on the second with `reroutedFrom { provider: first, reason: "low" }`. For review with the first `low` → `fly` on the first.
13. First provider with every freighter assigned and `ok` fuel, second `ok` → `fly` on the second **without** `reroutedFrom` (not a fuel skip).
14. Only provider `low`, no refuel declared → `held { provider, reason: "low", until }`. Only provider `dry` → `held` with reason `dry` for both roles.
15. `none` messages: empty role order; first provider not configured; at `per_provider_max`; all ships assigned — each exactly as listed under Interfaces.
16. `requested` naming the second provider flies it even when the first is fine; `requested` naming a held provider → `held`.
17. `override` on a `dry` provider → `fly` on it, no `reroutedFrom`.
18. Refuel declared and all five conditions true: `mayRefuel: true` → `fly` on the refuel provider, `model` the mapped one, `refuelFor { provider: held, reason }`; `mayRefuel: false` → `held` with `canRefuel { provider, model }`.
19. Each refuel condition failing alone → `held` **without** `canRefuel`: no `refuel` key; tier null; tier not in `models`; refuel provider `low` for the mapped model; refuel provider `dry`; reset within `min_wait_minutes`; refuel provider has no idle freighter; refuel provider at its cap. And one positive edge: `until` unknown → refuel allowed; refuel provider `unknown` → allowed.
20. A family reading on the refuel provider that does not apply to the mapped model does not block the refuel (Opus window full, mapped model Haiku).
21. `capacity`: three `fly` choices in a row with `free: 2` → the third is `none`; ships are never repeated; `providerUse` reaches the provider's cap and the next choice goes to the second provider.
22. `chooseProvider` and `fuelHold` leave `events.maxId` unchanged. `fuelHold` returns the held choice for a moon whose next freighter would be held, null when it would fly, null for an unknown task id.

Config (`pool-refuel.test.mjs`)
23. A valid `refuel` loads and `min_wait_minutes` is 30 when absent and kept when given (including 0).
24. Each of these refuses with the key path in the message: unknown provider; the declaring provider itself; empty `models`; a non-string model; `min_wait_minutes` of `-1`, `1.5`, `"30"`; an unknown key under `refuel`; `refuel` not an object. A pool with `refuel` and no unknown keys is accepted (the pool's own unknown-key check does not reject `refuel`).
25. `DEFAULT_CONFIG` declares no `refuel` and still normalizes.

**Affected workflow IDs**: none

**Regression guard (task level — implementer runs this):**
```bash
npm test
```

## Out of Scope
- Do not call these functions from commands, the scheduler or the reads; do not delete `pickProvider`.
- Do not write `fuel.exhausted`, `limiter.held`, `limiter.rerouted` or `limiter.refuelled` anywhere (later tasks).
- No estimation of fuel from token counts or call counts.
- Do not update documentation or config templates. Do not fix unrelated failing tests — report them instead.

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
