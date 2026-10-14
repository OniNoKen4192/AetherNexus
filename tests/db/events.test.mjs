import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../../dist/db/open.js";
import { append, applyEvent } from "../../dist/db/events.js";
import { REDUCERS } from "../../dist/db/reducers/index.js";
import { rebuild, dumpProjections } from "../../dist/db/rebuild.js";
import { tmpDb } from "../helpers.mjs";

test("append writes the row with ts and payload JSON; ids are monotonic", () => {
  const db = openDb(tmpDb());
  REDUCERS["test.noop"] = () => {};
  const a = append(db, { kind: "test.noop", payload: { n: 1 } });
  const b = append(db, { kind: "test.noop", payload: { n: 2 } });
  assert.ok(b.id > a.id); assert.match(a.ts, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.equal(db.get("events.byId", { id: a.id }).payload, JSON.stringify({ n: 1 }));
  delete REDUCERS["test.noop"]; db.close();
});

test("append: precheck failure writes nothing; reducer failure rolls back the event", () => {
  const db = openDb(tmpDb());
  REDUCERS["test.boom"] = () => { throw new Error("reducer boom"); };
  assert.throws(() => append(db, { kind: "test.noop2", payload: {} }, () => { throw new Error("refused"); }), /refused/);
  assert.throws(() => append(db, { kind: "test.boom", payload: {} }), /reducer boom/);
  assert.equal(db.all("events.since", { id: 0 }).length, 0);
  delete REDUCERS["test.boom"]; db.close();
});

test("applyEvent throws on unknown kind", () => {
  const db = openDb(tmpDb());
  assert.throws(() => applyEvent(db, { id: 1, ts: "t", kind: "nope.nope", payload: {} }), /no reducer for 'nope.nope'/);
  db.close();
});

test("rebuild reproduces projections byte-for-byte (smoke until domain reducers land)", () => {
  const db = openDb(tmpDb());
  REDUCERS["test.noop"] = () => {};
  append(db, { kind: "test.noop", payload: {} });
  const before = dumpProjections(db);
  assert.equal(rebuild(db).events, 1);
  assert.equal(dumpProjections(db), before);
  delete REDUCERS["test.noop"]; db.close();
});

test("Review Focus #3: two connections — BEGIN IMMEDIATE serializes writers", () => {
  const f = tmpDb(); const a = openDb(f); const b = openDb(f);
  REDUCERS["test.noop"] = () => {};
  b.raw.exec("PRAGMA busy_timeout = 50");
  a.raw.exec("BEGIN IMMEDIATE");
  assert.throws(() => append(b, { kind: "test.noop", payload: {} }), /SQLITE_BUSY|database is locked/i);
  a.raw.exec("COMMIT");
  append(b, { kind: "test.noop", payload: {} });
  assert.equal(a.all("events.since", { id: 0 }).length, 1);
  delete REDUCERS["test.noop"]; a.close(); b.close();
});
