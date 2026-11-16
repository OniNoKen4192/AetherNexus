// Migration 002 widens two status lists (moons: awaiting_pickup; voyages: out_of_fuel) and must change nothing else.
import assert from "node:assert/strict"; import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "../../dist/db/open.js";
import { dumpProjections, PROJECTION_TABLES } from "../../dist/db/rebuild.js";
import { launchMoon } from "../../dist/server/commands/launch.js"; import { inspectMoon } from "../../dist/server/commands/review.js"; import { dockMoon } from "../../dist/server/commands/dock.js";
import { worldWithMoon } from "../fixtures/world.mjs";
import { read, tmpDb } from "../helpers.mjs";

const SQL_001 = read("src/db/migrations/001.sql");
// insert order respects foreign keys (the reverse of the delete order)
const COPY_ORDER = ["events", ...[...PROJECTION_TABLES].reverse()];

/** A database file exactly as schema 1 left it, optionally filled by `fill(raw)`. */
function schema1File(fill) {
  const file = tmpDb();
  const raw = new DatabaseSync(file);
  raw.exec("PRAGMA foreign_keys = ON");
  raw.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  raw.exec(SQL_001); raw.exec("INSERT INTO meta VALUES ('schema_version','1')");
  if (fill) fill(raw);
  raw.close(); return file;
}
function copyRows(from, to) {
  for (const t of COPY_ORDER) {
    const rows = from.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all();
    for (const r of rows) {
      const cols = Object.keys(r);
      to.prepare(`INSERT INTO ${t} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...cols.map((c) => r[c]));
    }
  }
}
const tableSql = (raw, name) => raw.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name).sql;

test("002 keeps every projection row of a schema-1 database", async () => {
  // a real lifecycle (a FIX round, then settled) so every projection table has rows, with voyages and verdicts pointing at the moon
  const w = await worldWithMoon("fix-round");
  await launchMoon(w.g, { taskId: "T1" }); await inspectMoon(w.g, { taskId: "T1", reviewScript: "review-fix" });
  await launchMoon(w.g, { taskId: "T1" }); await inspectMoon(w.g, { taskId: "T1" }); dockMoon(w.g, { taskId: "T1" });
  const before = dumpProjections(w.g.db);
  for (const t of ["moons", "voyages", "verdicts", "ships", "planets", "systems"]) assert.ok(JSON.parse(before)[t].length > 0, `${t} has rows`);
  const events = w.g.db.raw.prepare("SELECT * FROM events ORDER BY id").all();

  const file = schema1File((raw) => copyRows(w.g.db.raw, raw));
  const db = openDb(file);
  assert.equal(db.raw.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, "2");
  assert.equal(dumpProjections(db), before);
  assert.deepEqual(db.raw.prepare("SELECT * FROM events ORDER BY id").all(), events, "the log is untouched");
  assert.deepEqual(db.raw.prepare("PRAGMA foreign_key_check").all(), []);
  assert.deepEqual(db.raw.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%\\_hold' ESCAPE '\\'").all(), [], "no holding table is left behind");
  db.close(); w.cleanup();
});

test("002 changes only the two status lists", () => {
  const old = new DatabaseSync(schema1File()); const db = openDb(schema1File());
  const widen = (sql, from, to) => { assert.ok(sql.includes(from), `001 has ${from}`); return sql.replace(from, to); };
  assert.equal(tableSql(db.raw, "moons"), widen(tableSql(old, "moons"), "'quarantined','dropped')", "'quarantined','dropped','awaiting_pickup')"));
  assert.equal(tableSql(db.raw, "voyages"), widen(tableSql(old, "voyages"), "'adrift','quarantined')", "'adrift','quarantined','out_of_fuel')"));
  for (const t of ["events", "systems", "planets", "ships", "verdicts", "decisions", "query_stats"]) assert.equal(tableSql(db.raw, t), tableSql(old, t), t);
  const indexes = (raw) => raw.prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type='index' ORDER BY name").all();
  assert.deepEqual(indexes(db.raw), indexes(old));
  old.close(); db.close();
});

test("after 002 a moon may be awaiting_pickup and a voyage out_of_fuel", async () => {
  const w = await worldWithMoon("happy"); await launchMoon(w.g, { taskId: "T1" });
  const db = openDb(schema1File((raw) => copyRows(w.g.db.raw, raw)));
  assert.equal(db.raw.prepare("UPDATE moons SET status='awaiting_pickup' WHERE task_id='T1'").run().changes, 1);
  assert.equal(db.raw.prepare("UPDATE voyages SET status='out_of_fuel' WHERE task_id='T1'").run().changes, 1);
  assert.throws(() => db.raw.prepare("UPDATE moons SET status='nonsense' WHERE task_id='T1'").run(), /CHECK constraint failed/);
  assert.throws(() => db.raw.prepare("UPDATE voyages SET status='nonsense' WHERE task_id='T1'").run(), /CHECK constraint failed/);
  db.close(); w.cleanup();
});

test("002 leaves foreign keys intact", async () => {
  const w = await worldWithMoon("happy"); await launchMoon(w.g, { taskId: "T1" }); await inspectMoon(w.g, { taskId: "T1" });
  const db = openDb(schema1File((raw) => copyRows(w.g.db.raw, raw)));
  assert.deepEqual(db.raw.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(db.raw.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  // a voyage naming a moon that does not exist is still refused; so is a verdict naming a voyage that does not exist
  assert.throws(() => db.raw.prepare("UPDATE voyages SET moon_id='no-such-moon'").run(), /FOREIGN KEY constraint failed/);
  assert.throws(() => db.raw.prepare("UPDATE verdicts SET voyage_id='no-such-voyage'").run(), /FOREIGN KEY constraint failed/);
  // and a moon that voyages point at cannot be deleted
  assert.throws(() => db.raw.prepare("DELETE FROM moons WHERE task_id='T1'").run(), /FOREIGN KEY constraint failed/);
  db.close(); w.cleanup();
});

test("a fresh database arrives at schema 2 and an already-migrated one is left alone", () => {
  const f = tmpDb(); const a = openDb(f); const sql = tableSql(a.raw, "moons"); a.close();
  const b = openDb(f);
  assert.equal(b.raw.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, "2");
  assert.equal(tableSql(b.raw, "moons"), sql); b.close();
});
