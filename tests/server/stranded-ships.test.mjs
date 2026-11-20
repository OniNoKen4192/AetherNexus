// A ship must never stay `assigned` to a voyage that is over. Two halves:
//  1. every event that ends a voyage is written in one transaction with the ship's release, so a crash leaves both or neither;
//  2. a ship already stranded (by a crash under an older build) is found and released, in the log, at server start or on demand.
// Every galaxy here pins its roles to fake providers.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { worldWithMoon, worldWithTwoMoons } from "../fixtures/world.mjs";
import { repoRoot } from "../helpers.mjs";
import { append, rowToEvent } from "../../dist/db/events.js";
import { rebuild, dumpProjections } from "../../dist/db/rebuild.js";
import { sendDelivery } from "../../dist/server/commands/delivery.js";
import { sendCustoms } from "../../dist/server/commands/customs.js";
import { dockCargo } from "../../dist/server/commands/dock.js";
import { cancelDelivery, recoverStrandedShips, replyMoon } from "../../dist/server/commands/park.js";
import { loadMoon, moonScope } from "../../dist/server/dispatch.js";
import { startServer } from "../../dist/server/http/server.js";

const pin = (extra) => (c) => { c.roles = { implement: ["fake"], review: ["fake"] }; extra?.(c); };
const log = (g) => g.db.raw.prepare("SELECT * FROM events ORDER BY id").all().map(rowToEvent);
const ship = (g, id) => g.db.get("ships.byId", { id });
const voyage = (g, id) => g.db.get("voyages.byId", { id });
function stable(g) { const before = dumpProjections(g.db); rebuild(g.db); assert.equal(dumpProjections(g.db), before); }
/** The events that follow `kind` for this voyage, as kinds, up to `n`. */
function after(g, kind, voyageId, n) {
  const events = log(g); const at = events.findIndex((e) => e.kind === kind && e.voyage_id === voyageId);
  assert.notEqual(at, -1, `${kind} for ${voyageId}`);
  const run = events.slice(at, at + n);
  for (let i = 1; i < run.length; i++) assert.equal(run[i].id, run[i - 1].id + 1);
  return run;
}
/** No assigned ship is left without an open or parked voyage. */
const stranded = (g) => g.db.all("ships.stranded").map((s) => s.id);

test("customs: the return and the ship's release are consecutive events, before the verdict", async () => {
  const w = await worldWithMoon("happy", pin());
  try {
    await sendDelivery(w.g, { taskId: "T1" }); const c = await sendCustoms(w.g, { taskId: "T1" });
    const run = after(w.g, "voyage.returned", c.voyageId, 3);
    assert.deepEqual(run.map((e) => e.kind), ["voyage.returned", "ship.released", "verdict.issued"]);
    assert.deepEqual(run[1].payload, { voyage_id: c.voyageId, outcome: "docked" });
    assert.equal(run[1].ship_id, voyage(w.g, c.voyageId).ship_id);
    assert.equal(log(w.g).filter((e) => e.kind === "ship.released" && e.voyage_id === c.voyageId).length, 1, "released once, not twice");
    assert.deepEqual([ship(w.g, run[1].ship_id).status, ship(w.g, run[1].ship_id).voyage_count], ["idle", 1]);
    // a delivery ship is NOT released when it returns: it holds its cargo until the dock
    const d = log(w.g).find((e) => e.kind === "voyage.returned" && e.payload.role === "implement");
    assert.notEqual(log(w.g).find((e) => e.id === d.id + 1).kind, "ship.released");
    assert.deepEqual(stranded(w.g), []); stable(w.g);
  } finally { w.cleanup(); }
});

test("dock: voyage docked, moon merged and ship released are consecutive events", async () => {
  const w = await worldWithMoon("happy", pin());
  try {
    const d = await sendDelivery(w.g, { taskId: "T1" }); await sendCustoms(w.g, { taskId: "T1" }); dockCargo(w.g, { taskId: "T1" });
    assert.deepEqual(after(w.g, "voyage.docked", d.voyageId, 3).map((e) => e.kind), ["voyage.docked", "moon.merged", "ship.released"]);
    assert.equal(log(w.g).filter((e) => e.kind === "moon.merged").length, 1);
    assert.equal(log(w.g).filter((e) => e.kind === "ship.released" && e.voyage_id === d.voyageId).length, 1);
    assert.deepEqual([loadMoon(w.g, "T1").status, ship(w.g, voyage(w.g, d.voyageId).ship_id).voyage_count], ["merged", 1]);
    assert.throws(() => dockCargo(w.g, { taskId: "T1" }), /already merged/);
    assert.deepEqual(stranded(w.g), []); stable(w.g);
  } finally { w.cleanup(); }
});

test("a dock an older build left half-written (voyage docked, ship still assigned) strands the ship; recovery frees it", async () => {
  const w = await worldWithMoon("happy", pin());
  try {
    const d = await sendDelivery(w.g, { taskId: "T1" }); await sendCustoms(w.g, { taskId: "T1" });
    const scope = moonScope(w.g, loadMoon(w.g, "T1")); const shipId = voyage(w.g, d.voyageId).ship_id;
    assert.deepEqual(stranded(w.g), [], "cleared and waiting to dock: rightly assigned");
    // what a crash right after `voyage.docked` used to leave: the voyage over, nothing after it
    append(w.g.db, { kind: "voyage.departed", ...scope, voyage_id: d.voyageId, ship_id: shipId, payload: {} });
    assert.deepEqual(stranded(w.g), [], "en route: rightly assigned");
    append(w.g.db, { kind: "voyage.docked", ...scope, voyage_id: d.voyageId, ship_id: shipId, payload: { merge_sha: "x", planet_branch: "p" } });
    assert.deepEqual(stranded(w.g), [shipId]);
    assert.deepEqual(recoverStrandedShips(w.g).released.map((r) => r.shipId), [shipId]);
    assert.equal(ship(w.g, shipId).status, "idle");
    assert.deepEqual(stranded(w.g), []); stable(w.g);
  } finally { w.cleanup(); }
});

test("a FIX verdict, a reply and a cancel each supersede the voyage and release its ship as one step", async () => {
  const w = await worldWithTwoMoons("fix-round", "crash-midrun", pin());
  try {
    const d = await sendDelivery(w.g, { taskId: "T1" }); await sendCustoms(w.g, { taskId: "T1", reviewScript: "review-fix" });
    assert.deepEqual(after(w.g, "voyage.superseded", d.voyageId, 2).map((e) => [e.kind, e.payload.outcome ?? null]), [["voyage.superseded", null], ["ship.released", "superseded"]]);
    const parked = await sendDelivery(w.g, { taskId: "T2" });   // the fake ship breaks down: voyage and ship adrift
    assert.equal(loadMoon(w.g, "T2").status, "adrift"); assert.equal(ship(w.g, voyage(w.g, parked.voyageId).ship_id).status, "adrift");
    assert.deepEqual(stranded(w.g), [], "an adrift voyage's ship is held on purpose, not stranded");
    replyMoon(w.g, { taskId: "T2", note: "try again" });
    assert.deepEqual(after(w.g, "voyage.superseded", parked.voyageId, 2).map((e) => [e.kind, e.payload.outcome ?? null]), [["voyage.superseded", null], ["ship.released", "reply"]]);
    cancelDelivery(w.g, { taskId: "T2", reason: "enough" });
    assert.deepEqual(stranded(w.g), []); stable(w.g);
  } finally { w.cleanup(); }
});

test("out of fuel: the voyage ends, the ship is free and the cargo awaits pickup as one step", async () => {
  const w = await worldWithMoon("wall", pin((c) => { c.providers.fake.pool = { kind: "window", reserve_floor: 0.1 }; }));
  try {
    const d = await sendDelivery(w.g, { taskId: "T1" });
    assert.deepEqual(after(w.g, "voyage.out_of_fuel", d.voyageId, 3).map((e) => e.kind), ["voyage.out_of_fuel", "ship.released", "moon.awaiting_pickup"]);
    assert.deepEqual([loadMoon(w.g, "T1").status, ship(w.g, voyage(w.g, d.voyageId).ship_id).status], ["awaiting_pickup", "idle"]);
    assert.deepEqual(stranded(w.g), []); stable(w.g);
  } finally { w.cleanup(); }
});

/** A customs voyage that returned with its ship never released: what a crash between the two used to leave. */
async function strandCustomsShip(w) {
  await sendDelivery(w.g, { taskId: "T1" });
  const scope = moonScope(w.g, loadMoon(w.g, "T1"));
  const id = "stranded-cutter"; const voyageId = `${id}/T1/review/1`;
  append(w.g.db, { kind: "ship.commissioned", ship_id: id, provider: "fake", payload: { ship: { id, name: "Stranded Cutter", fleet: "fake", job: "customs", faction: "fake", weight: "standard", formation: { id: "plain", name: "Ship", vessels: [{ hull: "ship", count: 1, role: "lead" }] } } } });
  append(w.g.db, { kind: "voyage.launched", ...scope, voyage_id: voyageId, ship_id: id, provider: "fake", payload: { role: "review", round: 1, provider: "fake", ship_id: id, worktree: "w", owner_pid: 2147483646 } });
  append(w.g.db, { kind: "voyage.returned", ...scope, voyage_id: voyageId, ship_id: id, payload: { role: "review", report: { verdict: "APPROVE", reasoning: "ok" } } });
  assert.deepEqual([ship(w.g, id).status, voyage(w.g, voyageId).status], ["assigned", "docked"]);
  return { id, voyageId };
}

test("recover: a ship assigned to a finished voyage is released once, in the log; ships that are rightly held are left alone", async () => {
  const w = await worldWithTwoMoons("happy", "crash-midrun", pin());
  try {
    const { id, voyageId } = await strandCustomsShip(w);
    const holding = voyage(w.g, log(w.g).find((e) => e.kind === "voyage.launched" && e.payload.role === "implement").voyage_id).ship_id;   // T1's delivery ship: assigned, cargo holding
    const parked = await sendDelivery(w.g, { taskId: "T2" }); const adrift = voyage(w.g, parked.voyageId).ship_id;
    // a ship whose park was cut short: the voyage is adrift but the ship still says assigned — a person decides that one, not the recovery
    w.g.db.raw.prepare("UPDATE ships SET status = 'assigned' WHERE id = ?").run(adrift);
    assert.deepEqual(stranded(w.g), [id]);

    const before = log(w.g).length;
    assert.deepEqual(recoverStrandedShips(w.g), { released: [{ shipId: id, name: "Stranded Cutter", voyageId }] });
    const added = log(w.g).slice(before);
    assert.deepEqual(added.map((e) => [e.kind, e.ship_id, e.voyage_id, e.task_id, e.payload]), [["ship.released", id, voyageId, "T1", { voyage_id: voyageId, outcome: "recovered" }]]);
    assert.deepEqual([ship(w.g, id).status, ship(w.g, id).voyage_count], ["idle", 0], "a recovery is not a flown voyage");
    assert.deepEqual([ship(w.g, holding).status, ship(w.g, adrift).status], ["assigned", "assigned"]);
    assert.deepEqual(recoverStrandedShips(w.g), { released: [] }, "nothing to do the second time");
    assert.equal(log(w.g).length, before + 1);
    // the recovered ship flies again
    w.g.db.raw.prepare("UPDATE ships SET status = 'adrift' WHERE id = ?").run(adrift);
  } finally { w.cleanup(); }
});

test("recover: the server releases a stranded ship when it starts, and says so; `nexus fleet recover` does the same by hand", async () => {
  const w = await worldWithMoon("happy", pin());
  const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-web-"));
  const written = []; const realWrite = process.stderr.write.bind(process.stderr);
  try {
    const { id } = await strandCustomsShip(w);
    process.stderr.write = (chunk, ...rest) => { written.push(String(chunk)); return realWrite(chunk, ...rest); };
    const srv = await startServer(w.g, { port: 0, webRoot });
    process.stderr.write = realWrite;
    try {
      assert.equal(ship(w.g, id).status, "idle");
      assert.ok(written.some((line) => /released 1 stranded ship: Stranded Cutter/.test(line)), written.join(""));
    } finally { await srv.close(); }
    stable(w.g);

    // by hand, from another process: strand it again, then ask the CLI
    w.g.db.raw.prepare("UPDATE ships SET status = 'assigned' WHERE id = ?").run(id);
    const cli = (...args) => execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(repoRoot, "dist", "cli", "main.js"), ...args], { cwd: w.dir, encoding: "utf8" });
    assert.match(cli("fleet", "recover"), /released Stranded Cutter \(stranded-cutter\) — its last voyage was stranded-cutter\/T1\/review\/1/);
    assert.match(cli("fleet", "recover"), /no stranded ships/);
    assert.deepEqual(JSON.parse(cli("--json", "fleet", "recover")), { released: [] });
  } finally { process.stderr.write = realWrite; fs.rmSync(webRoot, { recursive: true, force: true }); w.cleanup(); }
});
