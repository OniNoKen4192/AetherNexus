// Ships are commissioned on demand, inside the launch transaction: an idle ship of the right fleet, job and weight is
// reused, otherwise a new one is created with the provider's faction, the trip's weight and a formation from the catalogue.
// Every galaxy here pins its roles to fake providers; no test flies a real adapter.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { worldWithMoon, worldWithTwoMoons } from "../fixtures/world.mjs";
import { tmpDb } from "../helpers.mjs";
import { openDb } from "../../dist/db/open.js";
import { append, appendAll, rowToEvent } from "../../dist/db/events.js";
import { rebuild, dumpProjections } from "../../dist/db/rebuild.js";
import { BUILTIN } from "../../dist/core/catalogue/builtin.js";
import { commissionShip } from "../../dist/core/fleet.js";
import { sendDelivery } from "../../dist/server/commands/delivery.js";
import { sendCustoms } from "../../dist/server/commands/customs.js";
import { dockCargo } from "../../dist/server/commands/dock.js";
import { retireShip } from "../../dist/server/commands/park.js";
import { reloadConfig } from "../../dist/server/commands/config.js";
import { openGalaxy } from "../../dist/server/galaxy.js";
import { loadMoon } from "../../dist/server/dispatch.js";

const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "scripts");
const iso = (ms = 0) => new Date(Date.now() + ms).toISOString();
// The fixture specs ask for tier `terra`. `fake` flies as faction "tinkers" with a weight per tier.
const patch = (extra) => (c) => {
  c.roles = { implement: ["fake"], review: ["fake"] };
  c.providers.fake = { ...c.providers.fake, faction: "tinkers", weights: { sol: "heavy", terra: "standard", luna: "light" } };
  extra?.(c);
};
const log = (g) => g.db.raw.prepare("SELECT * FROM events ORDER BY id").all().map(rowToEvent);
const kinds = (g, kind) => log(g).filter((e) => e.kind === kind);
const ships = (g) => g.db.all("ships.all");
const ship = (g, id) => g.db.get("ships.byId", { id });
const voyage = (g, id) => g.db.get("voyages.byId", { id });
const formationsFor = (job, weight) => BUILTIN.formations.filter((f) => f.job === job && (!f.weights?.length || f.weights.includes(weight))).map((f) => f.id);
const cargoFor = (weight) => BUILTIN.cargo.filter((c) => !c.weights?.length || c.weights.includes(weight)).map((c) => c.id);
function stable(g) { const before = dumpProjections(g.db); rebuild(g.db); assert.equal(dumpProjections(g.db), before); }
const record = (id, over = {}) => ({ id, name: `Ship ${id}`, fleet: "fake", job: "delivery", faction: "tinkers", weight: "standard", formation: { id: "plain", name: "Ship", vessels: [{ hull: "ship", count: 1, role: "lead" }] }, ...over });
const commission = (g, id, over) => append(g.db, { kind: "ship.commissioned", ship_id: id, provider: over?.fleet ?? "fake", payload: { ship: record(id, over) } });

test("a new galaxy has no ships; the first delivery commissions one in the launch transaction", async () => {
  const w = await worldWithMoon("happy", patch());
  try {
    assert.deepEqual(ships(w.g), []);
    const r = await sendDelivery(w.g, { taskId: "T1" });
    const events = log(w.g); const at = events.findIndex((e) => e.kind === "ship.commissioned");
    assert.equal(events[at + 1].kind, "voyage.launched", "nothing comes between the two");
    assert.equal(events[at + 1].id, events[at].id + 1);
    const made = events[at].payload.ship;
    assert.deepEqual([made.fleet, made.job, made.faction, made.weight], ["fake", "delivery", "tinkers", "standard"]);
    assert.ok(formationsFor("delivery", "standard").includes(made.formation.id), `${made.formation.id} is a standard delivery formation`);
    assert.deepEqual(Object.keys(made.formation).sort(), ["id", "name", "vessels"], "the ship keeps a full copy and nothing of the entry's matching rules");
    assert.equal(events[at + 1].payload.ship_id, made.id); assert.ok(r.voyageId.startsWith(`${made.id}/T1/implement/`));
    const row = ship(w.g, made.id);
    assert.deepEqual([row.name, row.job, row.faction, row.weight, row.formation, row.status], [made.name, "delivery", "tinkers", "standard", JSON.stringify(made.formation), "assigned"]);
    const cargo = JSON.parse(voyage(w.g, r.voyageId).cargo);
    assert.ok(cargoFor("standard").includes(cargo.id)); assert.equal(typeof cargo.label, "string");
    assert.deepEqual(events[at + 1].payload.cargo, cargo);

    // customs: its own ship, its own job; the moon's tier describes the delivery, so the reviewer is standard here; no cargo
    const c = await sendCustoms(w.g, { taskId: "T1" });
    const customs = ship(w.g, voyage(w.g, c.voyageId).ship_id);
    assert.deepEqual([customs.job, customs.faction, customs.weight, customs.fleet], ["customs", "tinkers", "standard", "fake"]);
    assert.ok(formationsFor("customs", "standard").includes(JSON.parse(customs.formation).id));
    assert.equal(voyage(w.g, c.voyageId).cargo, null);
    assert.equal(kinds(w.g, "ship.commissioned").length, 2); assert.equal(kinds(w.g, "ship.registered").length, 0);
    stable(w.g);
  } finally { w.cleanup(); }
});

test("the weight comes from the moon's tier; a ship of another weight is never taken", async () => {
  const w = await worldWithMoon("happy", patch(), (text) => text.replace("**Model hint**: terra", "**Model hint**: sol"));
  try {
    commission(w.g, "idle-standard"); commission(w.g, "idle-light", { weight: "light" });
    const r = await sendDelivery(w.g, { taskId: "T1" });
    const flown = ship(w.g, voyage(w.g, r.voyageId).ship_id);
    assert.equal(flown.weight, "heavy"); assert.ok(formationsFor("delivery", "heavy").includes(JSON.parse(flown.formation).id));
    assert.ok(cargoFor("heavy").includes(JSON.parse(voyage(w.g, r.voyageId).cargo).id));
    assert.equal(ship(w.g, "idle-standard").status, "idle"); assert.equal(ship(w.g, "idle-light").status, "idle");
    stable(w.g);
  } finally { w.cleanup(); }
});

test("an idle ship of the same fleet, job and weight is reused; two deliveries held at once take two ships", async () => {
  const w = await worldWithTwoMoons("happy", "happy", patch());
  try {
    const a = await sendDelivery(w.g, { taskId: "T1" });          // audited: the ship stays assigned until the cargo docks
    const b = await sendDelivery(w.g, { taskId: "T2" });
    const first = voyage(w.g, a.voyageId).ship_id, second = voyage(w.g, b.voyageId).ship_id;
    assert.notEqual(first, second); assert.notEqual(ship(w.g, first).name, ship(w.g, second).name);
    assert.equal(ships(w.g).filter((s) => s.job === "delivery").length, 2);
    await sendCustoms(w.g, { taskId: "T1" }); dockCargo(w.g, { taskId: "T1" });
    assert.deepEqual([ship(w.g, first).status, ship(w.g, first).voyage_count], ["idle", 1]);
    // T2's customs reuses the customs ship T1's customs released
    await sendCustoms(w.g, { taskId: "T2" });
    assert.equal(ships(w.g).filter((s) => s.job === "customs").length, 1);
    assert.equal(kinds(w.g, "ship.commissioned").length, 3);
    stable(w.g);
  } finally { w.cleanup(); }
});

test("after its cargo docks, a ship flies the next delivery of the same weight", async () => {
  const w = await worldWithTwoMoons("happy", "happy", patch());
  try {
    const a = await sendDelivery(w.g, { taskId: "T1" }); await sendCustoms(w.g, { taskId: "T1" }); dockCargo(w.g, { taskId: "T1" });
    const b = await sendDelivery(w.g, { taskId: "T2" });
    assert.equal(voyage(w.g, b.voyageId).ship_id, voyage(w.g, a.voyageId).ship_id);
    assert.equal(ships(w.g).filter((s) => s.job === "delivery").length, 1);
    assert.notEqual(b.voyageId, a.voyageId);
    stable(w.g);
  } finally { w.cleanup(); }
});

test("the same seed and history give the same ship, formation, name and cargo", async () => {
  const run = async (seed) => {
    const w = await worldWithMoon("happy", patch((c) => { c.fleet.seed = seed; }));
    try { const r = await sendDelivery(w.g, { taskId: "T1" }); const v = voyage(w.g, r.voyageId); const s = ship(w.g, v.ship_id); return JSON.stringify([s.id, s.name, s.formation, v.cargo]); } finally { w.cleanup(); }
  };
  const a = await run(7), b = await run(7);
  assert.equal(a, b);
  const others = new Set([a]); for (const seed of [8, 9, 10, 11, 12]) others.add(await run(seed));
  assert.ok(others.size > 1, "the seed matters");
});

test("a send refused because every flight slot is taken commissions nothing and gates nothing", async () => {
  const w = await worldWithTwoMoons("slow", "happy", patch((c) => { c.scheduler.max_concurrent_ships = 1; }));
  try {
    const flying = sendDelivery(w.g, { taskId: "T1" });
    const before = log(w.g).length;
    await assert.rejects(sendDelivery(w.g, { taskId: "T2" }), /1 voyage in flight — the limit is 1 \(scheduler\.max_concurrent_ships\)/);
    assert.equal(log(w.g).filter((e) => e.kind !== "voyage.event").length, log(w.g).slice(0, before).filter((e) => e.kind !== "voyage.event").length, "the refused send appended nothing");
    assert.equal(loadMoon(w.g, "T2").status, "emitted", "the moon was not gated, so any rung can still send to it");
    assert.equal(ships(w.g).length, 1);
    await flying; stable(w.g);
  } finally { w.cleanup(); }
});

test("a refuelled delivery flies the refuel provider's faction and the refuel model's weight", async () => {
  const w = await worldWithMoon("happy", patch((c) => {
    c.providers.fake.pool = { kind: "window", reserve_floor: 0.1, refuel: { provider: "probe", models: { terra: "m-cheap" }, min_wait_minutes: 0 } };
    c.providers.probe = { adapter: "fake", faction: "outriders", weights: { "m-cheap": "light", terra: "heavy", default: "heavy" }, pool: { kind: "window", reserve_floor: 0.1 } };
  }));
  try {
    append(w.g.db, { kind: "fuel.reading", provider: "fake", payload: { window: "5h", used: 0.95, resets_at: iso(3_600_000), source: "reported" } });
    const r = await sendDelivery(w.g, { taskId: "T1", refuel: true });
    const v = voyage(w.g, r.voyageId); const s = ship(w.g, v.ship_id);
    assert.deepEqual([v.provider, v.model], ["probe", "m-cheap"]);
    assert.deepEqual([s.fleet, s.faction, s.weight], ["probe", "outriders", "light"], "the model id wins over the tier and the default");
    assert.ok(cargoFor("light").includes(JSON.parse(v.cargo).id));
    stable(w.g);
  } finally { w.cleanup(); }
});

test("a catalogue with nothing in it still flies: the plain formation, a theme name, no cargo", async () => {
  const w = await worldWithMoon("happy", patch());
  try {
    w.g.catalogue = { weights: ["light", "standard", "heavy"], formations: [], cargo: [], names: {} };
    const r = await sendDelivery(w.g, { taskId: "T1" });
    const v = voyage(w.g, r.voyageId); const s = ship(w.g, v.ship_id);
    assert.deepEqual(JSON.parse(s.formation), { id: "plain", name: "Ship", vessels: [{ hull: "ship", count: 1, role: "lead" }] });
    assert.equal(v.cargo, null); assert.equal("cargo" in kinds(w.g, "voyage.launched")[0].payload, false);
    assert.ok(s.name.length > 0); assert.equal(r.moonStatus, "audited");
    stable(w.g);
  } finally { w.cleanup(); }
});

test("a catalogue edit after commissioning changes no ship and no flown voyage", async () => {
  const w = await worldWithMoon("happy", patch());
  try {
    const r = await sendDelivery(w.g, { taskId: "T1" });
    const before = dumpProjections(w.g.db);
    for (const f of w.g.catalogue.formations) { f.name = "Renamed"; f.vessels = [{ hull: "other", count: 9, role: "lead" }]; }
    for (const c of w.g.catalogue.cargo) c.label = "renamed";
    rebuild(w.g.db);
    assert.equal(dumpProjections(w.g.db), before, "a rebuild reads the log, never the catalogue");
    assert.notEqual(JSON.parse(ship(w.g, voyage(w.g, r.voyageId).ship_id).formation).name, "Renamed");
  } finally { w.cleanup(); }
});

test("two processes on one database commission ships with different names", async () => {
  // A second handle on the same file stands in for a CLI beside the server. makeGalaxy's real-adapter guard does not cover
  // this handle; it is safe because the config pins both roles to the fake provider.
  const w = await worldWithTwoMoons("slow", "slow", patch());
  const other = openGalaxy(w.dir, { scriptsDir: SCRIPTS });
  try {
    assert.deepEqual(other.config.roles, { implement: ["fake"], review: ["fake"] });
    const [a, b] = await Promise.all([sendDelivery(w.g, { taskId: "T1" }), sendDelivery(other, { taskId: "T2" })]);
    const first = ship(w.g, voyage(w.g, a.voyageId).ship_id), second = ship(w.g, voyage(w.g, b.voyageId).ship_id);
    assert.notEqual(first.id, second.id); assert.notEqual(first.name, second.name);
    assert.equal(kinds(w.g, "ship.commissioned").length, 2);
    stable(w.g);
  } finally { other.close(); w.cleanup(); }
});

test("an adrift, quarantined or retired ship is never picked, and a retired ship's name is never given out again", async () => {
  const w = await worldWithMoon("happy", patch());
  try {
    for (const id of ["a", "b", "c"]) commission(w.g, id);
    append(w.g.db, { kind: "ship.adrift", ship_id: "a", payload: { voyage_id: "v" } });
    append(w.g.db, { kind: "ship.quarantined", ship_id: "b", payload: { voyage_id: "v" } });
    retireShip(w.g, { shipId: "c", reason: "test" });
    assert.throws(() => retireShip(w.g, { shipId: "c", reason: "again" }), /not idle/);
    const r = await sendDelivery(w.g, { taskId: "T1" });
    const flown = voyage(w.g, r.voyageId).ship_id;
    assert.ok(!["a", "b", "c"].includes(flown));
    assert.deepEqual(["a", "b", "c"].map((id) => ship(w.g, id).status), ["adrift", "quarantined", "retired"]);

    // names: retire every ship the theme can name, then commission more — none repeats
    const db = openDb(tmpDb()); const names = new Set();
    for (let i = 0; i < 70; i++) {
      const made = commissionShip(db, { catalogue: { ...BUILTIN, names: {} }, fleet: "fake", job: "delivery", faction: "none", weight: "standard", theme: "classic", seed: 3 });
      assert.ok(!names.has(made.name), `${made.name} was given out twice`); names.add(made.name);
      append(db, { kind: "ship.commissioned", ship_id: made.id, provider: "fake", payload: { ship: made } });
      append(db, { kind: "ship.retired", ship_id: made.id, payload: { reason: "test" } });
    }
    assert.equal(db.all("ships.all").length, 70); assert.equal(new Set(db.all("ships.all").map((s) => s.id)).size, 70);
    db.close();
  } finally { w.cleanup(); }
});

test("more ships than a faction has names: 70 ships, 70 names, 70 ids", () => {
  for (const faction of ["openai", "anthropic", "constructor"]) {   // "constructor": a faction name must not reach Object.prototype
    const db = openDb(tmpDb());
    const small = { ...BUILTIN, names: { openai: { pools: { a: ["Red", "Blue"], b: ["Kite", "Wren"] }, patterns: ["{a} {b}"] }, anthropic: BUILTIN.names.anthropic } };
    for (let i = 0; i < 70; i++) {
      const made = commissionShip(db, { catalogue: small, fleet: "codex", job: "delivery", faction, weight: "heavy", theme: "constructor", seed: 1 });
      append(db, { kind: "ship.commissioned", ship_id: made.id, provider: "codex", payload: { ship: made } });
    }
    const all = db.all("ships.all");
    assert.equal(new Set(all.map((s) => s.name)).size, 70, faction); assert.equal(new Set(all.map((s) => s.id)).size, 70, faction);
    assert.ok(all.every((s) => /^[a-z0-9-]+$/.test(s.id)), "an id is safe inside a voyage id");
    const before = dumpProjections(db); rebuild(db); assert.equal(dumpProjections(db), before);
    db.close();
  }
});

test("appendAll: several events in one transaction; a throwing build or reducer appends nothing", () => {
  const db = openDb(tmpDb()); const count = () => db.get("events.maxId").id ?? 0;
  const rows = appendAll(db, () => {
    assert.equal(db.all("ships.all").length, 0, "build runs inside the transaction and may read");
    return [{ kind: "ship.commissioned", ship_id: "a", provider: "fake", payload: { ship: record("a") } }, { kind: "ship.retired", ship_id: "a", payload: { reason: "x" } }];
  });
  assert.deepEqual(rows.map((r) => r.kind), ["ship.commissioned", "ship.retired"]); assert.equal(rows[1].id, rows[0].id + 1);
  assert.equal(db.get("ships.byId", { id: "a" }).status, "retired", "the second event saw the first one's row");
  const before = count();
  assert.throws(() => appendAll(db, () => { throw new Error("no"); }), /no/);
  // the second event's reducer fails (the name is taken): the first event of the batch is rolled back with it
  assert.throws(() => appendAll(db, () => [
    { kind: "ship.commissioned", ship_id: "b", provider: "fake", payload: { ship: record("b") } },
    { kind: "ship.commissioned", ship_id: "c", provider: "fake", payload: { ship: record("c", { name: "Ship a" }) } },
  ]), /UNIQUE constraint failed/);
  assert.equal(count(), before); assert.equal(db.get("ships.byId", { id: "b" }), undefined);
  assert.deepEqual(appendAll(db, () => []), []);
  db.close();
});

test("a running galaxy does not pick up a config whose weights the catalogue does not list", async () => {
  const w = await worldWithMoon("happy", patch());
  try {
    const file = path.join(w.dir, ".nexus", "config.json"); const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    cfg.providers.fake.weights.terra = "colossal"; fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
    const r = reloadConfig(w.g);
    assert.equal(r.ok, false); assert.match(r.error, /'providers\.fake\.weights\.terra' names weight 'colossal'/);
    assert.equal(w.g.config.providers.fake.weights.terra, "standard", "the running config is unchanged");
    cfg.providers.fake.weights.terra = "light"; fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
    assert.deepEqual(reloadConfig(w.g), { ok: true }); assert.equal(w.g.config.providers.fake.weights.terra, "light");
  } finally { w.cleanup(); }
});

test("the limit inside the launch transaction refuses customs with no ship commissioned for it", async () => {
  // sendCustoms has no advisory check up front, so this reaches the authoritative one, at the point where a customs ship would be commissioned
  const w = await worldWithTwoMoons("happy", "slow", patch((c) => { c.scheduler.max_concurrent_ships = 1; }));
  try {
    await sendDelivery(w.g, { taskId: "T1" });                       // audited: nothing in flight
    const flying = sendDelivery(w.g, { taskId: "T2" });              // slow: takes the only flight slot
    await assert.rejects(sendCustoms(w.g, { taskId: "T1" }), /1 voyage in flight — the limit is 1 \(scheduler\.max_concurrent_ships\)/);
    assert.equal(ships(w.g).filter((s) => s.job === "customs").length, 0, "no customs ship was commissioned for the refused voyage");
    assert.equal(kinds(w.g, "ship.commissioned").length, 2);
    assert.equal(loadMoon(w.g, "T1").status, "audited");
    await flying;
    await sendCustoms(w.g, { taskId: "T1" });
    assert.equal(ships(w.g).filter((s) => s.job === "customs").length, 1);
    stable(w.g);
  } finally { w.cleanup(); }
});
