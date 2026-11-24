// A customs voyage's return and its verdict are two writes. A process that dies between them leaves the moon `reviewing`
// with the verdict only in the voyage's report. That verdict is recorded from the report, without another flight.
// Every galaxy here pins its roles to fake providers.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { worldWithMoon, idleShip } from "../fixtures/world.mjs";
import { append, rowToEvent } from "../../dist/db/events.js";
import { rebuild, dumpProjections } from "../../dist/db/rebuild.js";
import { sendDelivery } from "../../dist/server/commands/delivery.js";
import { sendCustoms } from "../../dist/server/commands/customs.js";
import { availableActions, moonDetail } from "../../dist/server/commands/query.js";
import { loadMoon, moonScope } from "../../dist/server/dispatch.js";
import { planWithHolds } from "../../dist/server/scheduler/plan.js";

const iso = (ms = 0) => new Date(Date.now() + ms).toISOString();
const pin = (extra) => (c) => { c.roles = { implement: ["fake"], review: ["fake"] }; extra?.(c); };
const ctx = { ownPid: process.pid };
const log = (g) => g.db.raw.prepare("SELECT * FROM events ORDER BY id").all().map(rowToEvent);
const voyage = (g, id) => g.db.get("voyages.byId", { id });
function stable(g) { const before = dumpProjections(g.db); rebuild(g.db); assert.equal(dumpProjections(g.db), before); }

/** T1 delivered and audited, then a customs voyage that returned with `report` and no verdict after it: what the crash leaves. */
async function returnedWithoutVerdict(w, report) {
  const delivery = await sendDelivery(w.g, { taskId: "T1" });
  const scope = moonScope(w.g, loadMoon(w.g, "T1"));
  const ship = idleShip(w.g.db, "fake", "customs");
  const voyageId = `${ship.id}/T1/review/1`;
  append(w.g.db, { kind: "voyage.launched", ...scope, voyage_id: voyageId, ship_id: ship.id, provider: "fake", payload: { role: "review", round: 1, provider: "fake", ship_id: ship.id, worktree: "w", owner_pid: 2147483646 } });
  append(w.g.db, { kind: "voyage.returned", ...scope, voyage_id: voyageId, ship_id: ship.id, payload: { role: "review", report } });
  append(w.g.db, { kind: "ship.released", ...scope, voyage_id: voyageId, ship_id: ship.id, payload: { voyage_id: voyageId, outcome: "docked" } });
  assert.deepEqual([loadMoon(w.g, "T1").status, voyage(w.g, voyageId).status], ["reviewing", "docked"]);
  return { deliveryId: delivery.voyageId, voyageId };
}

test("APPROVE left unrecorded: inspect is offered and records it without another flight; the moon can dock", async () => {
  const w = await worldWithMoon("happy", pin());
  try {
    const { deliveryId, voyageId } = await returnedWithoutVerdict(w, { verdict: "APPROVE", reasoning: "ok" });
    assert.deepEqual(availableActions(w.g, "T1", ctx), ["inspect"]);
    const launches = log(w.g).filter((e) => e.kind === "voyage.launched").length;
    const r = await sendCustoms(w.g, { taskId: "T1" });
    assert.deepEqual([r.voyageId, r.verdict.verdict, r.moonStatus], [voyageId, "APPROVE", "reviewing"]);
    assert.equal(log(w.g).filter((e) => e.kind === "voyage.launched").length, launches, "no second customs voyage");
    const issued = log(w.g).filter((e) => e.kind === "verdict.issued");
    assert.equal(issued.length, 1); assert.equal(issued[0].voyage_id, voyageId);
    assert.equal(log(w.g).find((e) => e.id === issued[0].id + 1).kind, "voyage.cleared", "the verdict and what it does to the delivery are one step");
    assert.equal(voyage(w.g, deliveryId).status, "cleared");
    assert.deepEqual(availableActions(w.g, "T1", ctx), ["dock"]);
    await assert.rejects(sendCustoms(w.g, { taskId: "T1" }), /only an 'audited' moon/);
    assert.equal(log(w.g).filter((e) => e.kind === "verdict.issued").length, 1);
    stable(w.g);
  } finally { w.cleanup(); }
});

test("FIX left unrecorded: the delivery is superseded, its ship freed, the spec amended, and the next delivery can be sent", async () => {
  const w = await worldWithMoon("fix-round", pin());
  try {
    const { deliveryId } = await returnedWithoutVerdict(w, { verdict: "FIX", reasoning: "thing is 1", delta_spec: "Set thing = 2 in src/lib/thing.js" });
    const r = await sendCustoms(w.g, { taskId: "T1" });
    assert.deepEqual([r.verdict.verdict, r.moonStatus], ["FIX", "audited"]);
    assert.equal(voyage(w.g, deliveryId).status, "superseded");
    assert.equal(w.g.db.get("ships.byId", { id: voyage(w.g, deliveryId).ship_id }).status, "idle");
    assert.match(fs.readFileSync(path.join(w.dir, ".nexus", "specs", "T1.md"), "utf8"), /^ {4}Set thing = 2 in src\/lib\/thing\.js/m);
    assert.equal(log(w.g).filter((e) => e.kind === "moon.amended").length, 1);
    assert.deepEqual(availableActions(w.g, "T1", ctx), ["send"]);
    stable(w.g);
  } finally { w.cleanup(); }
});

test("REJECT left unrecorded: the moon is quarantined and the decision is opened", async () => {
  const w = await worldWithMoon("happy", pin());
  try {
    const { deliveryId } = await returnedWithoutVerdict(w, { verdict: "REJECT", reasoning: "wrong task" });
    const r = await sendCustoms(w.g, { taskId: "T1" });
    assert.equal(r.moonStatus, "quarantined");
    assert.equal(voyage(w.g, deliveryId).status, "quarantined");
    assert.deepEqual(w.g.db.all("decisions.pending").map((d) => d.kind), ["reject"]);
    stable(w.g);
  } finally { w.cleanup(); }
});

test("recording a stored verdict needs no ship: a dry pool does not hold it, and the scheduler does it at verdicts", async () => {
  const w = await worldWithMoon("happy", pin((c) => { c.providers.fake.pool = { kind: "window", reserve_floor: 0.1 }; }));
  try {
    await returnedWithoutVerdict(w, { verdict: "APPROVE", reasoning: "ok" });
    append(w.g.db, { kind: "fuel.exhausted", provider: "fake", payload: { until: iso(3_600_000), voyage_id: "prior" } });
    assert.equal(moonDetail(w.g, "T1", ctx).moon.waiting_on_fuel, null);
    assert.deepEqual(planWithHolds(w.g, { ...ctx, rung: "verdicts" }), { actions: [{ action: "inspect", taskId: "T1", first: false }], holds: [] });
    assert.deepEqual(planWithHolds(w.g, { ...ctx, rung: "manual" }), { actions: [], holds: [] });
    assert.equal((await sendCustoms(w.g, { taskId: "T1" })).verdict.verdict, "APPROVE");
  } finally { w.cleanup(); }
});

test("a reviewing moon whose customs voyage is still out, or whose verdict is recorded, is not offered inspect", async () => {
  const w = await worldWithMoon("happy", pin());
  try {
    await sendDelivery(w.g, { taskId: "T1" });
    await sendCustoms(w.g, { taskId: "T1" });
    assert.deepEqual(availableActions(w.g, "T1", ctx), ["dock"]);
  } finally { w.cleanup(); }
});
