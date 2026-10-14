import { test } from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs"; import path from "node:path";
import { worldWithMoon } from "../fixtures/world.mjs";
import { launchMoon } from "../../dist/server/commands/launch.js"; import { inspectMoon } from "../../dist/server/commands/review.js";

test("APPROVE: verdict recorded, freighter cleared, moon stays reviewing until dock", async () => {
  const w = await worldWithMoon("happy"); const l = await launchMoon(w.g, { taskId: "T1", provider: "fake" });
  const r = await inspectMoon(w.g, { taskId: "T1", provider: "fake" });
  assert.equal(r.verdict.verdict, "APPROVE"); assert.equal(r.moonStatus, "reviewing");
  assert.equal(w.g.db.get("voyages.byId", { id: l.voyageId }).status, "cleared");
  assert.equal(w.g.db.get("voyages.byId", { id: r.voyageId }).status, "docked");     // customs returned
  assert.equal(w.g.db.all("verdicts.byMoon", { moon_id: w.moonId })[0].verdict, "APPROVE"); w.cleanup();
});

test("FIX: freighter superseded + released, spec amended, body edit refused; round 2 passes", async () => {
  const w = await worldWithMoon("fix-round"); const l1 = await launchMoon(w.g, { taskId: "T1", provider: "fake" });
  const specPath = path.join(w.dir, ".nexus", "specs", "T1.md");
  const r1 = await inspectMoon(w.g, { taskId: "T1", provider: "fake", onEvent: () => {}, reviewScript: "review-fix" });
  assert.equal(r1.verdict.verdict, "FIX"); assert.equal(r1.moonStatus, "audited");
  assert.equal(w.g.db.get("voyages.byId", { id: l1.voyageId }).status, "superseded");
  assert.equal(w.g.db.get("ships.byId", { id: w.g.db.get("voyages.byId", { id: l1.voyageId }).ship_id }).status, "idle");
  const amended = fs.readFileSync(specPath, "utf8");
  assert.match(amended, /## Amendments[\s\S]*### A1 .* customs: /);
  assert.match(amended, /^ {4}Set thing = 2 in src\/lib\/thing\.js/m, "delta spec is an indented block under the one-line header");
  assert.equal(w.g.db.all("events.byMoon", { moon_id: w.moonId }).filter((e) => e.kind === "moon.amended").length, 1);

  // editing the BODY (not the appendix) must be refused
  fs.writeFileSync(specPath, amended.replace("FAKE-SCRIPT: fix-round", "FAKE-SCRIPT: happy"));
  await assert.rejects(launchMoon(w.g, { taskId: "T1", provider: "fake" }), /spec body changed since assign/);
  fs.writeFileSync(specPath, amended);

  // the amendment alone is fine: round 2 runs the fake's round rule (fix-round → happy)
  const l2 = await launchMoon(w.g, { taskId: "T1", provider: "fake" });
  assert.equal(l2.moonStatus, "audited"); assert.equal(l2.audit.verdict, "clean"); assert.match(l2.voyageId, /\/T1\/implement\/2$/);
  const r2 = await inspectMoon(w.g, { taskId: "T1", provider: "fake" });
  assert.equal(r2.verdict.verdict, "APPROVE");
  assert.equal(w.g.db.get("moons.byTask", { task_id: "T1" }).round, 2);
  w.cleanup();
});

test("REJECT: freighter quarantined, moon quarantined, decision opened", async () => {
  const w = await worldWithMoon("happy"); const l = await launchMoon(w.g, { taskId: "T1", provider: "fake" });
  const r = await inspectMoon(w.g, { taskId: "T1", provider: "fake", reviewScript: "review-reject" });
  assert.equal(r.moonStatus, "quarantined"); assert.equal(w.g.db.get("voyages.byId", { id: l.voyageId }).status, "quarantined");
  assert.equal(w.g.db.get("ships.byId", { id: w.g.db.get("voyages.byId", { id: l.voyageId }).ship_id }).status, "quarantined");
  assert.equal(w.g.db.all("decisions.pending")[0].kind, "reject"); w.cleanup();
});

test("max_fix_rounds exhausted → adrift", async () => {
  const w = await worldWithMoon("fix-round", (c) => { c.roles = { implement: ["fake"], review: ["fake"] }; c.automation = { level: "manual", max_fix_rounds: 1 }; });
  await launchMoon(w.g, { taskId: "T1", provider: "fake" });
  const r = await inspectMoon(w.g, { taskId: "T1", provider: "fake", reviewScript: "review-fix" });
  assert.equal(r.moonStatus, "adrift"); assert.equal(w.g.db.get("moons.byTask", { task_id: "T1" }).park_reason, "max_fix_rounds"); w.cleanup();
});

test("inspect refuses a moon that is not audited", async () => {
  const w = await worldWithMoon("happy");
  await assert.rejects(inspectMoon(w.g, { taskId: "T1", provider: "fake" }), /only an 'audited' moon/); w.cleanup();
});
