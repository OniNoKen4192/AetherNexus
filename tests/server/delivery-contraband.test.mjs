import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { worldWithMoon } from "../fixtures/world.mjs";
import { rowToEvent } from "../../dist/db/events.js";
import { rebuild, dumpProjections } from "../../dist/db/rebuild.js";
import { sendDelivery } from "../../dist/server/commands/delivery.js";
import { sendCustoms } from "../../dist/server/commands/customs.js";
import { replyMoon, cancelDelivery } from "../../dist/server/commands/park.js";
import { loadMoon } from "../../dist/server/dispatch.js";

const worktree = (w) => path.join(w.g.paths.worktrees, "T1");
const events = (w) => w.g.db.all("events.byAssignment", { assignment_id: loadMoon(w.g, "T1").assignment_id }).map(rowToEvent);
const count = (w, kinds) => events(w).filter((e) => kinds.includes(e.kind)).length;
function finish(w) {
  const before = dumpProjections(w.g.db);
  rebuild(w.g.db);
  assert.equal(dumpProjections(w.g.db), before, "rebuild leaves the projections byte-equal");
  w.cleanup();
}
async function awaitingPickup() {
  const w = await worldWithMoon("wall");
  const first = await sendDelivery(w.g, { taskId: "T1", provider: "fake" });
  assert.equal(first.moonStatus, "awaiting_pickup");
  return w;
}
async function parkContraband() {
  const w = await awaitingPickup();
  const file = path.join(worktree(w), "README-extra.md");
  fs.writeFileSync(file, "contraband\n");
  const result = await sendDelivery(w.g, { taskId: "T1", provider: "fake", override: true });
  return { w, file, result };
}

test("1. Contraband parks the moon", async () => {
  const { w, result } = await parkContraband();
  assert.equal(result.voyageId, "");
  assert.equal(result.moonStatus, "adrift");
  assert.equal(result.audit.verdict, "violations");
  const moon = loadMoon(w.g, "T1");
  assert.equal(moon.status, "adrift");
  assert.equal(moon.park_reason, "carryover_violations");
  const decisions = w.g.db.all("decisions.pending");
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].kind, "adrift");
  assert.equal(decisions[0].target_kind, "moon");
  assert.equal(decisions[0].target_id, "T1");
  assert.ok(decisions[0].reasoning.startsWith("contraband in the cargo awaiting pickup: "));
  assert.match(decisions[0].reasoning, /README-extra\.md/);
  const tail = events(w).slice(-2);
  assert.deepEqual(tail.map((e) => e.kind), ["moon.adrift", "decision.opened"]);
  finish(w);
});

test("2. Nothing flew", async () => {
  const w = await awaitingPickup();
  const file = path.join(worktree(w), "README-extra.md");
  fs.writeFileSync(file, "contraband\n");
  const before = {
    launched: count(w, ["voyage.launched"]),
    gated: count(w, ["moon.gated"]),
    limited: count(w, ["limiter.rerouted", "limiter.refuelled"]),
    round: loadMoon(w.g, "T1").round,
    head: w.git("rev-parse", "nexus/T1"),
  };
  const result = await sendDelivery(w.g, { taskId: "T1", provider: "fake", override: true });
  assert.equal(result.moonStatus, "adrift");
  assert.equal(count(w, ["voyage.launched"]), before.launched);
  assert.equal(count(w, ["moon.gated"]), before.gated);
  assert.equal(count(w, ["limiter.rerouted", "limiter.refuelled"]), before.limited);
  assert.ok(w.g.db.all("ships.all").every((ship) => ship.status === "idle"));
  assert.equal(loadMoon(w.g, "T1").round, before.round);
  assert.equal(w.git("rev-parse", "nexus/T1"), before.head);
  assert.equal(fs.readFileSync(file, "utf8"), "contraband\n");
  finish(w);
});

test("3. A raid parks the moon", async () => {
  const w = await awaitingPickup();
  const statePath = path.join(w.g.paths.stateDir, "T1.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.touch.push("README.md");
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
  const result = await sendDelivery(w.g, { taskId: "T1", provider: "fake", override: true });
  assert.equal(result.voyageId, "");
  assert.equal(result.moonStatus, "adrift");
  assert.equal(result.audit, null);
  assert.equal(loadMoon(w.g, "T1").park_reason, "baseline_tampered");
  const decisions = w.g.db.all("decisions.pending");
  assert.equal(decisions.length, 1);
  assert.ok(decisions[0].reasoning.startsWith("raided: the gate baseline changed while the cargo awaited pickup: "));
  finish(w);
});

test("4. Now it needs a reply", async () => {
  const { w } = await parkContraband();
  await assert.rejects(sendDelivery(w.g, { taskId: "T1", provider: "fake", override: true }), /adrift.*reply/);
  replyMoon(w.g, { taskId: "T1", note: "inspect the cargo" });
  const before = count(w, ["moon.adrift"]);
  await assert.rejects(
    sendDelivery(w.g, { taskId: "T1", provider: "fake", override: true }),
    /carry-over audit refused the parked worktree \(carryover_violations\)/,
  );
  assert.equal(loadMoon(w.g, "T1").status, "adrift");
  assert.equal(count(w, ["moon.adrift"]), before);
  finish(w);
});

test("5. Cleared by hand, it flies", async () => {
  const { w, file } = await parkContraband();
  fs.rmSync(file);
  replyMoon(w.g, { taskId: "T1", note: "cargo cleared" });
  const before = loadMoon(w.g, "T1").round;
  const result = await sendDelivery(w.g, { taskId: "T1", provider: "fake", override: true });
  assert.equal(result.moonStatus, "audited");
  assert.equal(loadMoon(w.g, "T1").round, before + 1);
  finish(w);
});

test("6. It can be dropped", async () => {
  const { w } = await parkContraband();
  const result = cancelDelivery(w.g, { taskId: "T1" });
  assert.equal(w.g.db.get("moons.byId", { id: result.moonId }).body_status, "barren");
  assert.equal(w.g.db.all("events.byMoon", { moon_id: w.moonId }).filter((e) => e.kind === "moon.dropped").length, 1);
  assert.ok(w.g.db.all("ships.all").every((ship) => ship.status === "idle"));
  assert.equal(w.g.db.all("decisions.pending").length, 0);
  finish(w);
});

test("7. A FIX round keeps its wording", async () => {
  const w = await worldWithMoon("fix-round");
  await sendDelivery(w.g, { taskId: "T1", provider: "fake" });
  await sendCustoms(w.g, { taskId: "T1", provider: "fake", reviewScript: "review-fix" });
  fs.writeFileSync(path.join(worktree(w), "README.md"), "changed after audit\n");
  const result = await sendDelivery(w.g, { taskId: "T1", provider: "fake" });
  assert.equal(result.moonStatus, "adrift");
  assert.equal(loadMoon(w.g, "T1").park_reason, "carryover_violations");
  const decisions = w.g.db.all("decisions.pending");
  assert.equal(decisions.length, 1);
  assert.ok(decisions[0].reasoning.startsWith("round "));
  assert.match(decisions[0].reasoning, /work changed after its audit \(carryover_violations\)/);
  finish(w);
});
