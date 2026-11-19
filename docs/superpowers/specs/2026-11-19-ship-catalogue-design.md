# Ship catalogue: ships with a lasting identity, formations by weight, factions by provider

Date: 2026-11-19. Status: for the owner's approval. Builds on the command rename (PR #6).

## 1. Intent

The Bridge should read as space traffic control for a living world. When a strong model takes on a hard task, the trip should look big: a heavy freighter with a military escort, a carrier group carrying a diplomat, a whole convoy. A small job on a cheap model should look small: a mining vessel with a small payload.

Someone who knows the system should be able to tell from the ships alone which provider is running a job.

None of this changes what the software does to the code it manages. It is how the world gets its life, and it has to be easy to extend as new ideas arrive.

A second reason is clarity. Today the word "freighter" means "the ship that implements". The owner wants "freighter" to be one kind of hull among many, and the job to be called a **delivery**. The stored vocabulary has to change for that to be true.

## 2. Vocabulary

| Word | Meaning | Where it lives |
|---|---|---|
| **Delivery** | The job of carrying a moon's work (the `implement` role). | Commands, messages, ship `job`. |
| **Job** | What a ship is for: `delivery`, `customs`, `transfer`, `survey`. Replaces ship `class`. | `ships.job`. |
| **Weight** | How big a trip is. Comes from the model that flies it. Ordered list, starting as `light`, `standard`, `heavy`. | Catalogue; `ships.weight`. |
| **Faction** | A provider's design language. One per provider. | `providers.<id>.faction`; `ships.faction`. |
| **Formation** | What a ship is: its hulls and escort. "Carrier group", "freighter convoy", "mining vessel". | Catalogue; a copy on the ship. |
| **Cargo** | What a delivery carries on one trip. "A diplomat", "ore samples". | Catalogue; recorded on the voyage. |
| **Catalogue** | The data file of weights, formations, cargo and name rules. | Shipped with the app, plus the owner's additions. |

The old class words map to jobs one for one: `freighter` → `delivery`, `customs` → `customs`, `carrier` → `transfer`, `surveyor` → `survey`. `transfer` and `survey` are reserved for later slices, as `carrier` and `surveyor` were; nothing flies them yet.

One word, one meaning: after this change "freighter" and "carrier" appear only as hull or formation names in the catalogue, never as a job.

## 3. Goals

1. A ship is a permanent record: name, faction, job, weight and formation are fixed for its life. Its trips are its history.
2. Ships are commissioned on demand. A delivery takes an idle ship of the right provider, job and weight; if there is none, a new ship is named and recorded.
3. Weight comes from the model. Formation is drawn from the catalogue entries for that job and weight.
4. Faction comes from the provider. A refuelled or rerouted delivery shows the faction and weight of what really flies.
5. Cargo is drawn per trip and recorded on the voyage. A ship's cargo differs from trip to trip.
6. The catalogue is data. A new formation, cargo, weight or name rule is a new entry with no code change.
7. The Bridge shows all of it in words. Each catalogue entry carries an optional `art` key that nothing reads yet, so artwork can be added later without a redesign.

## 4. Non-goals

- Drawings, sprites, animation. Text only in this round.
- A catalogue editor on the Bridge. The catalogue is a file.
- A model call to invent names. Names are generated offline (§7.4). A model-assisted top-up of word lists is a possible later command.
- Flying `transfer` or `survey` ships.
- Renaming the moon status `dropped`, the event `moon.dropped` or the `drop` outcome. They are wrong words too, but they belong to moons, not ships; a later change.

## 5. Anti-goals

- A trip must never wait on, or fail because of, the dressing. If the catalogue has no entry for a job and weight, a built-in plain formation is used (§7.3).
- Dressing must never spend a provider's pool.
- Fleet size must not become a hidden limit on how many jobs of one weight can fly.
- An edit to the catalogue must never change a ship that already exists, or a trip already flown.
- `rebuild` must still leave `dumpProjections` byte-equal: everything a projection shows comes from the log alone, never from the catalogue file or the config at read time.

## 6. Approaches

1. **Ships become real records; the catalogue is a data file. Chosen.** A migration gives ships a job, faction, weight and formation. Ships are commissioned on demand. Biggest change; touches the migration and the launch transaction, both security-routed.
2. **Keep fixed slots, decorate the trip at read time.** No migration, but a named ship would have no fixed hull, nothing would be saved "for lore", and "freighter" would stay the job word. Rejected: it fails goals 1 and 2.
3. **Approach 1 with the catalogue in the database, edited from the Bridge.** An editor is a feature of its own and file-based definitions are easier to hand-edit, share and version. It can be layered on approach 1 later.

The owner chose approach 1.

## 7. Design

### 7.1 Ship record

`ships` gains three columns and renames one:

```
ships(id, name UNIQUE, job delivery|customs|transfer|survey, fleet, faction, weight, formation JSON,
      status idle|assigned|adrift|quarantined|retired, voyage_count, last_event_id)
```

- `fleet` stays the provider id, as today.
- `formation` is a full copy of the catalogue entry the ship was commissioned from (`{ id, name, vessels, art? }`), not a reference. This is what keeps a later catalogue edit from rewriting an existing ship.
- `voyages` gains `cargo JSON NULL`: `{ id, label }` for a delivery, null otherwise.

### 7.2 Commissioning

New event `ship.commissioned`, payload `{ ship: { id, name, fleet, job, faction, weight, formation } }`. Its reducer inserts the ship as `idle`.

Choosing a ship for a voyage (`runVoyage`, inside the existing launch transaction):

1. Resolve the weight (§7.5) and the job (`implement` → `delivery`, `review` → `customs`).
2. Take an idle ship with that `fleet`, `job` and `weight`, least-flown first, then by name (today's order).
3. If there is none, commission one: pick a formation (§7.3), generate a name (§7.4), append `ship.commissioned`, then use it.
4. Append `voyage.launched` as today, with `cargo` added for a delivery (§7.6).

Steps 3 and 4 are one transaction, so a refused launch leaves no orphan ship. `append()` opens its own transaction and cannot nest, so this needs a small "append several events in one transaction" primitive; the voyage id embeds the ship id and is therefore built inside it.

**When a ship is free again does not change.** A delivery ship stays `assigned` after its voyage returns, while it holds in orbit with the cargo, and is released at dock, supersede, reply or cancel, exactly as today. "Idle" in step 2 means released, not merely returned.

Consequences:

- The refusal "all freighters in fleet '<p>' are assigned" goes away. `scheduler.max_concurrent_ships` and `scheduler.per_provider_max` are the only limits on how many fly.
- Every "is there an idle ship" precheck goes: the limiter's (`limiter.ts`, including the `claimed` set and `shipId` in its capacity bookkeeping), and the ones in `delivery.ts` and `customs.ts`.
- A roster grows per provider, job and weight until it matches the most ships of that kind ever held at once (in flight, or holding with cargo until docked), then stops.
- **Open deliveries need their own cap (§7.9).** Today the six freighters per provider are the only bound on moons that have been sent to but not yet docked. That bound disappears with the fixed fleet.
- An `adrift` or `quarantined` ship stays unavailable, as today. `fleet retire` still retires only an idle ship; a retired ship's name is never reused.
- `nexus init` no longer registers a fleet up front.
- The config keys `fleet.freighters`, `fleet.customs`, `fleet.carriers`, `fleet.surveyors` are still accepted, so existing configs load, but have no effect. `fleet.name_theme` and `fleet.seed` keep their meaning for planet and moon names; `fleet.seed` also seeds ship picks (§7.3).

### 7.3 Catalogue

Built-in catalogue: a typed data module in `src/core/catalogue/`. Owner's additions: `.nexus/catalogue.json`, optional, same shape. Entries from the owner's file are added to the built-in ones; an entry with the same `id` replaces the built-in one. The file is read when a galaxy is opened; an invalid file is reported the way an invalid config is, naming the path and the entry.

```jsonc
{
  "weights": ["light", "standard", "heavy"],            // ordered, lightest first
  "formations": [
    { "id": "carrier-group", "name": "Carrier group", "job": "delivery", "weights": ["heavy"],
      "vessels": [ { "hull": "carrier", "count": 1, "role": "lead" }, { "hull": "frigate", "count": 4, "role": "escort" } ],
      "factions": [],                                    // optional; empty or absent = any faction
      "art": null }                                      // optional; reserved, unread
  ],
  "cargo": [ { "id": "diplomat", "label": "a diplomat", "weights": ["heavy"] } ],
  "names": { "<faction>": { "pools": { "<pool>": ["..."] }, "patterns": ["{adjective} {noun}"] } }
}
```

- `weights` on a formation or cargo entry lists the weights it applies to; empty or absent means every weight.
- Picking a formation: the candidates are the entries matching the job, the weight and the faction. One is chosen with the seeded generator already used for names (`mulberry32`), seeded from `fleet.seed` and the number of ships commissioned so far, so the same galaxy history gives the same picks and tests are deterministic.
- Merging the owner's file: `formations` and `cargo` merge by `id`; an owner's `weights` list replaces the built-in list whole; an owner's `names.<faction>` replaces that faction's rules whole.
- The order of `weights` is for display only (sorting the fleet panel). There is no nearest-weight fallback: a ship is never taken for a trip of another weight.
- If there is no candidate, the built-in fallback is used: `{ id: "plain", name: "Ship", vessels: [{ hull: "ship", count: 1, role: "lead" }] }`. A trip is never refused for want of a formation.
- Starter content shipped with the app (the owner will extend it): light — mining vessel, courier; standard — freighter, freighter with escort; heavy — carrier group, freighter convoy, heavy freighter with military escort; customs — customs cutter (every weight). Cargo: light — ore samples, spare parts; standard — trade goods, machine tools; heavy — a diplomat, precious cargo, relief supplies.

### 7.4 Names

Names stay offline and seeded. Each faction may define its own rules in the catalogue: named pools of words and patterns that combine them. A faction with no rules uses the existing `name_theme` ship list.

- A name is unique across all ships for the life of the galaxy (`ships.name` is already UNIQUE). A ship keeps its name; "reusing a name" means reusing the ship once it is idle again.
- When a pattern's combinations are exhausted, the existing suffix rule applies (`-II`, `-III`, …).
- Starter rules: the two default factions get distinct word pools so their names sound different. The owner will replace these as the design languages are worked out.

### 7.5 Weight and faction

- `providers.<id>.faction`: string, optional, default the provider id. Default config: `codex` → `openai`, `claude` → `anthropic`, `fake` → `fake`.
- `providers.<id>.weights`: optional map to a weight, keyed by a model id, a tier name, or the word `default`. Lookup, first hit wins:
  1. the model id, when the voyage is told which model to fly (a refuel, or `providers.<id>.models[tier]`);
  2. the moon's tier name, only for a delivery and only when no model id was given in step 1;
  3. `default` — what the provider flies when it chooses the model itself;
  4. `standard`.
- Customs voyages skip step 2: the moon's tier describes the delivery, not the reviewer.
- Default config: `codex` `{ sol: heavy, terra: standard, luna: light }`; `claude` `{ default: heavy, "claude-haiku-5-5": light }` (Claude flies its frontier model unless told otherwise).
- Known limit: weight is read from what the Nexus told the adapter, not from what the adapter reports back. A provider with an unusual `models` map needs its `weights` written to match.
- A weight named in config that the catalogue does not list is a config error at load.
- A refuelled delivery flies another provider's cheaper model, so it resolves that provider's faction and, by step 1, that model's weight. `runVoyage` has the refuel model already.
- A ship keeps the faction it was commissioned with. If a provider's `faction` is changed later, its older ships keep flying for it under their old faction; the pick matches fleet, job and weight only.

### 7.6 Cargo

For a delivery, one cargo entry matching the voyage's weight is picked with the same seeded generator (seeded per voyage, so consecutive trips differ) and written into `voyage.launched` as `cargo: { id, label }`. No matching entry → `cargo` is absent and the Bridge shows nothing for it. Customs voyages carry no cargo. A FIX round or a pickup is a new voyage and draws its own cargo.

### 7.7 Migration 003 and old logs

- `ships` is rebuilt (SQLite cannot rename a CHECK in place; follow 002's set-aside-and-refill method): `class` becomes `job` with the mapping in §2; `faction` = the row's `fleet`; `weight` = `standard`; `formation` = the legacy formation for the job (`{ id: "legacy-<job>", name: "Freighter" | "Customs cutter" | "Carrier" | "Surveyor", vessels: [one lead hull] }`).
- `voyages` gains the nullable `cargo` column.
- The `ship.registered` reducer stays, for logs written before this change, and produces exactly the row the migration produces from the same event: old class word mapped to job, faction = fleet, weight `standard`, legacy formation. That is what keeps `rebuild` byte-equal on an old galaxy.
- Ships registered before the change stay in the roster as standard-weight ships and are used like any other.

### 7.8 What people see

- **Fleet panel:** grouped by provider; each ship's name, faction, formation name, weight, status and trip count.
- **Voyage rows and moon detail:** name, formation and cargo in a sentence, for example "*Kestrel* — carrier group (anthropic), carrying a diplomat".
- **Wording sweep:** every message, button and comment that uses "freighter" to mean the job says "delivery" or "delivery ship" instead: refusals, the rung selector text, `shipsNoun`, `shipClassFor` (becomes a job lookup), CLI output, `CLAUDE.md`. Historical specs and plans are left as they are.
- **CLI:** `nexus fleet` lists the same columns as the panel.

### 7.9 Open deliveries cap

New config key `scheduler.max_open_deliveries` (positive integer, default 6 per provider, matching today's six freighters): the most moons per provider that may have a delivery ship assigned at once, counting ships in flight and ships holding with cargo. A first delivery, sent by a person or by the scheduler, is refused or held when the provider is at the cap; fix rounds and pickups for moons already counted are not. The scheduler treats it as capacity, like the other caps, not as a reason to park.

## 8. Constraints

- Node ≥ 22.13, `node:sqlite`, no new dependencies. SQL only in `src/db/statements.ts`.
- `src/db/migrations/**` and `src/server/dispatch.ts` are security-routed: that work is done with the owner present, never unattended.
- Tests cannot spend a real pool (`makeGalaxy` guard); they pin `c.roles` to fake providers.
- The log is append-only. No existing event is rewritten.

## 9. What must be tested

1. Migration from schema 2 with an existing fleet: every ship keeps its id, name, status and trip count; job, faction, weight and formation are as §7.7 says.
2. `rebuild` on a pre-change log and on a post-change log leaves `dumpProjections` byte-equal.
3. A delivery with no idle ship of its weight commissions one; a second delivery sent after the first ship is released (docked) reuses that ship; two held at once give two ships.
4. A heavy ship is never taken for a light job, and the reverse.
5. The same seed and history give the same formation, name and cargo.
6. A refused launch (cap reached inside the transaction) leaves no `ship.commissioned` behind.
7. A refuelled delivery flies a ship of the refuel provider's faction and the refuel model's weight.
8. A catalogue with no entry for a job and weight still flies, with the plain formation.
9. An owner's catalogue entry is used; one with a built-in `id` replaces it; an invalid file is refused with its path.
10. Editing the catalogue after a ship is commissioned does not change that ship.
11. With more deliveries ready than `max_concurrent_ships`, the cap holds and no "all ships assigned" refusal appears.
12. With `max_open_deliveries` reached, a first delivery to another moon is held; a fix round for a counted moon still flies; docking one frees a place.
13. Weight lookup: a refuel model resolves by model id; a default Claude review resolves by `default`; a tier name is not used when a model id was given.

## 10. Left to the builder

- The module layout inside `src/core/catalogue/` and the validator's shape.
- The exact starter word pools and patterns for the two default factions.
- How the seed is combined with the commission count.
- Layout of the fleet panel and the voyage sentence, within the existing Bridge style.
- Task split and order, provided the security-routed pieces are separate tasks.

## 11. Calls made by the author (the owner did not decide these)

- Job words `transfer` and `survey` for the two reserved classes.
- Legacy ships become standard weight with a legacy formation, and stay in use.
- The old `fleet.*` count keys are accepted and ignored instead of becoming errors.
- Faction defaults to the provider id; default names `openai` and `anthropic`.
- Customs ships use the same mechanism, with one starter formation for every weight.
- The moon-side words (`dropped`, `drop`) are left for a later change.
- The owner's catalogue file is read when a galaxy is opened, so a running server needs a restart to see an edit.
- Weight lookup order and the `default` key (§7.5); customs weight follows the reviewer's model.
- Merge rules for the owner's catalogue file; weight order is display-only.
- A ship keeps its faction when the provider's faction is renamed.
- `max_open_deliveries` replaces the bound the fixed fleet used to give (§7.9). **Pending the owner's answer.**
