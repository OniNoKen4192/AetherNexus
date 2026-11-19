import test from "node:test";
import assert from "node:assert/strict";
import { worldWithMoon } from "../fixtures/world.mjs";
import { append } from "../../dist/db/events.js";
import { rebuild, dumpProjections } from "../../dist/db/rebuild.js";
import { sendDelivery } from "../../dist/server/commands/delivery.js";
import { sendCustoms } from "../../dist/server/commands/customs.js";
import { loadMoon } from "../../dist/server/dispatch.js";

const iso = (ms = 0) => new Date(Date.now() + ms).toISOString();
function config(c, probe = false) {
  c.providers.fake.pool = { kind: "window", reserve_floor: 0.1 };
  if (probe) c.providers.probe = { adapter: "fake", pool: { kind: "window", reserve_floor: 0.1 } };
  c.roles = { implement: ["fake"], review: probe ? ["fake", "probe"] : ["fake"] };
  c.fleet.customs = 2;
  c.automation = { level: "manual", max_fix_rounds: 2 };
}
function low(w) { append(w.g.db, { kind: "fuel.reading", provider: "fake", payload: { window: "5h", used: 0.95, resets_at: iso(3_600_000), source: "reported" } }); }
function dry(w) { append(w.g.db, { kind: "fuel.exhausted", provider: "fake", payload: { until: iso(3_600_000), voyage_id: "prior" } }); }
function stable(w) { const before = dumpProjections(w.g.db); rebuild(w.g.db); assert.equal(dumpProjections(w.g.db), before); }

test("13. customs is not held by a low pool", async () => {
  const w = await worldWithMoon("happy", (c) => config(c));
  try { await sendDelivery(w.g, { taskId: "T1" }); low(w); const r = await sendCustoms(w.g, { taskId: "T1" }); assert.equal(r.verdict.verdict, "APPROVE"); } finally { w.cleanup(); }
});

test("14. customs is held by a dry pool unless overridden", async () => {
  const w = await worldWithMoon("happy", (c) => config(c));
  try { await sendDelivery(w.g, { taskId: "T1" }); dry(w); const before = w.g.db.get("events.maxId").id; await assert.rejects(sendCustoms(w.g, { taskId: "T1" }), (e) => { assert.match(e.message, /is waiting on fake fuel \(dry\)/); assert.equal(e.details.can_refuel, null); return true; }); assert.equal(loadMoon(w.g, "T1").status, "audited"); assert.ok(w.g.db.all("ships.all").filter((s) => s.class === "customs").every((s) => s.status === "idle")); assert.equal(w.g.db.get("events.maxId").id, before); assert.equal((await sendCustoms(w.g, { taskId: "T1", override: true })).verdict.verdict, "APPROVE"); } finally { w.cleanup(); }
});

test("15. customs reroutes around a dry pool", async () => {
  const w = await worldWithMoon("happy", (c) => config(c, true));
  try { await sendDelivery(w.g, { taskId: "T1" }); dry(w); const r = await sendCustoms(w.g, { taskId: "T1" }); assert.equal(w.g.db.get("voyages.byId", { id: r.voyageId }).provider, "probe"); } finally { w.cleanup(); }
});

test("16. the fix cap counts FIX verdicts rather than round numbers", async () => {
  const w = await worldWithMoon("wall", (c) => config(c));
  try {
    assert.equal((await sendDelivery(w.g, { taskId: "T1" })).moonStatus, "awaiting_pickup");
    await sendDelivery(w.g, { taskId: "T1", override: true });
    const first = await sendCustoms(w.g, { taskId: "T1", override: true, reviewScript: "review-fix" });
    assert.equal(first.moonStatus, "audited"); assert.equal(loadMoon(w.g, "T1").park_reason, null);
    const adapter = w.g.adapters.fake;
    w.g.adapters.fake = { ...adapter, async *dispatch(job, ctx) { if (job.role === "implement") { yield { kind: "done", ts: iso(), data: { report: { status: "IMPLEMENTED", raw: "STATUS: IMPLEMENTED" } } }; } else yield* adapter.dispatch(job, ctx); } };
    await sendDelivery(w.g, { taskId: "T1", override: true });
    const second = await sendCustoms(w.g, { taskId: "T1", override: true, reviewScript: "review-fix" });
    assert.equal(second.moonStatus, "adrift"); assert.equal(loadMoon(w.g, "T1").park_reason, "max_fix_rounds"); stable(w);
  } finally { w.cleanup(); }

  const plain = await worldWithMoon("fix-round", (c) => config(c));
  try { await sendDelivery(plain.g, { taskId: "T1" }); assert.equal((await sendCustoms(plain.g, { taskId: "T1", reviewScript: "review-fix" })).moonStatus, "audited"); await sendDelivery(plain.g, { taskId: "T1" }); const r = await sendCustoms(plain.g, { taskId: "T1", reviewScript: "review-fix" }); assert.equal(r.moonStatus, "adrift"); assert.equal(loadMoon(plain.g, "T1").park_reason, "max_fix_rounds"); stable(plain); } finally { plain.cleanup(); }
});
