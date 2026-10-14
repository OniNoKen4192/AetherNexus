import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../../dist/db/open.js";
import { tmpDb } from "../helpers.mjs";

test("openDb runs migrations, sets WAL/foreign_keys/busy_timeout, records schema_version", () => {
  const db = openDb(tmpDb());
  assert.equal(db.raw.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  assert.equal(db.raw.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.equal(db.raw.prepare("PRAGMA busy_timeout").get().timeout, 5000);
  assert.equal(db.get("meta.get", { key: "schema_version" }).value, "1");
  const tables = db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
  for (const t of ["events","systems","planets","moons","ships","voyages","verdicts","decisions","query_stats","meta"]) assert.ok(tables.includes(t), t);
  db.close();
});

test("openDb is idempotent (second open does not re-run 001)", () => {
  const f = tmpDb(); openDb(f).close(); const db = openDb(f);
  assert.equal(db.get("meta.get", { key: "schema_version" }).value, "1"); db.close();
});

test("transaction rolls back on throw", () => {
  const db = openDb(tmpDb());
  assert.throws(() => db.transaction(() => { db.run("meta.set", { key: "x", value: "1" }); throw new Error("boom"); }), /boom/);
  assert.equal(db.get("meta.get", { key: "x" }), undefined); db.close();
});

test("query_stats records calls when enabled, nothing when disabled", () => {
  const off = openDb(tmpDb()); off.get("meta.get", { key: "schema_version" });
  assert.equal(off.all("stats.all").length, 0); off.close();
  const on = openDb(tmpDb(), { stats: true }); on.get("meta.get", { key: "schema_version" }); on.get("meta.get", { key: "schema_version" });
  const row = on.all("stats.all").find((r) => r.name === "meta.get");
  assert.equal(row.calls, 2); assert.ok(row.total_ms >= 0); on.close();
});
