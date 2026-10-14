import { DatabaseSync, type StatementSync } from "node:sqlite";
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { STATEMENTS, type StatementName } from "./statements.js";

export type Row = Record<string, unknown>;
export type NexusDb = {
  raw: DatabaseSync; statsEnabled: boolean;
  run(name: StatementName, params?: Row): { changes: number; lastInsertRowid: number };
  get<T = Row>(name: StatementName, params?: Row): T | undefined;
  all<T = Row>(name: StatementName, params?: Row): T[];
  transaction<T>(fn: () => T): T;
  close(): void;
};

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

export function openDb(file: string, opts: { stats?: boolean } = {}): NexusDb {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec("PRAGMA journal_mode = WAL");
  raw.exec("PRAGMA foreign_keys = ON");
  raw.exec("PRAGMA busy_timeout = 5000");
  migrate(raw);

  const cache = new Map<string, StatementSync>();
  const stmt = (name: StatementName): StatementSync => {
    let s = cache.get(name);
    if (!s) { const sql = STATEMENTS[name]; if (!sql) throw new Error(`unknown statement '${name}'`); s = raw.prepare(sql); cache.set(name, s); }
    return s;
  };
  const statsEnabled = opts.stats === true;
  const statsStmt = statsEnabled ? raw.prepare(STATEMENTS["stats.upsert"]) : null;
  function timed<T>(name: StatementName, fn: () => T, rows: (r: T) => number): T {
    if (!statsStmt || name.startsWith("stats.")) return fn();
    const t0 = performance.now(); const out = fn(); const ms = performance.now() - t0;
    statsStmt.run({ name, sql: STATEMENTS[name], ms, rows: rows(out), ts: new Date().toISOString() });
    return out;
  }
  const db: NexusDb = {
    raw, statsEnabled,
    run: (n, p = {}) => timed(n, () => { const r = stmt(n).run(p as never); return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }; }, (r) => r.changes),
    get: <T>(n: StatementName, p: Row = {}) => timed(n, () => stmt(n).get(p as never) as T | undefined, (r) => (r ? 1 : 0)),
    all: <T>(n: StatementName, p: Row = {}) => timed(n, () => stmt(n).all(p as never) as T[], (r) => r.length),
    transaction<T>(fn: () => T): T {
      raw.exec("BEGIN IMMEDIATE");
      try { const out = fn(); raw.exec("COMMIT"); return out; }
      catch (err) { try { raw.exec("ROLLBACK"); } catch { /* already rolled back */ } throw err; }
    },
    close: () => { try { raw.exec("PRAGMA optimize"); } catch { /* best effort */ } raw.close(); },
  };
  return db;
}

function migrate(raw: DatabaseSync): void {
  raw.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const cur = Number((raw.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as Row | undefined)?.["value"] ?? 0);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}\.sql$/.test(f)).sort();
  for (const f of files) {
    const n = Number(f.slice(0, 3)); if (n <= cur) continue;
    raw.exec("BEGIN IMMEDIATE");
    try {
      raw.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8"));
      raw.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('schema_version', ?)").run(String(n));
      raw.exec("COMMIT");
    } catch (e) { raw.exec("ROLLBACK"); throw e; }
  }
}
