import { test } from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { worldWithTwoMoons } from "../fixtures/world.mjs"; import { repoRoot } from "../helpers.mjs";
import { launchMoon } from "../../dist/server/commands/launch.js"; import { inspectMoon } from "../../dist/server/commands/review.js"; import { dockMoon } from "../../dist/server/commands/dock.js";
import { openGalaxy } from "../../dist/server/galaxy.js"; import { rowToEvent } from "../../dist/db/events.js";
import { createFakeAdapter } from "../../dist/providers/fake/index.js";
import { loadMoon } from "../../dist/server/dispatch.js";

const scriptsDir = path.join(repoRoot, "tests", "fixtures", "scripts");
const cap = (n) => (c) => { c.roles = { implement: ["fake"], review: ["fake"] }; c.routing.security_routed = ["src/auth.ts"]; c.routing.do_not_touch = [".env"]; c.scheduler.max_concurrent_ships = n; };
const twoProviders = (c) => {
  c.providers.fake2 = { adapter: "fake" }; c.roles = { implement: ["fake", "fake2"], review: ["fake"] };
  c.routing.security_routed = ["src/auth.ts"]; c.routing.do_not_touch = [".env"]; c.scheduler.per_provider_max = { fake: 1 };
};

test("a dock during another voyage logs git on its own freighter only", async () => {
  const w = await worldWithTwoMoons("slow", "happy");
  await launchMoon(w.g, { taskId: "T2" }); await inspectMoon(w.g, { taskId: "T2" });
  let t1Voyage; const flying = launchMoon(w.g, { taskId: "T1", onLaunched: (id) => { t1Voyage = id; } });
  assert.ok(t1Voyage, "onLaunched fires before the first await returns");
  assert.equal(dockMoon(w.g, { taskId: "T2" }).moonStatus, "merged");
  assert.equal((await flying).moonStatus, "audited");
  const gitOn = (voyageId) => w.g.db.all("events.all").map(rowToEvent)
    .filter((e) => e.kind === "voyage.event" && e.voyage_id === voyageId && e.payload.event.data?.name === "git").length;
  assert.equal(gitOn(t1Voyage), 0);
  assert.ok(gitOn(w.g.db.get("voyages.latestByAssignmentRole", { assignment_id: w.g.db.get("moons.byTask", { task_id: "T2" }).assignment_id, role: "implement" }).id) > 0);
  w.cleanup();
});

test("max_concurrent_ships refuses across two galaxy handles", async () => {
  const w = await worldWithTwoMoons("slow", "happy", cap(1));
  const g2 = openGalaxy(w.dir, { scriptsDir });
  const flying = launchMoon(w.g, { taskId: "T1" });
  await assert.rejects(launchMoon(g2, { taskId: "T2" }), /1 voyage in flight — the limit is 1 \(scheduler\.max_concurrent_ships\)/);
  await flying;
  assert.equal(g2.db.all("ships.all").filter((s) => s.status === "assigned").length, 1, "only T1's freighter is assigned");
  assert.equal((await launchMoon(g2, { taskId: "T2" })).moonStatus, "audited", "T2 is still launchable once T1 has landed");
  g2.close(); w.cleanup();
});

test("per_provider_max: an unnamed provider at its cap is skipped for the next in order", async () => {
  const w = await worldWithTwoMoons("slow", "happy", twoProviders);
  let t1; const flying = launchMoon(w.g, { taskId: "T1", onLaunched: (id) => { t1 = id; } });
  assert.ok(t1);
  const r2 = await launchMoon(w.g, { taskId: "T2" });
  assert.equal(w.g.db.get("voyages.byId", { id: r2.voyageId }).provider, "fake2");
  assert.equal(w.g.db.get("voyages.byId", { id: t1 }).provider, "fake");
  await flying; w.cleanup();
});

test("per_provider_max: a named provider at its cap refuses", async () => {
  const w = await worldWithTwoMoons("slow", "happy", twoProviders);
  const flying = launchMoon(w.g, { taskId: "T1", provider: "fake" });
  await assert.rejects(launchMoon(w.g, { taskId: "T2", provider: "fake" }), /provider 'fake' is at its limit of 1 \(scheduler\.per_provider_max\)/);
  await flying; w.cleanup();
});

test("launching one moon twice yields one voyage and one refusal", async () => {
  const w = await worldWithTwoMoons("slow", "happy");
  const rs = await Promise.allSettled([launchMoon(w.g, { taskId: "T1" }), launchMoon(w.g, { taskId: "T1" })]);
  assert.equal(rs.filter((r) => r.status === "fulfilled").length, 1);
  const bad = rs.find((r) => r.status === "rejected"); assert.ok(bad, "one launch is refused");
  assert.match(bad.reason.constructor.name, /Refusal|TransitionRefused/);
  assert.equal(w.g.db.all("voyages.byTask", { task_id: "T1" }).length, 1);
  w.cleanup();
});

test("voyage.launched records owner_pid", async () => {
  const w = await worldWithTwoMoons("happy", "happy");
  await launchMoon(w.g, { taskId: "T1" });
  const ev = w.g.db.all("events.all").map(rowToEvent).find((e) => e.kind === "voyage.launched");
  assert.equal(ev.payload.owner_pid, process.pid);
  w.cleanup();
});

test("an aborted slow voyage parks promptly as interrupted", async () => {
  const w = await worldWithTwoMoons("stall", "happy");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-stall-")); 
  fs.writeFileSync(path.join(dir, "stall.json"), JSON.stringify({ name: "stall", role: "implement", steps: [{ delay_ms: 30000, text: "never" }] }));
  w.g.adapters.fake = createFakeAdapter(dir);
  const ac = new AbortController(); const t0 = Date.now();
  const p = launchMoon(w.g, { taskId: "T1", signal: ac.signal, onLaunched: () => setTimeout(() => ac.abort(), 50) });
  const r = await p;
  assert.ok(Date.now() - t0 < 2000, "resolved promptly");
  assert.equal(r.moonStatus, "adrift"); assert.equal(loadMoon(w.g, "T1").park_reason, "interrupted");
  fs.rmSync(dir, { recursive: true, force: true }); w.cleanup();
});
