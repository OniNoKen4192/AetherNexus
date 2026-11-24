// Database files as an older schema left them, for migration tests. Rows come from a galaxy built by today's code and are
// written back in the old shape, so these helpers are the one place that knows how today's columns map to yesterday's.
import { DatabaseSync } from "node:sqlite";
import { PROJECTION_TABLES } from "../../dist/db/rebuild.js";
import { read, tmpDb } from "../helpers.mjs";

export const migrationSql = (n) => read(`src/db/migrations/${String(n).padStart(3, "0")}.sql`);
// insert order respects foreign keys (the reverse of the delete order)
const COPY_ORDER = ["events", ...[...PROJECTION_TABLES].reverse()];
const OLD_CLASS = { delivery: "freighter", customs: "customs", transfer: "carrier", survey: "surveyor" };

/** A row of today's schema as schema 1 and 2 stored it: a ship had a class and nothing else; a voyage had no cargo. */
function oldRow(table, row) {
  if (table === "ships") { const { job, faction, weight, formation, ...rest } = row; return { id: rest.id, name: rest.name, class: OLD_CLASS[job], fleet: rest.fleet, status: rest.status, voyage_count: rest.voyage_count, last_event_id: rest.last_event_id }; }
  if (table === "voyages") { const { cargo, ...rest } = row; return rest; }
  return row;
}

/** A database file exactly as schema `version` (1 or 2) left it, optionally filled by `fill(raw)`. */
export function oldSchemaFile(version, fill) {
  const file = tmpDb();
  const raw = new DatabaseSync(file);
  raw.exec("PRAGMA foreign_keys = ON");
  raw.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  for (let n = 1; n <= version; n++) raw.exec(migrationSql(n));
  raw.prepare("INSERT INTO meta VALUES ('schema_version', ?)").run(String(version));
  if (fill) fill(raw);
  raw.close(); return file;
}

/** Copy the log and every projection row of a current database (`from`, a raw handle) into an old-schema one. */
export function copyRowsDown(from, to) {
  for (const t of COPY_ORDER) {
    for (const current of from.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()) {
      const r = oldRow(t, current); const cols = Object.keys(r);
      to.prepare(`INSERT INTO ${t} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...cols.map((c) => r[c]));
    }
  }
}

/** Every projection row of a raw handle, whatever its schema. */
export function rawDump(raw) {
  const out = {};
  for (const t of [...PROJECTION_TABLES].sort()) out[t] = raw.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all();
  return out;
}
export const tableSql = (raw, name) => raw.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name).sql;
export const indexes = (raw) => raw.prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type='index' ORDER BY name").all();
export const schemaVersion = (raw) => raw.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value;
export const holdingTables = (raw) => raw.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%\\_hold' ESCAPE '\\'").all();
