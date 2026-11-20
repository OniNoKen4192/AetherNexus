// Migration 003: a ship's class becomes its job and it gains faction, weight and formation; a voyage gains cargo.
// Nothing else about either table may change, and the rows it writes must be the rows the `ship.registered` reducer writes.
import assert from "node:assert/strict"; import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "../../dist/db/open.js";
import { append } from "../../dist/db/events.js";
import { legacyShip } from "../../dist/core/fleet.js";
import { dumpProjections, rebuild } from "../../dist/db/rebuild.js";
import { sendDelivery } from "../../dist/server/commands/delivery.js"; import { sendCustoms } from "../../dist/server/commands/customs.js"; import { dockCargo } from "../../dist/server/commands/dock.js";
import { seedFleet, worldWithMoon } from "../fixtures/world.mjs";
import { copyRowsDown, holdingTables, indexes, migrationSql, oldSchemaFile, rawDump, schemaVersion, tableSql } from "../fixtures/old-schema.mjs";
import { tmpDb } from "../helpers.mjs";

const OLD_CLASS = { delivery: "freighter", customs: "customs", transfer: "carrier", survey: "surveyor" };
/** What 003 must make of a ship row: everything kept, the identity columns set to the legacy values. */
function asLegacy(ship) {
  const legacy = legacyShip({ id: ship.id, name: ship.name, class: OLD_CLASS[ship.job], fleet: ship.fleet });
  return { ...ship, job: legacy.job, faction: ship.fleet, weight: "standard", formation: JSON.stringify(legacy.formation) };
}

test("003 keeps every ship, voyage and verdict of a schema-2 database", async () => {
  // a real lifecycle (a FIX round, then settled): voyages point at ships, verdicts at voyages, ships have flown
  const w = await worldWithMoon("fix-round");
  await sendDelivery(w.g, { taskId: "T1" }); await sendCustoms(w.g, { taskId: "T1", reviewScript: "review-fix" });
  await sendDelivery(w.g, { taskId: "T1" }); await sendCustoms(w.g, { taskId: "T1" }); dockCargo(w.g, { taskId: "T1" });
  const before = rawDump(w.g.db.raw);
  for (const t of ["moons", "voyages", "verdicts", "ships", "planets", "systems"]) assert.ok(before[t].length > 0, `${t} has rows`);
  assert.ok(before.ships.some((s) => s.voyage_count > 0), "a ship has flown");
  const events = w.g.db.raw.prepare("SELECT * FROM events ORDER BY id").all();
  const expected = { ...before, ships: before.ships.map(asLegacy), voyages: before.voyages.map((v) => ({ ...v, cargo: null })) };

  const db = openDb(oldSchemaFile(2, (raw) => copyRowsDown(w.g.db.raw, raw)));
  assert.equal(schemaVersion(db.raw), "3");
  assert.equal(JSON.stringify(rawDump(db.raw), null, 1), JSON.stringify(expected, null, 1));
  assert.deepEqual(db.raw.prepare("SELECT * FROM events ORDER BY id").all(), events, "the log is untouched");
  assert.deepEqual(db.raw.prepare("PRAGMA foreign_key_check").all(), []);
  assert.deepEqual(holdingTables(db.raw), [], "no holding table is left behind");
  db.close(); w.cleanup();
});

test("003 writes the rows the ship.registered reducer writes: every class, every status, order kept", () => {
  // Built with today's reducers from the events an old galaxy holds, then stored the old way and migrated.
  const cur = openDb(tmpDb()); const ships = seedFleet(cur, ["zeta", "alpha"]);   // two fleets, not in alphabetical order
  const of = (fleet, cls) => ships.filter((s) => s.fleet === fleet && s.class === cls).map((s) => s.id);
  const [f1, f2] = of("zeta", "freighter");
  append(cur, { kind: "ship.adrift", ship_id: f1, payload: { voyage_id: "v" } });
  append(cur, { kind: "ship.released", ship_id: f2, payload: { voyage_id: "v", outcome: "docked" } });
  append(cur, { kind: "ship.quarantined", ship_id: of("zeta", "customs")[0], payload: { voyage_id: "v" } });
  append(cur, { kind: "ship.retired", ship_id: of("alpha", "carrier")[0], payload: { reason: "human" } });
  append(cur, { kind: "ship.released", ship_id: of("alpha", "surveyor")[0], payload: { voyage_id: "v", outcome: "superseded" } });
  const want = dumpProjections(cur);
  const rows = JSON.parse(want).ships;
  assert.deepEqual([...new Set(rows.map((s) => s.job))].sort(), ["customs", "delivery", "survey", "transfer"]);
  assert.deepEqual([...new Set(rows.map((s) => s.status))].sort(), ["adrift", "idle", "quarantined", "retired"]);
  for (const s of rows) {
    assert.equal(s.faction, s.fleet); assert.equal(s.weight, "standard");
    const f = JSON.parse(s.formation); assert.equal(f.id, `legacy-${s.job}`); assert.deepEqual(f.vessels.map((v) => [v.count, v.role]), [[1, "lead"]]);
  }
  assert.deepEqual(rows.filter((s) => s.job === "delivery").map((s) => JSON.parse(s.formation).name), Array(4).fill("Freighter"));

  const db = openDb(oldSchemaFile(2, (raw) => copyRowsDown(cur.raw, raw)));
  assert.equal(dumpProjections(db), want, "the migration and the reducer agree byte for byte");
  rebuild(db);
  assert.equal(dumpProjections(db), want, "and a rebuild of the migrated database changes nothing");
  cur.close(); db.close();
});

test("003 changes only ships and adds one column to voyages", () => {
  const old = new DatabaseSync(oldSchemaFile(2)); const db = openDb(oldSchemaFile(2));
  const ships = tableSql(db.raw, "ships");
  assert.match(ships, /job TEXT NOT NULL CHECK \(job IN \('delivery','customs','transfer','survey'\)\)/);
  assert.doesNotMatch(ships, /\bclass\b/);
  assert.deepEqual(db.raw.prepare("PRAGMA table_info(ships)").all().map((c) => c.name), ["id", "name", "job", "fleet", "faction", "weight", "formation", "status", "voyage_count", "last_event_id"]);
  assert.equal(tableSql(db.raw, "voyages"), tableSql(old, "voyages").replace(/\)$/, ", cargo TEXT CHECK (cargo IS NULL OR json_valid(cargo)))"));
  for (const t of ["events", "systems", "planets", "moons", "verdicts", "decisions", "query_stats"]) assert.equal(tableSql(db.raw, t), tableSql(old, t), t);
  const named = (raw) => indexes(raw).filter((i) => i.sql !== null);   // automatic indexes are renumbered when a table is rebuilt
  assert.deepEqual(named(db.raw), named(old));
  assert.deepEqual(indexes(db.raw).filter((i) => i.tbl_name === "ships").length, indexes(old).filter((i) => i.tbl_name === "ships").length, "ships keeps its primary key and unique name");
  old.close(); db.close();
});

test("after 003 the new columns are checked and foreign keys still hold", async () => {
  const w = await worldWithMoon("happy"); await sendDelivery(w.g, { taskId: "T1" }); await sendCustoms(w.g, { taskId: "T1" });
  const db = openDb(oldSchemaFile(2, (raw) => copyRowsDown(w.g.db.raw, raw)));
  assert.equal(db.raw.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.throws(() => db.raw.prepare("UPDATE ships SET job='freighter'").run(), /CHECK constraint failed/);
  assert.throws(() => db.raw.prepare("UPDATE ships SET formation='not json'").run(), /CHECK constraint failed/);
  assert.throws(() => db.raw.prepare("UPDATE ships SET faction=NULL").run(), /NOT NULL constraint failed/);
  assert.throws(() => db.raw.prepare("UPDATE voyages SET cargo='not json'").run(), /CHECK constraint failed/);
  assert.ok(db.raw.prepare(`UPDATE voyages SET cargo='{"id":"ore","label":"ore samples"}'`).run().changes > 0);
  // a voyage naming a ship that does not exist is refused; a ship that voyages point at cannot be deleted; a ship's name stays unique
  assert.throws(() => db.raw.prepare("UPDATE voyages SET ship_id='no-such-ship'").run(), /FOREIGN KEY constraint failed/);
  assert.throws(() => db.raw.prepare("DELETE FROM ships WHERE id IN (SELECT ship_id FROM voyages)").run(), /FOREIGN KEY constraint failed/);
  assert.throws(() => db.raw.prepare("UPDATE ships SET name='same'").run(), /UNIQUE constraint failed/);
  assert.throws(() => db.raw.prepare("UPDATE verdicts SET voyage_id='no-such-voyage'").run(), /FOREIGN KEY constraint failed/);
  db.close(); w.cleanup();
});

test("a failure in the middle of 003 leaves the database at schema 2 with every row", async () => {
  const w = await worldWithMoon("happy"); await sendDelivery(w.g, { taskId: "T1" }); await sendCustoms(w.g, { taskId: "T1" });
  // A table 003 does not know about still points at a ship, so `DROP TABLE ships` fails after the rows were set aside and the children emptied.
  const file = oldSchemaFile(2, (raw) => {
    copyRowsDown(w.g.db.raw, raw);
    raw.exec("CREATE TABLE blocker (ship_id TEXT NOT NULL REFERENCES ships(id))");
    raw.exec("INSERT INTO blocker SELECT id FROM ships LIMIT 1");
  });
  const old = new DatabaseSync(file); const before = rawDump(old); const shipsSql = tableSql(old, "ships"); old.close();
  assert.ok(before.voyages.length > 0 && before.verdicts.length > 0);
  assert.throws(() => openDb(file), /FOREIGN KEY constraint failed/);
  const raw = new DatabaseSync(file);
  assert.equal(schemaVersion(raw), "2");
  assert.equal(tableSql(raw, "ships"), shipsSql);
  assert.deepEqual(rawDump(raw), before, "ships, voyages and verdicts are all back");
  assert.deepEqual(holdingTables(raw), []);
  raw.close(); w.cleanup();
});

test("a fresh database arrives at schema 3 and an already-migrated one is left alone", () => {
  const f = tmpDb(); const a = openDb(f); const sql = tableSql(a.raw, "ships"); a.close();
  const b = openDb(f);
  assert.equal(schemaVersion(b.raw), "3");
  assert.equal(tableSql(b.raw, "ships"), sql);
  assert.match(migrationSql(3), /legacy-delivery/);
  b.close();
});
