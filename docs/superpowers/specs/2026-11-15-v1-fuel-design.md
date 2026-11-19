# v1 slice 2 — fuel readings, the limiter and refuelling (design)

**Status:** draft, 2026-11-15
**Parent:** `docs/2026-10-10-aether-nexus-design.md` §3.2, §8, §14.1 (slice 2 of v1)
**Builds on:** `docs/superpowers/specs/2026-11-14-v1-scheduler-design.md`

Marking used below: **(owner)** = decided by the owner in conversation; **(call)** = the designer's choice, open to correction.

---

## 1. Intent

The owner's principle, carried from slice 1 **(owner)**: *the whole system should just run, unless something rises to the level of human attention.*

Since slice 1 the server sends freighters and customs by itself, and nothing stops it spending a provider's pool to the last drop. As of today:

- every adapter's `fuel()` returns `unknown`; `pool.kind` and `pool.reserve_floor` are accepted in config and read by nothing;
- a voyage that hits a provider's rate limit parks the moon, and the moon stays parked until a person replies, even after the pool has refilled;
- the page shows nothing about fuel.

This slice makes the server know how much fuel each provider has left where the provider says so, keep a reserve, wait out an empty pool by itself, and, where the owner has declared it, **refuel**: fly the freighter on a cheaper Claude model instead of waiting.

**Wording.** Places don't move; ships do. A **pool** is a provider's allowance. A ship is **held** when the limiter will not send it yet; a hold is not a park and opens no decision. A moon is **waiting on fuel** when the ship it needs is held. A freighter is **refuelled** when it flies on the refuel provider because its own pool is low or dry.

A moon is a place and is always there **(owner)**. The work is **cargo** at the moon (slice 1 already has customs inspecting "the freighter's cargo"). When a freighter runs out of fuel mid-voyage, the part-finished cargo stays at the moon **awaiting pickup** by the next freighter. Nothing in this slice describes a moon as being dropped, created or removed; the existing command name `moon.drop` means "cancel the delivery" and its rename is a separate cleanup, like `moon.launch`.

## 2. Goals, non-goals, anti-goals

**Goals**
1. A real reading per provider wherever the provider reports one (Claude and Codex both do, §4.1), stored in the event log, shown on the Bridge with its age.
2. A freighter is not sent on a pool below its `reserve_floor`. Customs is never held by the floor.
3. A voyage that hits the wall mid-run leaves its moon **waiting on fuel**, not parked; from `verdicts` up the server sends the ship again after the reset **(owner)**.
4. Refuelling **(owner)**: when declared in config and appropriate (§4.5), the freighter flies on Claude at a cheaper model mapped from the moon's tier — by itself from `verdicts` up, by a button at `manual`.
5. Everything above is provable on the fake adapter, so the suite spends nothing.

**Non-goals**
- Estimating fuel for a provider that does not report it **(owner)**. Such a pool reads `unknown`, is never held by the floor, and is still held after it hits the wall.
- Behaviour for `daily` and `per-token` pools. They stay valid config; this slice treats them like `window` (a reading and a reset time, if any arrive) **(call)**.
- Idle housekeeping (parent §8 rule 4), gravity-aware routing, editing floors or the refuel mapping from the Bridge.
- The 3D fuel gauge (parent §11). The gauge here is on the Bridge page.

**Anti-goals** — the slice has failed if any of these can happen:
- A freighter is sent on Claude without a declared refuel mapping, unless Claude is in `roles.implement` (which is already the owner's consent to use it for freighters).
- Refuelling takes Claude below its own reserve floor when its reading is known.
- A moon stops with no visible reason: every hold shows what it is waiting on and until when.
- The server retries a dry pool in a tight loop, or resends forever: a second wall hit straight after a reset parks the moon for a person.
- A reading is invented. The gauge shows only what a provider reported, and says how old it is.

## 3. Approaches

1. **Readings as events, pool state derived from the log — chosen.** Adapters emit a reading whenever the provider reports one; the server appends it as `fuel.reading`. A wall hit appends `fuel.exhausted`. One pure function turns the latest of those into a pool state, and both the scheduler's `plan` and the commands ask it. Nothing is remembered in memory, so a restart, a second process and replay all see the same pool, exactly as slice 1's scheduler does.
2. **A limiter object in the server process.** Holds pool state in memory, updated by voyages. Less code, but a CLI launch in another terminal would not see it, a restart forgets a dry pool and walks into the wall again, and it cannot be replayed.
3. **Poll the providers.** A timer calls `fuel()` on each adapter. Neither provider has a free call that returns the reading: it only arrives during a run. Polling would spend the pool to measure it.

The owner handed this choice to the designer; approach 1 is the designer's pick **(call)**.

## 4. Design

### 4.1 Readings

Verified on this machine, 2026-11-15:
- **Claude Agent SDK.** `rate_limit_event` carries `SDKRateLimitInfo` — `status`, `utilization?`, `resetsAt?`, `rateLimitType?` (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`). The adapter currently turns it into a line of text.
- **Codex (codex-cli 0.145.0).** Session logs under `~/.codex/sessions/**/rollout-*-<thread id>.jsonl` hold `rate_limits` snapshots: `primary: { used_percent, window_minutes, resets_at }`, optional `secondary` of the same shape, `rate_limit_reached_type`.

Not verified, and to be settled by the builder with one small live call that needs the owner's go (it spends the pool):
- whether `codex mcp-server` passes the snapshot to the client as a notification, or the adapter must read it from the session log by thread id after (and optionally during) the call. Either is acceptable; reading the log is the fallback and honours `CODEX_HOME`.
- how often the Claude SDK sends `utilization` (possibly only when a threshold is crossed). If it is rare, Claude's gauge reads `unknown` most of the time; that is accepted, not worked around.

**Contract change.** `AgentEvent` gains a kind:

```ts
{ kind: "fuel"; ts: string; data: { window: string; used: number; resets_at?: string; model_family?: string } }
// used is a fraction 0..1 of the window; window is the provider's own name for it ("five_hour", "seven_day", "10080m")
// model_family is set when the window limits one model family only ("opus", "sonnet"); absent = the whole pool
```

The adapter does the normalising: `used` is always 0..1 whatever unit the provider sends (the unit of the SDK's `utilization` is not documented in the type and is settled in the live check), and the Claude adapter sets `model_family` for `seven_day_opus` and `seven_day_sonnet`. Claude's `overage` window and `overageStatus` are not readings and are ignored **(call)**.

`Job` gains an optional `model`. The Claude adapter flies `job.model` when it is set and `models.frontier` otherwise, as today; the Codex adapter ignores it (it takes its model from the spec's Model hint). Only a refuelled freighter sets it in this slice **(call)**.

`ProviderAdapter.fuel()` is removed: nothing could call it without spending **(call)**. The fake adapter gets a scriptable `fuel` step, and its scripted `rate_limited` error can carry a reset time.

**Storage.** `runVoyage` appends each `fuel` event as `voyage.event` like any other, and additionally as `fuel.reading` `{ provider, window, used, resets_at?, source: "reported" }`, but only when it differs from the last reading for that provider and window by a whole percentage point or a changed reset time, so the log does not fill with repeats. `fuel.reading` has no projection table; the latest readings are read from the log by kind **(call — one table fewer to keep in step with the log; the builder may add an index or a table if a query proves slow)**.

### 4.2 Pool state

One pure function, `poolState(g, provider, now, model?)`, returns the first row that matches:

| State | When |
|---|---|
| `dry` (with `until`) | the pool is exhausted (below) — this outranks everything, including `free`, so a provider with no `pool` block that hits the wall is still held |
| `free` | the provider has no `pool` block, or `pool.kind` is `free` |
| `low` (with `remaining`, `resets_at`) | the tightest live reading has `1 - used` below `pool.reserve_floor` |
| `ok` (with `remaining`, `resets_at`) | there is a live reading and it is at or above the floor |
| `unknown` | none of the above |

- **Model families.** A reading or an exhaustion that carries `model_family` counts only when `model` is given and belongs to that family (the family name appears in the model id); one without it counts for every model. With no `model` argument (the Fleet gauge) every reading counts. So customs filling the Opus window does not stop a Haiku refuel, and an Opus rejection does not shut Claude for Haiku **(call)**.
- **Exhausted** means: there is a `fuel.exhausted` for the provider (matching the model family, as above) whose `until` is in the future, and no voyage on that provider has returned successfully (`voyage.returned`) since it. A successful run is proof the pool is back, which is the way out of a reset time that was guessed too far ahead.
- A reading is **live** until its `resets_at` passes; a reading with no reset time is live for 24 hours **(call)**. After that the window has refilled and the reading says nothing.
- **Tightest** means the highest `used` among the live readings that count **(call)**.
- `reserve_floor` defaults to 0 when absent (never `low`).
- A pool is shared with everything else on the account (this includes the owner's own Claude and Codex sessions), so a reading is a lower bound on use, not a promise. The gauge shows its age for that reason.

### 4.3 The limiter

`fuelCheck(g, role, provider, now, model?)` → `allow` or `hold { reason, until? }`, rules in order:

1. `dry` → hold, every role. Nothing can run on it anyway.
2. `free` → allow.
3. Role `review` → allow. Customs may spend to zero (parent §8 rule 2).
4. Role `implement` and `low` → hold.
5. Otherwise (`ok`, `unknown`) → allow.

**Choosing a provider for a freighter.** One shared function replaces the two `pickProvider` copies in `launch.ts` and `review.ts` and the provider walk in `plan.ts`, so the scheduler, the commands and the Bridge cannot disagree:

1. Walk the role's order (`roles.implement` / `roles.review`). Take the first provider that is configured, under its caps, has an idle ship of the class, and passes `fuelCheck`.
2. If a provider earlier in the order was skipped **for fuel** and a later one was taken, that is a reroute: append `limiter.rerouted { task_id, from, to, reason }` before the launch.
3. If none was taken and at least one was skipped for fuel: for a freighter, try refuelling (§4.5); otherwise the ship is **held**.

A held action is not returned by `plan`. `limiter.held { task_id, role, provider, reason, until? }` is appended once when a moon starts waiting and not again while the reason and `until` are unchanged **(call)**, so the log shows the hold without filling up.

**A human click.** `launchMoon` and `inspectMoon` use the same provider choice at every rung, so a click reroutes exactly as the scheduler would, and is refused with the reason and the reset time when the ship would be held. Refuelling follows the rung (§4.5): at `verdicts` and above a plain `moon.launch` refuels by itself when §4.5 holds, as the scheduler would; at `manual` it does not, and needs `refuel: true`. The chooser therefore takes "may refuel" as an input: the rung is not `manual`, or the caller asked.

Naming a `provider` explicitly still runs the check for that provider. `override: true` sends the ship on the first provider in the order regardless of `low` or `dry`, once, for this voyage only **(parent §8: "a human overrides once from the Bridge")**. On a `dry` pool that is a probe: if the pool is back the voyage returns and the pool is no longer exhausted (§4.2); if not, it is a second hit and parks (§4.4). The scheduler never overrides.

### 4.4 Hitting the wall mid-run

A voyage ends **out of fuel** when its error is classified `rate_limited`, or a freighter's report status is `RATE_LIMITED`.

Then, in this order:

1. `fuel.exhausted { provider, until, voyage_id, model_family? }` is appended. `until` is the reset time of the window the provider named if it gave one, else the **earliest** reset time among the provider's live readings (the shortest window is the likeliest wall, and guessing short costs one probe where guessing long shuts the provider for days), else `now + 30 minutes` **(call)**.
2. The voyage gets its own ending, not `adrift`: new event `voyage.out_of_fuel`, new voyage status `out_of_fuel` (from `launched` or `working`). Its ship is **released** (`ship.released`, outcome `out_of_fuel`), not left adrift as a park leaves it: nobody replies to a moon that is waiting on fuel, so a ship left adrift would never come back. The voyage stays `out_of_fuel` on record; it is superseded (`out_of_fuel → superseded`) only when the moon is later replied to or dropped. *(As built, corrected 2026-11-19: the first draft said "when the next one launches".)*
3. The moon:
   - **freighter:** new event `moon.awaiting_pickup`, new moon status `awaiting_pickup` (from `implementing`), and **no decision**. The work in the worktree stays.
   - **customs:** the moon returns from `reviewing` to `audited` (new event `moon.review_abandoned`, transition `reviewing → audited`), the freighter still `holding`, so the next step is "send customs" again and no freighter round is spent **(call)**.

**Its own status (owner).** `adrift` keeps exactly one meaning: parked, needs a person. A moon whose freighter ran out of fuel is `awaiting_pickup`, and a voyage that ran out is `out_of_fuel` — in the log, the database and the page alike. Transitions: from `awaiting_pickup`, `moon.gated` is legal (the next freighter), as are `moon.adrift` (the scheduler's park after two refusals, and the second hit below) and `moon.dropped` (a person may cancel the delivery without parking it first) **(call)**. On the page the status reads "cargo awaiting pickup". The `CHECK` constraints on `moons.status` and `voyages.status` list the allowed values, so this needs a migration (`src/db/migrations/002.sql`). Every place that switches on `adrift` (`query.ts`, `plan.ts`, `launch.ts`, `park.ts`, `dock.ts`, `decision.ts`, the page) is checked for whether the new status belongs beside it.

**Sending the ship again.** A moon that is `awaiting_pickup` may be sent a freighter without a human reply: `launchMoon` accepts it, `availableActions` offers `launch`, and `plan` treats it as a visited moon (automatic from `verdicts` up). It goes through the existing relaunch path — the work already in the worktree is audited and carried over. Whether a ship is actually sent is then the limiter's business: the pool is `dry` until `until`, so the moon waits, reroutes or refuels like any other.

**The second hit.** If a moon's voyage ends out of fuel, and the previous voyage of the same role on the same assignment **on that provider** (voyages on other providers in between do not count) also ended out of fuel, the moon is parked the way it is today: reason `rate_limited`, with a decision and the ship adrift. The reset time was wrong or the pool is being drained elsewhere, and a person should look. Two wall hits in a row per provider is therefore the most any moon can take, however it reroutes or refuels in between. This is derived from the log; nothing is counted in memory.

**Fix-round cap.** A freighter sent again after its predecessor ran out of fuel uses a new round number. So that fuel trouble does not eat the owner's fix rounds, `inspectMoon` parks for `max_fix_rounds` on the number of FIX verdicts issued on the assignment, not on the round number **(call — identical for a moon that never went adrift; more lenient than today for one relaunched after a reply)**.

### 4.5 Refuelling

**Declaration.** A new optional key on the pool that may run dry:

```jsonc
"codex": { "adapter": "codex-mcp", "pool": { "kind": "window", "reserve_floor": 0.10,
  "refuel": { "provider": "claude", "models": { "terra": "claude-sonnet-5-5", "luna": "claude-haiku-5-5" }, "min_wait_minutes": 30 } } }
```

Validation: `provider` names a configured provider other than this one; `models` maps tier names to model ids and is non-empty; `min_wait_minutes` is an integer ≥ 0, default 30. Unknown keys refuse. `DEFAULT_CONFIG` declares none: a new galaxy only waits **(call)**.

**When a freighter is refuelled** — all must hold **(owner)**:
1. the provider it would have flown on is `low` or `dry` and declares `refuel`;
2. the moon's tier has an entry in `refuel.models`;
3. the refuel provider passes `fuelCheck` for `implement` — not `dry`, and not below its own floor. An `unknown` reading passes **(call — Claude may report rarely; requiring a reading would mean refuelling never happens)**;
4. the reset is not close: the held pool's `until` / `resets_at` is more than `min_wait_minutes` away, or unknown;
5. the refuel provider is under its caps and has an idle freighter.

If any fails, the moon waits.

**Who starts it.** At `verdicts` and above the scheduler does, with no click. At `manual` nothing is automatic: the moon shows a **Refuel** button, which is `moon.launch` with `refuel: true` **(owner)**. At `verdicts` the usual rule still applies that the first freighter to a moon is the human's step; refuelling does not change who sends it, only what it flies on.

**What flies.** An ordinary implement voyage on the refuel provider with the mapped model. `voyage.launched` carries `refuel_for: "<held provider>"` and the model; `limiter.refuelled { task_id, from, to, model, reason }` is appended before it. The model travels as `Job.model` (§4.1), so the adapter really flies it; today the model in the `voyage.launched` payload is a record only, and the Claude adapter always flies `models.frontier`. Condition 3's `fuelCheck` is asked with the mapped model, so only the windows that limit that model count. A session is resumed only on the same provider (already the rule in `launch.ts`), so a refuelled freighter starts fresh from the spec plus the carried-over worktree.

**No latch.** Each round chooses again from the top: when the first pool has refilled, the next round flies on it **(call — as in Lanes: no failover state to corrupt)**.

### 4.6 The scheduler

- `plan` uses the shared provider choice (§4.3), so an action that would be held is not planned, and a refuelled or rerouted one is planned with the provider it will use.
- A pool coming back changes no row and writes no event. The existing 5-second tick re-plans, which is enough: the reset time is in the log and `poolState` compares it with the clock.
- The scheduler never passes `override`.
- The `ready_to_send` count behind the rung-raise confirmation uses the same plan, so it no longer counts freighters the limiter would hold.

### 4.7 The Bridge page

Snapshot gains `pools: [{ provider, kind, state, remaining?, resets_at?, until?, reading_ts?, reserve_floor, refuel? }]`, and each moon row and the moon detail gain `waiting_on_fuel?: { provider, reason, until? }` and `can_refuel?: { provider, model }`.

```
Fleet
  codex    ████████░░ 78% left · resets Sat 14:20 · read 12 min ago     floor 10%
  claude   ░░░░░░░░░░ unknown                                            floor 25%
  codex    ▓▓▓▓▓▓▓▓▓▓ dry until 14:20  (after a wall hit)

Moon row:   V1-FUEL.03   waiting on codex fuel · resets 14:20        [Refuel: claude/haiku]  [Send anyway]
            V1-FUEL.04   implementing · refuelled: claude/haiku
```

- The gauge sits in the Fleet panel beside each provider **(call)**. `low` and `dry` are told apart by text as well as colour.
- `waiting on <provider> fuel` uses the same label style as slice 1's `waiting on <task>`.
- **Refuel** appears when §4.5 holds; **Send anyway** (the override) appears on any moon waiting on fuel, worded as a probe when the pool is `dry`. Both are shown at every rung; at `verdicts` and above the scheduler will usually have acted first.
- A refuelled voyage is marked in the moon row and in the voyage list of the detail panel.

### 4.8 Things deliberately left as they are

- `roles.implement` in `DEFAULT_CONFIG` ends with `fake`. A reroute walks that order, so a galaxy that keeps the default would reroute a held freighter to the fake provider. The order is the owner's to set; this slice does not second-guess it, but `nexus config` output and the README should say so **(call)**.
- A voyage interrupted by a shutdown still parks as `interrupted`.
- Customs has no refuel. If the review pool is dry, the moon waits for the reset, or reroutes down `roles.review`.

## 5. Security-routed files

This slice changes `src/server/dispatch.ts` (the `fuel.reading` append, `Job.model`, the out-of-fuel ending with its ship release) and `src/providers/claude-sdk/index.ts` (readings, `job.model`), the neighbour of `gate-hook.ts`; the hook itself is not touched. `dispatch.ts` is security-routed: its task runs only with the owner's go. So is `src/db/migrations/002.sql`, which adds the two statuses (§4.4); the migration must leave `db rebuild` byte-equal on an existing galaxy.

## 6. Testing and done-when

- **`poolState` and `fuelCheck`:** table tests over logs built by direct appends — each state, reading expiry, several windows, floor absent, `dry` outranking a healthy reading, each limiter rule per role.
- **Provider choice:** order walk, reroute event, held when nothing passes, refuel conditions one by one (each of the five failing alone means "wait").
- **Adapters:** the Claude adapter turns a `rate_limit_event` with `utilization` into a `fuel` event; the Codex adapter turns a snapshot (from a notification or a session-log fixture) into one, with `primary` and `secondary`. Fixtures only.
- **End to end on the fake adapter:**
  1. `roundabout`, a pool scripted to read below its floor: no freighter is sent; `limiter.held` is written once; the moon shows `waiting_on_fuel`. A later reading above the floor (or the reset passing, with an injected clock) sends it.
  2. A freighter scripted to hit the wall: `fuel.exhausted`, moon `awaiting_pickup`, voyage `out_of_fuel`, no decision and nothing `adrift`; after `until` the server sends a freighter again and the moon is settled with no command.
  3. The same, hitting the wall again after the reset: the moon is parked `rate_limited` with a decision, and nothing further is sent.
  4. Customs scripted to hit the wall: the moon is `audited` again, customs is sent after the reset, the freighter round is unchanged.
  5. Refuel declared, first pool dry with a far reset: the freighter flies on the refuel provider with the mapped model; `limiter.refuelled` and `refuel_for` are recorded; the next round after the reset flies on the first provider.
  6. Refuel declared but the reset is 5 minutes away: the moon waits.
  7. Refuel declared, refuel provider below its own floor: the moon waits.
  8. `manual`: nothing is sent; `moon.launch` is refused with the reason; with `override: true` it is accepted when `low`, and when `dry` (a probe: a scripted success clears the exhaustion, a scripted wall parks); with `refuel: true` it flies on the refuel provider. At `verdicts`, a plain `moon.launch` on a dry pool with refuel declared flies on the refuel provider.
  11. A provider with no `pool` block scripted to hit the wall: held until `until`, not resent at once.
  12. Wall hits alternating between two providers (first pool, refuel provider, first pool again after its reset): the moon parks on the second hit on the first provider.
  13. Three out-of-fuel endings in a row on one provider's customs leave every customs ship idle.
  14. A reading with `model_family: "opus"` below the floor: a refuel on a Haiku model is still allowed; the Fleet gauge shows the Opus reading.
  9. A wall hit followed by a FIX verdict does not reach `max_fix_rounds` one round early.
  10. Server stopped and started while a pool is dry: no freighter is sent before `until`.
- **Page:** gauge states render (`ok`, `low`, `dry`, `unknown`, `free`), the waiting label, both buttons and their absence, in the rendering tests slice 1 introduced.
- **Rebuild:** `db rebuild` accepts the new event kinds and leaves the projections byte-equal.

**Done when:** on the fake adapter at `roundabout`, a three-moon planet whose first pool goes dry mid-run is fully settled with zero commands — one moon by waiting out the reset, one by refuelling — and the Bridge shows the gauge, the wait and the refuel while it happens.

A live check of both real adapters' readings is a separate, owner-approved step (`NEXUS_LIVE=1`), not part of the suite.

## 7. Left to the builder

- Module layout (suggested: `src/server/limiter/pool.ts` for `poolState`, `limiter.ts` for `fuelCheck` and the provider choice).
- How the Codex adapter obtains the snapshot (§4.1), after the live check.
- How the clock is injected for tests.
- How the new log-only event kinds are registered for `db rebuild` (as `scheduler.acted` was).
- The query for the latest readings, and whether it needs an index.
- Gauge styling and the exact label wording, within "places don't move; ships do".
