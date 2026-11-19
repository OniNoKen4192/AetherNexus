// Migration 002 widens two status lists (moons: awaiting_pickup; voyages: out_of_fuel) and must change nothing else.
// The first two tests run 002's SQL by hand on a schema-1 file, so they keep testing 002 alone whatever migrations follow it.
import assert from "node:assert/strict"; import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "../../dist/db/open.js";
import { sendDelivery } from "../../dist/server/commands/delivery.js"; import { sendCustoms } from "../../dist/server/commands/customs.js"; import { dockCargo } from "../../dist/server/commands/dock.js";
import { worldWithMoon } from "../fixtures/world.mjs";
import { copyRowsDown, holdingTables, indexes, migrationSql, oldSchemaFile, rawDump, tableSql } from "../fixtures/old-schema.mjs";

function run002(file) {
  const raw = new DatabaseSync(file); raw.exec("PRAGMA foreign_keys = ON");
  raw.exec("BEGIN IMMEDIATE"); raw.exec(migrationSql(2)); raw.exec("COMMIT");
  return raw;
}

test("002 keeps every projection row of a schema-1 database", async () => {
  // a real lifecycle (a FIX round, then settled) so every projection table has rows, with voyages and verdicts pointing at the moon
  const w = await worldWithMoon("fix-round");
  await sendDelivery(w.g, { taskId: "T1" }); await sendCustoms(w.g, { taskId: "T1", reviewScript: "review-fix" });
  await sendDelivery(w.g, { taskId: "T1" }); await sendCustoms(w.g, { taskId: "T1" }); dockCargo(w.g, { taskId: "T1" });
  const file = oldSchemaFile(1, (raw) => copyRowsDown(w.g.db.raw, raw));
  const old = new DatabaseSync(file); const before = rawDump(old); const events = old.prepare("SELECT * FROM events ORDER BY id").all(); old.close();
  for (const t of ["moons", "voyages", "verdicts", "ships", "planets", "systems"]) assert.ok(before[t].length > 0, `${t} has rows`);

  const raw = run002(file);
  assert.deepEqual(rawDump(raw), before);
  assert.deepEqual(raw.prepare("SELECT * FROM events ORDER BY id").all(), events, "the log is untouched");
  assert.deepEqual(raw.prepare("PRAGMA foreign_key_check").all(), []);
  assert.deepEqual(holdingTables(raw), [], "no holding table is left behind");
  raw.close(); w.cleanup();
});

test("002 changes only the two status lists", () => {
  const old = new DatabaseSync(oldSchemaFile(1)); const raw = run002(oldSchemaFile(1));
  const widen = (sql, from, to) => { assert.ok(sql.includes(from), `001 has ${from}`); return sql.replace(from, to); };
  assert.equal(tableSql(raw, "moons"), widen(tableSql(old, "moons"), "'quarantined','dropped')", "'quarantined','dropped','awaiting_pickup')"));
  assert.equal(tableSql(raw, "voyages"), widen(tableSql(old, "voyages"), "'adrift','quarantined')", "'adrift','quarantined','out_of_fuel')"));
  for (const t of ["events", "systems", "planets", "ships", "verdicts", "decisions", "query_stats"]) assert.equal(tableSql(raw, t), tableSql(old, t), t);
  assert.deepEqual(indexes(raw), indexes(old));
  old.close(); raw.close();
});

test("after 002 a moon may be awaiting_pickup and a voyage out_of_fuel", async () => {
  const w = await worldWithMoon("happy"); await sendDelivery(w.g, { taskId: "T1" });
  const db = openDb(oldSchemaFile(1, (raw) => copyRowsDown(w.g.db.raw, raw)));
  assert.equal(db.raw.prepare("UPDATE moons SET status='awaiting_pickup' WHERE task_id='T1'").run().changes, 1);
  assert.equal(db.raw.prepare("UPDATE voyages SET status='out_of_fuel' WHERE task_id='T1'").run().changes, 1);
  assert.throws(() => db.raw.prepare("UPDATE moons SET status='nonsense' WHERE task_id='T1'").run(), /CHECK constraint failed/);
  assert.throws(() => db.raw.prepare("UPDATE voyages SET status='nonsense' WHERE task_id='T1'").run(), /CHECK constraint failed/);
  db.close(); w.cleanup();
});

test("002 leaves foreign keys intact", async () => {
  const w = await worldWithMoon("happy"); await sendDelivery(w.g, { taskId: "T1" }); await sendCustoms(w.g, { taskId: "T1" });
  const db = openDb(oldSchemaFile(1, (raw) => copyRowsDown(w.g.db.raw, raw)));
  assert.deepEqual(db.raw.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(db.raw.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  // a voyage naming a moon that does not exist is still refused; so is a verdict naming a voyage that does not exist
  assert.throws(() => db.raw.prepare("UPDATE voyages SET moon_id='no-such-moon'").run(), /FOREIGN KEY constraint failed/);
  assert.throws(() => db.raw.prepare("UPDATE verdicts SET voyage_id='no-such-voyage'").run(), /FOREIGN KEY constraint failed/);
  // and a moon that voyages point at cannot be deleted
  assert.throws(() => db.raw.prepare("DELETE FROM moons WHERE task_id='T1'").run(), /FOREIGN KEY constraint failed/);
  db.close(); w.cleanup();
});
