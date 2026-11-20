# TASK: page-ship-identity

## Meta
- **Task ID**: SHIP-CATALOGUE.06
- **Parent plan**: docs/superpowers/plans/2026-11-19-ship-catalogue.md
- **Depends on**: SHIP-CATALOGUE.05 (merged: the snapshot carries ship views, voyage `cargo` and `ship`, and `weights`)
- **Estimated scope**: M
- **Model hint**: terra

## Objective
The Bridge page shows, in words, what each ship is and what each voyage carries: the fleet panel lists every ship with its faction, formation, weight, status and trip count, lightest first; a moon with a ship in flight, and the moon's detail panel, say which ship is flying and what it carries.

## Context
Aether Nexus shows automated development work as space traffic: a provider's model does a job and the Bridge page (`web/`, Preact + Vite, built to `dist/web`) shows it as a ship flying to a moon. The server now tells the page what a ship is — a *faction* (one per provider), a *weight* (`light`, `standard`, `heavy`: how strong the model is), a *formation* (for example a carrier group with four frigates) — and what a delivery carries (*cargo*, for example "a diplomat"). Ships are commissioned on demand, so a new galaxy has none. This task is the first, text-only display of that; images come much later and are out of scope. The owner wants a hard task to read as something big ("Carrier group (1 carrier, 4 frigates)") and a small one as something small. Wording rules for all copy, identifiers, comments and test names: the job is a *delivery*; `freighter` and `carrier` appear only as data that comes from the server (hull and formation names), never in the page's own copy; places (moons) do not move, ships do. Page components cannot be rendered under `node --test`, so the logic lives in a pure module that is tested directly, and the components are checked by source and bundle text. Affected workflow IDs is `none` because this project has no review suite.

## Files

### Touch
| Path | Action | Notes |
|------|--------|-------|
| `tests/http/page-ships.test.mjs` | create | pure-module tests, source and bundle checks |
| `web/src/ships.ts` | create | the pure functions below |
| `web/src/types.ts` | modify | ship and voyage shapes |
| `web/src/components/Fleet.tsx` | modify | per-ship line; order |
| `web/src/components/SystemView.tsx` | modify | the voyage sentence on a moon row |
| `web/src/components/MoonDetail.tsx` | modify | the voyage sentence per voyage |
| `web/src/style.css` | modify | only rules for the new elements |

### Do NOT touch
- `src/**` — the server side is finished; the snapshot already has every field the page needs
- `web/src/labels.ts`, `web/src/gauge.ts`, `web/src/store.ts`, `web/src/components/ActionBar.tsx`, `Header.tsx`, `Routing.tsx` and every other page file
- `tests/http/page-fleet.test.mjs`, `page-fuel.test.mjs`, `page-fuel-actions.test.mjs`, `page-moon.test.mjs`, `page-panels.test.mjs`, `page-waiting*.test.mjs` and every other existing test — they must keep passing unchanged. Note `page-fleet.test.mjs` reads `Fleet.tsx` as text: it needs the expression starting `{status === "idle" &&` around the retire controls, `Confirm retire` inside it, and a `.msg-error` outside it.
- Any file not listed under Touch. If completing the objective seems to require touching an unlisted file, STOP and report BLOCKED.

**Standing exclusions:**
- Security-routed files, never modified by this lane: `src/core/git.ts`, `src/validate/**`, `src/providers/claude-sdk/gate-hook.ts`, `src/server/dispatch.ts`, `src/db/migrations/**`, `src/server/http/auth.ts`, `src/server/lock.ts`
- Pipeline-owned paths: `docs/superpowers/plans/**`, `docs/superpowers/tasks/**`, `.superpowers/sdd/**`
- `package.json`, `package-lock.json` — no dependency changes

## Interfaces

Produced — `web/src/ships.ts` (pure: no imports except `import type`, no DOM, no clock):

```ts
export type Vessel = { hull: string; count: number; role: string };
export type Formation = { id: string; name: string; vessels: Vessel[] };
export type VoyageShip = { name: string; faction: string; weight: string; formation_name: string };

/** "Carrier group (1 carrier, 4 frigates)". Vessels in the order given; a hull gets an "s" only when count > 1; no vessels → just the name. */
export function formationText(f: { name: string; vessels: { hull: string; count: number; role: string }[] }): string;

/** "Kestrel — carrier group (anthropic), carrying a diplomat". The formation name is lower-cased; no cargo → no ", carrying …"; no ship → null. */
export function voyageSentence(v: { ship: { name: string; faction: string; formation_name: string } | null; cargo: { label: string } | null }): string | null;

/** A new array ordered by the position of `weight` in `weights` (a weight not in the list goes last), then by name (plain code-unit comparison). Never mutates its input. */
export function sortShips<T extends { weight: string; name: string }>(ships: T[], weights: string[]): T[];

/** Reads an unknown value (a voyage row's `ship` or `cargo`, a ship row's `formation`) into the typed shape, or null when it does not have it. */
export function asVoyageShip(value: unknown): VoyageShip | null;
export function asCargo(value: unknown): { id: string; label: string } | null;
export function asFormation(value: unknown): Formation | null;
```

Produced — `web/src/types.ts`:

```ts
export type ShipView = Row & { formation: { id: string; name: string; vessels: { hull: string; count: number; role: string }[] } };
export type VoyageView = Row & { owner: Owner | null; refuel_for: string | null; cargo: { id: string; label: string } | null; ship: { name: string; faction: string; weight: string; formation_name: string } | null };
// Snapshot.fleet: ShipView[];  Snapshot.voyages: VoyageView[];  MoonDetail.voyages: VoyageView[]
// Snapshot.weights: string[] is already declared — keep it.
```

Consumed (what the server sends; `src/server/commands/query.ts`, do not change):

```ts
// each entry of snapshot.fleet
{ id: string; name: string; job: "delivery" | "customs" | "transfer" | "survey"; fleet: string /* provider id */; faction: string; weight: string;
  formation: { id: string; name: string; vessels: { hull: string; count: number; role: "lead" | "escort" | "cargo" }[]; art?: string | null };
  status: "idle" | "assigned" | "adrift" | "quarantined" | "retired"; voyage_count: number; last_event_id: number }
// each entry of snapshot.voyages and of the moon detail's voyages: the voyage row plus
{ owner: "server" | "other" | "stale" | null; refuel_for: string | null; cargo: { id: string; label: string } | null;
  ship: { name: string; faction: string; weight: string; formation_name: string } | null }
// snapshot.weights: string[]  — the catalogue's weights, lightest first, e.g. ["light", "standard", "heavy"]
```

Existing page code this task builds on (read these files):
- `web/src/components/Fleet.tsx`: `Ship({ b, ship })` renders one `.fleet-ship` line (name, job, status badge, the Retire control); `Fleet({ b })` groups `snapshot.fleet` by `ship["fleet"]`, shows the provider's fuel `Gauge`, a per-job summary line (`.fleet-line`), then the ships.
- `web/src/components/SystemView.tsx`: each assigned moon is a `.row`; `refuelled` collects labels from the moon's voyages that are `launched` or `working` (`voyage["assignment_id"] === moon["assignment_id"]`).
- `web/src/components/MoonDetail.tsx`: `b.detail.voyages.map(...)` renders a refuel label per voyage.
- `web/src/labels.ts`: the pattern for a pure module with `as…` readers (`asFuelWait`) that the test compiles on its own.

## Constraints
- Text only: no images, no icons, no new dependency, no reading of `formation.art`.
- **Fleet panel.** Stays grouped by provider with the fuel gauge and the per-job summary line unchanged. Within a provider, ships are listed with `sortShips(ships, snapshot.weights)`. Each ship line shows, in this order: name, faction, the formation as `formationText` gives it, weight, the status badge, and the trip count as `N trips` (`1 trip` for one). The ship's job stays visible on the line. The Retire control, its confirm step and its error message keep working exactly as now.
- **Moon row (`SystemView.tsx`).** For each of the moon's voyages that is `launched` or `working`, show `voyageSentence` (when not null) as one more element on the row, with class `voyage-ship`. A moon with nothing in flight shows no sentence.
- **Moon detail (`MoonDetail.tsx`).** Show every voyage of the moon as one line with class `voyage-ship`: the voyage's role (`implement` reads as `delivery`, `review` as `customs`), its round, its status through the existing `statusText`, and `voyageSentence` when not null. The existing refuel label per voyage stays.
- A ship or voyage whose new fields are missing or malformed (an older server, a bad row) must not break the page: `asFormation` / `asVoyageShip` / `asCargo` return null and the element shows what it can (the name alone, or nothing).
- `web/src/ships.ts` must compile on its own with the TypeScript compiler, as `web/src/labels.ts` does in `tests/http/page-fuel-actions.test.mjs`: it may `import type` from `./types` and nothing else.
- CSS: add rules only for `.voyage-ship` and any new class used on the ship line; small, muted secondary text in the style of `.fleet-line span:last-child`; the ship line must wrap on a narrow window (`.fleet-ship` already has `flex-wrap`).
- No test calls a real provider; this task's tests start no server at all.

## Acceptance

**Test command (must exit 0):**
```bash
npm test -- "tests/http/page-ships.test.mjs"
```
The first Touch entry creates this test. It compiles `web/src/ships.ts` with the TypeScript compiler the way `tests/http/page-fuel-actions.test.mjs` compiles `web/src/labels.ts` (copy that set-up), and reads the built bundle the way `tests/http/page-fleet.test.mjs` does (`npm test` builds the page first).

**Behavioral criteria** (each covered by a test in `tests/http/page-ships.test.mjs`):
1. `formationText({ name: "Carrier group", vessels: [{ hull: "carrier", count: 1, role: "lead" }, { hull: "frigate", count: 4, role: "escort" }] })` is exactly `Carrier group (1 carrier, 4 frigates)`; one vessel of count 1 gives `Mining vessel (1 mining vessel)`; no vessels gives `Ship`.
2. `voyageSentence({ ship: { name: "Kestrel", faction: "anthropic", formation_name: "Carrier group" }, cargo: { label: "a diplomat" } })` is exactly `Kestrel — carrier group (anthropic), carrying a diplomat`; with `cargo: null` it is `Kestrel — carrier group (anthropic)`; with `ship: null` it is `null`.
3. `sortShips` orders by the weight list then by name, puts a weight that is not in the list last, returns a new array and leaves its input unchanged; with an empty weight list it orders by name.
4. `asVoyageShip`, `asCargo`, `asFormation` accept the shapes under Interfaces and return null for `null`, `undefined`, a string, an array, and an object missing a field or with a field of the wrong type; `asFormation` drops a vessel that is not `{ hull: string, count: number, role: string }`.
5. `Fleet.tsx`, `SystemView.tsx` and `MoonDetail.tsx` each import from `../ships`; `Fleet.tsx` calls `sortShips` and `formationText`; `SystemView.tsx` and `MoonDetail.tsx` call `voyageSentence`.
6. The built bundle (`dist/web/assets/*.js`) contains `, carrying ` and ` trips`, and the built CSS contains `voyage-ship`.
7. None of the seven Touch-listed page files, and no built bundle file, matches `/freighters? in fleet|all freighters/i`; the page's own source for this task (`web/src/ships.ts`) does not contain the word `freighter` or `carrier` at all.

**Affected workflow IDs**: none

**Regression guard (task level — implementer runs this):**
```bash
npm test
```

## Out of Scope
- No images, sprites, canvas, animation or map of the system.
- Do not change what the server sends, the feed, the store or the action buttons.
- Do not change the rung selector copy in `Header.tsx` (a later task sweeps wording).
- Do not add filtering, searching or collapsing to the fleet panel.
- Do not fix unrelated failing tests — report them instead.

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
