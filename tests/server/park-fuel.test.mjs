import test from "node:test";
import assert from "node:assert/strict";
import { worldWithMoon, worldWithTwoMoons } from "../fixtures/world.mjs";
import { append, rowToEvent } from "../../dist/db/events.js";
import { rebuild, dumpProjections } from "../../dist/db/rebuild.js";
import { sendDelivery } from "../../dist/server/commands/delivery.js";
import { sendCustoms } from "../../dist/server/commands/customs.js";
import { cancelDelivery, replyMoon } from "../../dist/server/commands/park.js";
import { availableActions } from "../../dist/server/commands/query.js";
import { loadMoon, moonScope } from "../../dist/server/dispatch.js";

const iso = (ms = 0) => new Date(Date.now() + ms).toISOString();
function config(c, { deliveries = 3, probe = false } = {}) {
  c.providers.fake.pool = { kind: "window", reserve_floor: 0.1 };
  if (probe) c.providers.probe = { adapter: "fake", pool: { kind: "window", reserve_floor: 0.1 } };
  c.roles = { implement: probe ? ["fake", "probe"] : ["fake"], review: ["fake"] };
  c.fleet.freighters = deliveries;
  c.automation = { level: "manual", max_fix_rounds: 3 };
}
function low(w) {
  append(w.g.db, { kind: "fuel.reading", provider: "fake", payload: { window: "5h", used: 0.95, resets_at: iso(3_600_000), source: "reported" } });
}
function dry(w) {
  const until = iso(3_600_000);
  append(w.g.db, { kind: "fuel.exhausted", provider: "fake", payload: { until, voyage_id: "prior" } });
  return until;
}
function events(w, taskId) {
  const moon = loadMoon(w.g, taskId);
  return w.g.db.all("events.byAssignment", { assignment_id: moon.assignment_id }).map(rowToEvent);
}
function stable(w) {
  const before = dumpProjections(w.g.db);
  rebuild(w.g.db);
  assert.equal(dumpProjections(w.g.db), before);
}

test("21. dropping cargo awaiting pickup does not release its rerouted delivery", async () => {
  const w = await worldWithTwoMoons("wall", "happy", (c) => config(c, { freighters: 1 }));
  try {
    const first = await sendDelivery(w.g, { taskId: "T1" });
    assert.equal(first.moonStatus, "awaiting_pickup");
    const second = await sendDelivery(w.g, { taskId: "T2", override: true });
    assert.equal(second.moonStatus, "audited");
    const voyage1 = w.g.db.get("voyages.byId", { id: first.voyageId });
    const voyage2 = w.g.db.get("voyages.byId", { id: second.voyageId });
    assert.equal(voyage2.status, "holding");
    assert.equal(voyage2.ship_id, voyage1.ship_id);
    assert.equal(w.g.db.get("ships.byId", { id: voyage1.ship_id }).status, "assigned");
    cancelDelivery(w.g, { taskId: "T1" });
    assert.equal(w.g.db.get("voyages.byId", { id: first.voyageId }).status, "superseded");
    assert.equal(w.g.db.get("voyages.byId", { id: second.voyageId }).status, "holding");
    assert.equal(w.g.db.get("ships.byId", { id: voyage1.ship_id }).status, "assigned");
    stable(w);
  } finally { w.cleanup(); }
});

test("22. replying after a second wall hit releases only the voyage still holding a ship", async () => {
  const w = await worldWithTwoMoons("wall-twice", "happy", (c) => config(c, { freighters: 2 }));
  try {
    const first = await sendDelivery(w.g, { taskId: "T1" });
    assert.equal(first.moonStatus, "awaiting_pickup");
    const second = await sendDelivery(w.g, { taskId: "T2", override: true });
    const held = w.g.db.get("voyages.byId", { id: second.voyageId });
    const spent = w.g.db.get("voyages.byId", { id: first.voyageId });
    assert.equal(held.status, "holding");
    assert.equal(held.ship_id, spent.ship_id);
    const third = await sendDelivery(w.g, { taskId: "T1", override: true });
    assert.equal(third.moonStatus, "adrift");
    const adrift = w.g.db.get("voyages.byId", { id: third.voyageId });
    assert.notEqual(adrift.ship_id, spent.ship_id);
    replyMoon(w.g, { taskId: "T1", note: "try again" });
    assert.equal(w.g.db.get("voyages.byId", { id: first.voyageId }).status, "superseded");
    assert.equal(w.g.db.get("voyages.byId", { id: third.voyageId }).status, "superseded");
    assert.equal(w.g.db.get("ships.byId", { id: adrift.ship_id }).status, "idle");
    assert.equal(w.g.db.get("ships.byId", { id: spent.ship_id }).status, "assigned");
    stable(w);
  } finally { w.cleanup(); }
});

test("23. dropping cargo awaiting pickup supersedes its voyage without releasing a ship", async () => {
  const w = await worldWithMoon("wall", (c) => config(c));
  try {
    const launched = await sendDelivery(w.g, { taskId: "T1" });
    assert.equal(launched.moonStatus, "awaiting_pickup");
    const assignmentId = loadMoon(w.g, "T1").assignment_id;
    const before = events(w, "T1").filter((e) => e.kind === "ship.released").length;
    cancelDelivery(w.g, { taskId: "T1" });
    assert.equal(w.g.db.get("voyages.byId", { id: launched.voyageId }).status, "superseded");
    assert.ok(w.g.db.all("ships.all").every((ship) => ship.status === "idle"));
    const after = w.g.db.all("events.byAssignment", { assignment_id: assignmentId }).map(rowToEvent).filter((e) => e.kind === "ship.released").length;
    assert.equal(after, before);
    stable(w);
  } finally { w.cleanup(); }
});

test("24. a rerouted delivery carries no model", async () => {
  const w = await worldWithMoon("happy", (c) => config(c, { probe: true }));
  try {
    low(w);
    const launched = await sendDelivery(w.g, { taskId: "T1" });
    const voyage = w.g.db.get("voyages.byId", { id: launched.voyageId });
    assert.equal(voyage.model, null);
    const all = events(w, "T1");
    const launchEvent = all.find((e) => e.kind === "voyage.launched");
    assert.equal(Object.hasOwn(launchEvent.payload, "model"), false);
    assert.equal(Object.hasOwn(launchEvent.payload, "refuel_for"), false);
    assert.equal(all.some((e) => e.kind === "voyage.event" && String(e.payload.event?.data?.text ?? "").startsWith("fake: model")), false);
    const kinds = all.map((e) => e.kind);
    const gated = kinds.indexOf("moon.gated");
    const rerouted = kinds.indexOf("limiter.rerouted");
    const launchedAt = kinds.indexOf("voyage.launched");
    assert.ok(gated < rerouted);
    assert.equal(rerouted, launchedAt - 1);
  } finally { w.cleanup(); }
});

test("25. actions under a main-tree question are answer and drop", async () => {
  const w = await worldWithMoon("wall", (c) => config(c));
  try {
    assert.equal((await sendDelivery(w.g, { taskId: "T1" })).moonStatus, "awaiting_pickup");
    const moon = loadMoon(w.g, "T1");
    append(w.g.db, { kind: "decision.opened", ...moonScope(w.g, moon), payload: { kind: "main_tree_changed", target_kind: "moon", target_id: "T1", reasoning: "{}" } });
    assert.deepEqual(availableActions(w.g, "T1", { ownPid: process.pid }), ["answer", "cancel_delivery"]);
  } finally { w.cleanup(); }
});

test("26. refusal wording says cargo awaits pickup and adrift means a reply is needed", async () => {
  const emitted = await worldWithMoon("happy", (c) => config(c));
  try {
    assert.throws(() => cancelDelivery(emitted.g, { taskId: "T1" }), /only an adrift or quarantined moon, or one whose cargo awaits pickup, can be dropped$/);
  } finally { emitted.cleanup(); }
  const awaiting = await worldWithMoon("wall", (c) => config(c));
  try {
    assert.equal((await sendDelivery(awaiting.g, { taskId: "T1" })).moonStatus, "awaiting_pickup");
    assert.throws(() => replyMoon(awaiting.g, { taskId: "T1", note: "try again" }), /only an adrift or quarantined moon can be replied to$/);
  } finally { awaiting.cleanup(); }
});

test("27. held customs says until when fuel is dry", async () => {
  const w = await worldWithMoon("happy", (c) => config(c));
  try {
    assert.equal((await sendDelivery(w.g, { taskId: "T1" })).moonStatus, "audited");
    const until = dry(w);
    await assert.rejects(sendCustoms(w.g, { taskId: "T1" }), (e) => {
      assert.match(e.message, /^moon T1 is waiting on fake fuel \(dry\), resets /);
      assert.ok(e.message.endsWith(until));
      assert.deepEqual(e.details, { provider: "fake", reason: "dry", until, can_refuel: null });
      return true;
    });
  } finally { w.cleanup(); }
});

test("28. a quarantined moon still needs a reply", async () => {
  const w = await worldWithMoon("happy", (c) => config(c));
  try {
    await sendDelivery(w.g, { taskId: "T1" });
    assert.equal((await sendCustoms(w.g, { taskId: "T1", reviewScript: "review-reject" })).moonStatus, "quarantined");
    await assert.rejects(sendDelivery(w.g, { taskId: "T1" }), /quarantined.*reply/);
    await assert.rejects(sendDelivery(w.g, { taskId: "T1", override: true }), /quarantined.*reply/);
  } finally { w.cleanup(); }
});
