export const STATEMENTS = {
  "meta.get": "SELECT value FROM meta WHERE key = @key",
  "meta.set": "INSERT OR REPLACE INTO meta(key, value) VALUES (@key, @value)",
  "events.insert": "INSERT INTO events(ts, kind, system_id, planet_id, moon_id, voyage_id, ship_id, provider, payload) VALUES (@ts, @kind, @system_id, @planet_id, @moon_id, @voyage_id, @ship_id, @provider, @payload)",
  "events.byId": "SELECT * FROM events WHERE id = @id",
  "events.since": "SELECT * FROM events WHERE id > @id ORDER BY id",
  "events.all": "SELECT * FROM events ORDER BY id",
  "events.byMoon": "SELECT * FROM events WHERE moon_id = @moon_id ORDER BY id",
  "stats.upsert": "INSERT INTO query_stats(name, sql, calls, total_ms, max_ms, last_rows, last_ts) VALUES (@name, @sql, 1, @ms, @ms, @rows, @ts) ON CONFLICT(name) DO UPDATE SET calls = calls + 1, total_ms = total_ms + excluded.total_ms, max_ms = MAX(max_ms, excluded.max_ms), last_rows = excluded.last_rows, last_ts = excluded.last_ts",
  "stats.all": "SELECT * FROM query_stats ORDER BY total_ms DESC",
  "stats.clear": "DELETE FROM query_stats",
} as const satisfies Record<string, string>;
export type StatementName = keyof typeof STATEMENTS;
