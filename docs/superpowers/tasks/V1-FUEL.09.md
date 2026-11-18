# TASK: fuel-commands-meet-the-limiter

## Meta
- **Task ID**: V1-FUEL.09
- **Parent plan**: docs/superpowers/plans/2026-11-15-v1-fuel.md
- **Depends on**: V1-FUEL.08
- **Estimated scope**: L
- **Model hint**: sol

## Objective
Sending a freighter or customs — from the CLI, the Bridge or the scheduler — asks the limiter first: a provider whose pool is low or dry holds the ship (a refusal that says what it is waiting on), a person can send it anyway or refuel on a cheaper model, cargo that awaits pickup is picked up by the next freighter with no reply needed, and such a moon can be dropped.

## Context
Slice 2 of v1. The limiter (`chooseProvider`, V1-FUEL.06) and the wall ending (`endOutOfFuel`, V1-FUEL.07) exist and the dispatcher uses them (V1-FUEL.08), but the two commands still pick a provider with their own `pickProvider` and never ask about fuel. After this task there is one way to choose a provider. A hold is not a failure and opens no decision: the command refuses before any side effect, exactly like "all freighters are assigned". A moon whose ship ran out of fuel is `awaiting_pickup`: the work is still in the worktree, nobody has to reply, and the next launch is a relaunch that carries the work over. Because such a relaunch advances the round without a FIX verdict, the fix-round cap must count FIX verdicts instead of reading the round number. Wording rule for messages, comments and test names: a *ship* runs out of fuel or hits the wall; a moon never does; the moon's *cargo awaits pickup*; `adrift` means only "needs a person". Affected workflow IDs is `none` because this project has no review suite.

## Files

### Touch
| Path | Action | Notes |
|------|--------|-------|
| `tests/server/launch-fuel.test.mjs` | create | |
| `tests/server/review-fuel.test.mjs` | create | |
| `tests/http/commands-fuel.test.mjs` | create | |
| `src/server/commands/launch.ts` | modify | provider choice, `awaiting_pickup` relaunch, `RATE_LIMITED` report |
| `src/server/commands/review.ts` | modify | provider choice, fix-round cap |
| `src/server/commands/park.ts` | modify | `dropMoon` accepts `awaiting_pickup` |
| `src/server/commands/query.ts` | modify | `availableActions` only |
| `src/server/http/commands.ts` | modify | `boolean` field type; three new fields |
| `src/cli/run.ts` | modify | `--override`, `--refuel`; usage text |

### Do NOT touch
- `src/server/dispatch.ts` — security-routed; import from it, never edit it
- `src/server/limiter/**` — owned by V1-FUEL.06 and .07; import `chooseProvider` and `endOutOfFuel`
- `src/server/scheduler/**` — owned by V1-FUEL.10 and .11
- `src/server/http/auth.ts`, `src/server/lock.ts` — security-routed
- `web/**` — owned by V1-FUEL.14 and .15
- Existing test files — they keep passing unchanged. If one fails because of a behaviour this spec changes on purpose, STOP and report it (name the test and the assertion) instead of editing it.
- Any file not listed under Touch. If completing the objective seems to require touching an unlisted file, STOP and report BLOCKED.

**Standing exclusions:**
- Security-routed files, never modified by this lane: `src/core/git.ts`, `src/validate/**`, `src/providers/claude-sdk/gate-hook.ts`, `src/server/dispatch.ts`, `src/db/migrations/**`, `src/server/http/auth.ts`, `src/server/lock.ts`
- Pipeline-owned paths: `docs/superpowers/plans/**`, `docs/superpowers/tasks/**`, `.superpowers/sdd/**`
- `package.json`, `package-lock.json` — no dependency changes

## Interfaces

Produced:

```ts
// src/server/commands/launch.ts
export async function launchMoon(
  g: Galaxy,
  input: { taskId: string; provider?: string; override?: boolean; refuel?: boolean; onEvent?: (e: AgentEvent) => void; signal?: AbortSignal; onLaunched?: (voyageId: string) => void },
  deps?: { audit?: typeof audit },
): Promise<{ voyageId: string; audit: AuditReport | null; moonStatus: MoonStatus }>;

// src/server/commands/review.ts
export async function inspectMoon(
  g: Galaxy,
  input: { taskId: string; provider?: string; override?: boolean; onEvent?: (e: AgentEvent) => void; reviewScript?: string; signal?: AbortSignal; onLaunched?: (voyageId: string) => void },
): Promise<{ voyageId: string; verdict: ReviewReport | null; moonStatus: MoonStatus }>;

// src/server/http/commands.ts
type Field = { type: "string" | "integer" | "strings" | "boolean"; optional?: true; values?: readonly string[] };
// "moon.launch":    fields { taskId, provider?, override?: boolean, refuel?: boolean }
// "voyage.inspect": fields { taskId, provider?, override?: boolean }

// Log events appended by launchMoon (both are log-only kinds that already exist; envelope = the moon's scope):
//   limiter.rerouted  payload { task_id, from, to, reason }          reason "dry" | "low"
//   limiter.refuelled payload { task_id, from, to, model, reason }
```

Consumed (exact current code):

```ts
// src/server/limiter/limiter.ts
export type Choice =
  | { kind: "fly"; provider: string; shipId: string; model?: string; reroutedFrom?: { provider: string; reason: "dry" | "low" }; refuelFor?: { provider: string; reason: "dry" | "low" } }
  | { kind: "held"; provider: string; reason: "dry" | "low"; until?: string; canRefuel?: { provider: string; model: string } }
  | { kind: "none"; message: string };
export function chooseProvider(g: Galaxy, p: { role: Role; tier: string | null; mayRefuel: boolean; requested?: string; override?: boolean; capacity?: Capacity }): Choice;
// `none` messages already reproduce today's wording: "no provider is configured for the <role> role",
// "provider '<p>' is not configured", "provider '<p>' is at its limit of <n> (scheduler.per_provider_max)",
// "all freighters in fleet '<p>' are assigned" / "all customs in fleet '<p>' are assigned".

// src/server/limiter/wall.ts
export function endOutOfFuel(g: Galaxy, p: { taskId: string; voyageId: string; shipId: string; role: Role; provider: string; model?: string; resetsAt?: string; modelFamily?: string; details: string }): { parked: boolean; until: string };
// accepts a voyage that is launched, working or holding; for role "implement" the moon may be implementing or audited.

// src/server/dispatch.ts
export type VoyageInput = { /* … */ model?: string; refuelFor?: string };     // refuelFor is recorded on voyage.launched as payload.refuel_for
export type MoonRow = { id: string; task_id: string; assignment_id: number; status: string | null; round: number; tier: string | null; park_reason: string | null; /* … */ };

// src/server/errors.ts:  new Refusal(message, details?)   — the HTTP layer returns details in the error body

// src/server/commands/launch.ts today
//   function pickProvider(g, requested): string                      // DELETE (also the one in review.ts)
//   const relaunch = status === "adrift" || status === "quarantined";
//   if (relaunch && !repliedSincePark(g, moon.assignment_id)) throw new Refusal(`moon ${taskId} is ${status} — use 'nexus moon reply' or 'nexus moon drop'`);
//   … else if (!relaunch && status !== "emitted" && status !== "gated") throw new Refusal(`moon ${taskId} is '${status}' — it cannot be launched from there`);
//   const round = fixRound || relaunch ? moon.round + 1 : moon.round || 1;
//   // Precheck 3: a free ship, before any side effect.
//   const provider = pickProvider(g, input.provider); … refuseIfAtCap … pickIdleShip …
//   if (PARK_STATUSES.has(impl.status)) parkVoyage(g, { taskId, voyageId, shipId, reason: impl.status.toLowerCase(), details: impl.blocked_reason ?? impl.raw });

// src/server/commands/review.ts today
//   } else if (moon.round >= g.config.automation.max_fix_rounds) { parkVoyage(… reason: "max_fix_rounds" …) }

// src/server/commands/park.ts today
//   function requireParked(moon, verb)   // adrift or quarantined only; used by replyMoon and dropMoon

// src/server/commands/query.ts today — availableActions(g, taskId, ctx): Action[]
//   if (pendingTreeDecision(g, taskId)) return ["answer", ...((adrift || quarantined) ? ["drop"] : [])];
//   emitted | gated → ["launch"]; … adrift | quarantined → (unchanged)
```

## Constraints
- **One chooser.** Both `pickProvider` functions are deleted. Each command calls `chooseProvider` once, at the place its provider is chosen today (in `launchMoon` that is precheck 3, before the worktree, the gate and any event), with `role`, `tier: moon.tier`, `requested: input.provider` (omitted when undefined), `override: input.override === true`, and `mayRefuel`: for launch `input.refuel === true || g.config.automation.level !== "manual"`; for inspect always `false`. No `capacity` argument.
  - `fly` → carry on as today with `choice.provider`. The existing checks that follow (`provider is not configured`, at cap, no idle ship) may stay as a second line of defence or go; either way the refusal messages for those cases are unchanged from today.
  - `held` → `throw new Refusal(message, details)` with message `moon <taskId> is waiting on <provider> fuel (<reason>)`, followed by `, resets <until>` when `until` is known; `details` is `{ provider, reason, until: <until or null>, can_refuel: <canRefuel or null> }`. Nothing has been written, created or taken when it is thrown.
  - `none` → `throw new Refusal(choice.message)`.
- **Recording the choice** (launch only): after the gate and immediately before `runVoyage`, append `limiter.rerouted` when `choice.reroutedFrom` is set (`from` = `reroutedFrom.provider`, `to` = `choice.provider`, `reason`), or `limiter.refuelled` when `choice.refuelFor` is set (`from` = `refuelFor.provider`, `to` = `choice.provider`, `model` = `choice.model`, `reason`). Pass `model: choice.model` and `refuelFor: choice.refuelFor.provider` to `runVoyage` only when the choice is a refuel. An overridden flight and a plain flight record neither.
- **Pickup.** In `launchMoon`, status `awaiting_pickup` takes the relaunch path exactly as `adrift` does (`round + 1`, the previous round's work carried over, the same audit baseline handling) **except** that no reply is required: the `repliedSincePark` refusal applies to `adrift` and `quarantined` only.
- **A report that says the provider was rate-limited.** When the returned freighter's report status is `RATE_LIMITED`, call `endOutOfFuel(g, { taskId, voyageId, shipId, role: "implement", provider, details })` with the same `details` the park used, instead of `parkVoyage`. `BLOCKED` and `BACKEND_FAILURE` still park as today. The audit event is appended before it, as today.
- **Fix-round cap.** In `inspectMoon`, a FIX verdict parks with `max_fix_rounds` when the number of FIX verdicts on this assignment, counting the one just issued, is `>= g.config.automation.max_fix_rounds`. The `details` text may keep naming the round.
- **Drop.** `dropMoon` accepts `awaiting_pickup` as well as `adrift` and `quarantined`; the refusal for any other status reads `only an adrift or quarantined moon, or one whose cargo awaits pickup, can be dropped`. `replyMoon` is unchanged: it still refuses an `awaiting_pickup` moon with its present message.
- **Actions.** `availableActions` returns `["launch", "drop"]` for an `awaiting_pickup` moon, and `["answer", "drop"]` when that moon has a pending tree decision.
- **HTTP.** A `boolean` field must be exactly `true` or `false`; anything else is a 400 with `field '<key>' must be true or false`. The three new fields are optional. They reach the commands unchanged.
- **CLI.** `nexus moon launch <task-id> [--provider <p>] [--override] [--refuel] [--quiet]`; `nexus voyage inspect <task-id> [--provider <p>] [--override] [--quiet]` and its alias `moon inspect`. Update the usage text. An absent flag behaves exactly as today.
- No new dependencies. Tests import from `dist/` and build worlds as `tests/server/limiter-choose.test.mjs` and `tests/server/dispatch-fuel.test.mjs` do (a second provider is `probe: { adapter: "fake", pool: … }` added in the config patch; a pool is made low with a `fuel.reading` event or `recordReading`, dry with a `fuel.exhausted` event whose `until` is in the future). Fixture scripts `wall`, `wall-twice`, `review-wall`, `fuel-low`, `rate-limited`, `review-rate-limited`, `review-fix`, `fix-round` exist; read `src/providers/fake/index.ts` for how a script is picked per provider id and round before relying on one.

## Acceptance

**Test command (must exit 0):**
```bash
npm test -- "tests/server/*.test.mjs" "tests/http/commands*.test.mjs"
```

**Behavioral criteria** (each a named test; 1–12 in `launch-fuel.test.mjs`, 13–16 in `review-fuel.test.mjs`, 17–20 in `commands-fuel.test.mjs`). "Low" means provider `fake` has a pool with `reserve_floor: 0.1` and a live reading of 0.95; "dry" means a live `fuel.exhausted` for it. Level is `manual` unless stated.
1. Low, one provider: `launchMoon` rejects with a message matching `/is waiting on fake fuel \(low\), resets /`; the thrown error's `details` deep-equals `{ provider: "fake", reason: "low", until: <the reading's resets_at>, can_refuel: null }`.
2. After that refusal: no worktree directory for the task, no `moon.gated` event, every ship `idle`, the moon still `emitted`, no decision, and `events.maxId` is what it was before the call.
3. Low with `override: true`: the freighter flies on `fake`, the moon ends `audited`, and neither `limiter.rerouted` nor `limiter.refuelled` is in the log.
4. Dry with a wall behind it: script `wall-twice`; the first launch leaves the moon `awaiting_pickup`; a plain second launch is refused as waiting on fuel (`dry`); the same launch with `override: true` flies, hits the wall again and the moon ends `adrift` with `park_reason` `rate_limited` and one pending decision.
5. Reroute: `fake` low, `probe` ok, implement order `["fake", "probe"]`, no `provider` given: the voyage's provider is `probe`, and exactly one `limiter.rerouted` exists with payload `{ task_id: "T1", from: "fake", to: "probe", reason: "low" }`, appended before `voyage.launched`.
6. Requested provider held: the same world with `provider: "fake"`: refused as waiting on fuel; nothing is rerouted.
7. Refuel by hand: `fake` low with `refuel: { provider: "probe", models: { <the moon's tier>: "m-cheap" }, min_wait_minutes: 0 }`, order `["fake"]`. A plain launch is refused and its `details.can_refuel` deep-equals `{ provider: "probe", model: "m-cheap" }`. With `refuel: true`: the voyage flies on `probe`, `voyages.model` is `"m-cheap"`, the `voyage.launched` payload has `refuel_for: "fake"`, the voyage's events include the text `fake: model m-cheap`, and one `limiter.refuelled` exists with payload `{ task_id: "T1", from: "fake", to: "probe", model: "m-cheap", reason: "low" }`.
8. Refuel by trust: the same world at `automation.level: "verdicts"`, `fake` dry instead of low, a plain launch (no `refuel`): it refuels exactly as in 7, with `reason: "dry"`.
9. `refuel: true` with no refuel declared: refused as waiting on fuel, `can_refuel` null.
10. Pickup: script `wall` (it hits the wall at round 1 and behaves as `happy` at round 2), the pool made available again (override, or an `until` that has passed — say which the test uses): the second launch needs no reply, runs as round 2, and the moon ends `audited` with a clean audit; `moon.round` is 2.
11. An `adrift` moon still needs a reply: script `crash-midrun`, launch, launch again → rejects matching `/adrift.*reply/`.
12. A `RATE_LIMITED` report: a freighter that returns a report with status `RATE_LIMITED` (stub adapter or a temp script) leaves the moon `awaiting_pickup` with no `park_reason`, the voyage `out_of_fuel`, its ship `idle`, no pending decision, one `fuel.exhausted`; a `BLOCKED` report still ends `adrift` with `park_reason` `blocked`.
13. Customs is not held by a low pool: `fake` low, `inspectMoon` on an audited moon flies and returns a verdict.
14. Customs is held by a dry pool: rejects matching `/is waiting on fake fuel \(dry\)/` with `details.can_refuel` null; the moon stays `audited`, the customs ship `idle`, no event appended; with `override: true` it flies.
15. Customs reroutes: review order `["fake", "probe"]`, `fake` dry: the review voyage's provider is `probe`.
16. The cap counts FIX verdicts, not rounds: `max_fix_rounds` 2; round 1 hits the wall (moon `awaiting_pickup`), the pickup runs as round 2 and is inspected with `review-fix` → the moon is reopened for another launch (**not** parked: one FIX verdict); the next round is inspected with `review-fix` again → the moon is `adrift` with `park_reason` `max_fix_rounds`. And without any wall, two FIX verdicts in rounds 1 and 2 park on the second, as today.
17. HTTP `moon.launch` with `override: "yes"`, with `refuel: 1`, and `voyage.inspect` with `override: null`: each is a 400 naming the field; with `override: true` the launch is accepted (202).
18. HTTP `moon.launch` on a held moon returns the refusal status the API already uses for a `Refusal`, with `error` naming the fuel wait and `details` carrying `provider`, `reason`, `until`, `can_refuel`.
19. HTTP `voyage.inspect` rejects `refuel` as an unexpected field (400).
20. HTTP `moon.drop` on an `awaiting_pickup` moon: 200; the worktree and the `nexus/T1` branch are gone and the moon is cleared for a new assignment (as a drop from `adrift` leaves it). `availableActions` for an `awaiting_pickup` moon is `["launch", "drop"]` (assert before the drop). `moon.reply` on an `awaiting_pickup` moon is still refused.
- After criteria 3, 4, 5, 7, 10, 12 and 16: `rebuild` leaves `dumpProjections` byte-equal.

**Affected workflow IDs**: none

**Regression guard (task level — implementer runs this):**
```bash
npm test
```

## Out of Scope
- Do not change the scheduler: `src/server/scheduler/plan.ts` still walks providers its own way until V1-FUEL.10. If a scheduler test fails because `availableActions` now offers `launch` for `awaiting_pickup`, report it; do not edit scheduler code or tests.
- Do not append `limiter.held` anywhere (the scheduler loop does that in V1-FUEL.11); a refused command writes nothing.
- Do not change `chooseProvider`, `endOutOfFuel`, `parkVoyage`, `replyMoon` or the reads other than `availableActions`.
- Do not add the Bridge buttons or any `web/**` change.
- Do not update documentation other than the CLI usage text. Do not fix unrelated failing tests — report them instead (known flake: `tests/server/follow.test.mjs` under load).

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
