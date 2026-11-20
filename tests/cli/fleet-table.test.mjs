import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { makeGalaxy, makeRepo, repoRoot } from "../helpers.mjs";
import { idleShip } from "../fixtures/world.mjs";
import { fleet } from "../../dist/server/commands/query.js";
import { fleetTable } from "../../dist/cli/format.js";

const CLI = path.join(repoRoot, "dist", "cli", "main.js");
const ENV = { ...process.env, NEXUS_FAKE_SCRIPTS: path.join(repoRoot, "tests", "fixtures", "scripts") };
function nexus(dir, ...args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8", env: ENV });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

test("fleetTable prints eight columns and accepts ship views or raw rows", async () => {
  const w = await makeGalaxy();
  try {
    idleShip(w.g.db, "fake", "delivery", "standard");
    const raw = w.g.db.all("ships.all");
    const view = fleet(w.g);
    const text = fleetTable(view);
    assert.equal(text, fleetTable(raw));
    assert.equal(text.split("\n")[0], "name         fleet  faction  job       weight    formation  status  voyages");
    assert.match(text, /Test Ship 1  fake   fake     delivery  standard  Ship       idle    0/);
  } finally { w.cleanup(); }
});

test("nexus fleet JSON shows ship identity and empty fleet prints only the header", async () => {
  const w = await makeGalaxy();
  try {
    const empty = nexus(w.dir, "fleet");
    assert.equal(empty.code, 0, empty.err);
    assert.equal(empty.out.trim(), "name  fleet  faction  job  weight  formation  status  voyages");
    idleShip(w.g.db, "fake", "delivery", "standard");
    const result = nexus(w.dir, "fleet", "--json");
    assert.equal(result.code, 0, result.err);
    const [ship] = JSON.parse(result.out);
    for (const key of ["name", "fleet", "faction", "job", "weight", "formation", "status", "voyage_count"]) assert.ok(Object.hasOwn(ship, key), key);
    assert.equal(typeof ship.formation, "object");
  } finally { w.cleanup(); }
});
