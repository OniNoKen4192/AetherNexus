import { test } from "node:test";
import assert from "node:assert/strict";
import { startWorld } from "./helpers.mjs";
import { seedFleet } from "../fixtures/world.mjs";
import { sendDelivery } from "../../dist/server/commands/delivery.js";
import { sendCustoms } from "../../dist/server/commands/customs.js";
import { fleet } from "../../dist/server/commands/query.js";
import { rebuild } from "../../dist/db/rebuild.js";

const maxId = (w) => w.g.db.get("events.maxId").id;
const summary = (ship) => ({ name: ship.name, faction: ship.faction, weight: ship.weight, formation_name: ship.formation.name });

test("snapshot, moon detail and fleet show delivery identity and cargo without writing", async () => {
  const x = await startWorld();
  try {
    await sendDelivery(x.w.g, { taskId: "T1" });
    const before = maxId(x.w);
    const snapshot = await x.api("/api/snapshot");
    assert.equal(snapshot.status, 200);
    assert.equal(snapshot.json.fleet.length, 1);
    const ship = snapshot.json.fleet[0];
    assert.equal(ship.job, "delivery");
    assert.equal(typeof ship.faction, "string");
    assert.equal(typeof ship.weight, "string");
    assert.equal(typeof ship.formation.id, "string");
    assert.equal(typeof ship.formation.name, "string");
    assert.ok(ship.formation.vessels.length > 0);
    const voyage = snapshot.json.voyages.find((row) => row.ship_id === ship.id);
    const stored = x.w.g.db.get("voyages.byId", { id: voyage.id });
    assert.deepEqual(voyage.cargo, JSON.parse(stored.cargo));
    assert.deepEqual(voyage.ship, summary(ship));

    const detail = await x.api("/api/moons/T1");
    assert.equal(detail.status, 200);
    assert.deepEqual(detail.json.voyages.map(({ id, cargo, ship }) => ({ id, cargo, ship })), snapshot.json.voyages.map(({ id, cargo, ship }) => ({ id, cargo, ship })));
    assert.deepEqual(fleet(x.w.g), snapshot.json.fleet);
    assert.equal(maxId(x.w), before);

    rebuild(x.w.g.db);
    const rebuilt = await x.api("/api/snapshot");
    assert.deepEqual(rebuilt.json.fleet, snapshot.json.fleet);
    assert.deepEqual(rebuilt.json.voyages, snapshot.json.voyages);
  } finally { await x.close(); }
});

test("customs voyage has no cargo and describes its ship", async () => {
  const x = await startWorld();
  try {
    await sendDelivery(x.w.g, { taskId: "T1" });
    await sendCustoms(x.w.g, { taskId: "T1" });
    const snapshot = (await x.api("/api/snapshot")).json;
    const voyage = snapshot.voyages.find((row) => row.role === "review");
    const ship = snapshot.fleet.find((row) => row.id === voyage.ship_id);
    assert.equal(voyage.cargo, null);
    assert.deepEqual(voyage.ship, summary(ship));
  } finally { await x.close(); }
});

test("legacy delivery ship reads with standard identity and Freighter formation", async () => {
  const x = await startWorld();
  try {
    seedFleet(x.w.g.db, ["fake"]);
    const ship = fleet(x.w.g).find((row) => row.job === "delivery");
    assert.equal(ship.weight, "standard");
    assert.equal(ship.faction, ship.fleet);
    assert.equal(ship.formation.name, "Freighter");
  } finally { await x.close(); }
});

test("bad formation and cargo JSON use safe read fallbacks", async () => {
  const x = await startWorld();
  try {
    await sendDelivery(x.w.g, { taskId: "T1" });
    const ship = x.w.g.db.all("ships.all")[0];
    const voyage = x.w.g.db.raw.prepare("SELECT * FROM voyages LIMIT 1").get();
    x.w.g.db.raw.prepare("UPDATE ships SET formation = ? WHERE id = ?").run("[]", ship.id);
    x.w.g.db.raw.prepare("UPDATE voyages SET cargo = ? WHERE id = ?").run("[]", voyage.id);
    const response = await x.api("/api/snapshot");
    assert.equal(response.status, 200);
    assert.equal(response.json.fleet[0].formation.id, "plain");
    assert.equal(response.json.voyages[0].cargo, null);
  } finally { await x.close(); }
});
