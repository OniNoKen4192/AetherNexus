# TASK: reads-ship-identity

## Meta
- **Task ID**: SHIP-CATALOGUE.05
- **Parent plan**: docs/superpowers/plans/2026-11-19-ship-catalogue.md
- **Depends on**: SHIP-CATALOGUE.01, .02 (merged); plan Tasks 3 and 4 (KEEP, landed: e788d03, fdd284c)
- **Estimated scope**: M
- **Model hint**: terra

## Objective
Everything that reads the galaxy shows what a ship is and what a voyage carries: the snapshot and `fleet(g)` give each ship its formation as an object, every voyage row gives its cargo and a short description of its ship, and `nexus fleet` prints eight columns.

## Context
Aether Nexus shows automated development work as space traffic. Since the last two tasks a ship is a lasting record: the `ships` table has `job` (`delivery`, `customs`, `transfer`, `survey`), `fleet` (the provider), `faction`, `weight` and `formation` (JSON text: a full copy of the catalogue entry the ship was commissioned with, `{ id, name, vessels: [{ hull, count, role }], art? }`), and the `voyages` table has `cargo` (JSON text `{ id, label }` or NULL). Ships are commissioned on demand when a voyage is launched; a new galaxy has none. Ships registered by older galaxies read as weight `standard` with a formation named `Freighter`, `Customs cutter`, `Carrier` or `Surveyor`. This task only changes the read side: the HTTP snapshot, the moon detail and the CLI table. The page (`web/`) is the next task and must not be touched here; it will consume the shapes below. Vocabulary rule for every identifier, comment and test name: the job is a *delivery*; `freighter` and `carrier` are hull or formation names in data and nothing else. Affected workflow IDs is `none` because this project has no review suite.

## Files

### Touch
| Path | Action | Notes |
|------|--------|-------|
| `tests/http/reads-ships.test.mjs` | create | snapshot, moon detail, `fleet(g)` |
| `tests/cli/fleet-table.test.mjs` | create | `fleetTable` and `nexus fleet --json` |
| `src/server/commands/query.ts` | modify | ship views and voyage `cargo` / `ship` |
| `src/cli/format.ts` | modify | `fleetTable` only |

### Do NOT touch
- `web/**` — owned by SHIP-CATALOGUE.06
- `src/db/statements.ts` — this task needs no new SQL: `ships.all`, `ships.byId` and the voyage statements already return the columns
- `src/core/fleet.ts`, `src/core/catalogue/**`, `src/db/reducers/**`, `src/server/limiter/**`, `src/server/commands/delivery.ts`, `customs.ts` — landed in earlier tasks
- `tests/http/reads.test.mjs`, `tests/cli/cli.test.mjs`, `tests/server/commission.test.mjs` and every other existing test — they must keep passing unchanged
- Any file not listed under Touch. If completing the objective seems to require touching an unlisted file, STOP and report BLOCKED.

**Standing exclusions:**
- Security-routed files, never modified by this lane: `src/core/git.ts`, `src/validate/**`, `src/providers/claude-sdk/gate-hook.ts`, `src/server/dispatch.ts`, `src/db/migrations/**`, `src/server/http/auth.ts`, `src/server/lock.ts`
- Pipeline-owned paths: `docs/superpowers/plans/**`, `docs/superpowers/tasks/**`, `.superpowers/sdd/**`
- `package.json`, `package-lock.json` — no dependency changes

## Interfaces

Produced (in `src/server/commands/query.ts`):

```ts
import type { ShipFormation } from "../../core/catalogue/types.js";
/** A ship as every read shows it: the row, with `formation` parsed. */
export type ShipView = Row & { formation: ShipFormation };
/** What a voyage row says about its ship. */
export type VoyageShip = { name: string; faction: string; weight: string; formation_name: string };
type VoyageView = Row & { owner: Owner | null; refuel_for: string | null; cargo: { id: string; label: string } | null; ship: VoyageShip | null };

export type Snapshot = { /* unchanged */ fleet: ShipView[]; voyages: VoyageView[] /* … */ };
export function fleet(g: Galaxy): ShipView[];      // was Row[]
// MoonDetail.voyages is VoyageView[] as before, now with the two new fields.
```

Produced (in `src/cli/format.ts`):

```ts
export function fleetTable(ships: Row[]): string;
// columns, in this order: name, fleet, faction, job, weight, formation, status, voyages
// `formation` prints the formation's name; `voyages` prints voyage_count. Accepts ShipView rows (formation an object)
// and raw rows (formation a JSON string).
```

Consumed (exact current code):

```ts
// src/core/catalogue/types.ts
export type Vessel = { hull: string; count: number; role: "lead" | "escort" | "cargo" };
export type ShipFormation = { id: string; name: string; vessels: Vessel[]; art?: string | null };
// src/core/catalogue/builtin.ts
export const PLAIN_FORMATION: ShipFormation;   // { id: "plain", name: "Ship", vessels: [{ hull: "ship", count: 1, role: "lead" }] }
// src/core/fleet.ts — the shape of a row from "ships.all" / "ships.byId"
export type ShipRow = { id: string; name: string; job: ShipJob; fleet: string; faction: string; weight: string; formation: string /* JSON */; status: string; voyage_count: number; last_event_id: number };
// src/server/commands/query.ts — current code this task changes
type VoyageView = Row & { owner: Owner | null; refuel_for: string | null };
function voyageRows(voyages: Row[], assignmentEvents: EventRow[], ctx: OwnerCtx): VoyageView[] {
  return voyages.map((voyage) => {
    const launched = assignmentEvents.find((event) => event.kind === "voyage.launched" && event.voyage_id === voyage["id"]);
    const refuelFor = launched?.payload["refuel_for"];
    return { ...voyage, owner: ownerFromLaunch(voyage, launched, ctx), refuel_for: typeof refuelFor === "string" ? refuelFor : null };
  });
}
// snapshot(): `fleet: g.db.all("ships.all")`;  export function fleet(g: Galaxy): Row[] { return g.db.all("ships.all"); }
// src/cli/format.ts — current
export function fleetTable(ships: Row[]): string {
  return table(["name", "job", "fleet", "status", "voyage_count"], ships.map((r) => [s(r["name"]), s(r["job"]), s(r["fleet"]), s(r["status"]), s(r["voyage_count"])]));
}
// src/cli/run.ts (do not change): `if (c0 === "fleet" && c1 === undefined) { const r = fleet(g); return out(r, () => fleetTable(r)); }` — `--json` prints `r`
```

## Constraints
- Read-only: no event is appended, no row is written, no SQL is added. Voyage rows look their ship up with the existing `ships.byId` statement (or one `ships.all` read per call); `voyageRows` may take `g` or a ship lookup as a new parameter.
- A ship row whose `formation` text does not parse, or parses to something without a string `name` and an array `vessels`, is shown with a copy of `PLAIN_FORMATION`; a voyage whose `cargo` text does not parse, or lacks string `id` and `label`, is shown with `cargo: null`. A read never throws for bad stored JSON.
- A voyage's `cargo` in a view is always the parsed object or `null`, never the JSON string. A voyage whose ship row is missing has `ship: null`.
- `ship.formation_name` is the formation's `name` after the fallback above.
- Every other field of the ship and voyage rows stays as it is (ids, status, `voyage_count`, `owner`, `refuel_for`, …).
- `status(g)` (the CLI status read) is unchanged.
- No new dependencies. Tests use `node:test` and `node:assert/strict` and import from `dist/` (the test command builds first). For HTTP tests follow `tests/http/reads.test.mjs`: `startWorld()` from `tests/http/helpers.mjs` gives `{ w, api }` with one assigned moon `T1` on fake providers; `x.api("/api/snapshot")` and the moon-detail route used there return the JSON. For CLI tests follow `tests/cli/cli.test.mjs` (its `nexus(dir, …)` helper runs the built CLI in a temp repo). To get a ship without flying, use `idleShip(db, fleet, job, weight)` from `tests/fixtures/world.mjs`; to get a ship registered the old way, use `seedFleet(db, ["fake"])` from the same file. Roles stay pinned to fake providers; no test calls a real provider.

## Acceptance

**Test command (must exit 0):**
```bash
npm test -- "tests/http/reads-ships.test.mjs" "tests/cli/fleet-table.test.mjs"
```
The first two Touch entries create these tests.

**Behavioral criteria** (each covered by a test in the two new files):
1. After one delivery (`sendDelivery(w.g, { taskId: "T1" })`), `/api/snapshot` has one ship in `fleet` with `job: "delivery"`, string `faction` and `weight`, and `formation` an object with `id`, `name` and a non-empty `vessels` array; the delivery's row in `voyages` has `cargo` an object `{ id, label }` equal to the parsed `voyages.cargo` column, and `ship` equal to `{ name, faction, weight, formation_name }` of that ship.
2. After customs is sent (`sendCustoms`), the customs voyage has `cargo: null` and a `ship` whose values are the customs ship's.
3. The moon detail for `T1` shows the same `cargo` and `ship` on each voyage as the snapshot does.
4. A ship registered the old way (`ship.registered`) reads with `weight: "standard"`, `faction` equal to its fleet, and `formation.name` `"Freighter"` for a delivery ship.
5. A ship whose stored `formation` is made unparseable or shapeless by a direct `UPDATE` on the test database reads with the plain formation (`formation.id === "plain"`), and the snapshot request still answers 200; a voyage whose stored `cargo` is replaced by `'[]'` reads `cargo: null`.
6. `fleet(g)` returns the same ship views as `snapshot.fleet`.
7. `fleetTable` prints the header `name  fleet  faction  job  weight  formation  status  voyages` (columns padded as `table` does) and one row per ship with the formation's name; it gives the same text for a `ShipView` and for the raw row of the same ship.
8. `nexus fleet --json` prints an array whose objects carry `name`, `fleet`, `faction`, `job`, `weight`, `formation` (an object), `status`, `voyage_count`; `nexus fleet` on a galaxy with no ships prints only the header.
9. Reading changes nothing: `events.maxId` is the same before and after the snapshot, the moon detail and `fleet(g)`; after `rebuild` the snapshot's `fleet` and `voyages` are deep-equal to what they were.

**Affected workflow IDs**: none

**Regression guard (task level — implementer runs this):**
```bash
npm test
```

## Out of Scope
- Do not change the page, its types or its bundle.
- Do not change what `nexus status` prints.
- Do not add sorting by weight or grouping; `ships.all` already orders by fleet, job, weight, name.
- Do not rename `voyage_count` in the data; only the table's column header is `voyages`.
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
