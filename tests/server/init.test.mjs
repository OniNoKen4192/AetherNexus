import { test } from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs"; import path from "node:path";
import { makeRepo } from "../helpers.mjs";
import { initGalaxy } from "../../dist/server/commands/init.js"; import { openGalaxy } from "../../dist/server/galaxy.js";
test("init writes config, gitignore and db and registers no ships; refuses second init without force", () => {
  const { dir, cleanup } = makeRepo(); const r = initGalaxy(dir);
  assert.ok(fs.existsSync(path.join(dir, ".nexus", "config.json"))); assert.ok(fs.existsSync(r.dbFile));
  assert.match(fs.readFileSync(path.join(dir, ".nexus", ".gitignore"), "utf8"), /nexus\.db/);
  assert.match(fs.readFileSync(path.join(dir, ".git", "info", "exclude"), "utf8"), /\.nexus\/worktrees\//);
  assert.equal(r.ships, 0, "no fleet is registered up front: a ship is commissioned when a job needs one");
  assert.throws(() => initGalaxy(dir), /already initialized/);
  const g = openGalaxy(dir); assert.equal(g.db.all("ships.all").length, r.ships);
  assert.deepEqual(g.db.all("events.all").filter((e) => e.kind.startsWith("ship.")), [], "init writes no ship event"); g.close(); cleanup();
});
test("openGalaxy refuses without config", () => { const { dir, cleanup } = makeRepo(); assert.throws(() => openGalaxy(dir), /nexus init/); cleanup(); });
