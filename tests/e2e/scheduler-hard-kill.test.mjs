import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { rowToEvent } from "../../dist/db/events.js";
import { dumpProjections, rebuild } from "../../dist/db/rebuild.js";
import { openGalaxy } from "../../dist/server/galaxy.js";
import { startServer } from "../../dist/server/http/server.js";
import { pidAlive } from "../../dist/server/lock.js";
import { repoRoot } from "../helpers.mjs";

async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${fn}`);
    await delay(10);
  }
}

test("after a hard kill the next server parks the moon whose voyage's process is gone and carries on", async () => {
  const child = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(repoRoot, "tests", "fixtures", "hard-kill-child.mjs")], { encoding: "utf8" });
  let info;
  try { info = JSON.parse(child.stdout.trim().split("\n").pop()); }
  catch { assert.fail(`the child did not report: status ${child.status}, signal ${child.signal}\n${child.stdout}\n${child.stderr}`); }
  const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-web-"));
  let g, srv;
  try {
    assert.equal(pidAlive(info.pid), false, "the first server is gone");
    g = openGalaxy(info.dir, { scriptsDir: path.join(repoRoot, "tests", "fixtures", "scripts") });
    const moon = (id) => g.db.get("moons.byTask", { task_id: id });
    const log = () => g.db.all("events.since", { id: 0 }).map(rowToEvent);
    // What the kill left behind: a voyage still in flight in the log, and no freighter sent to C yet.
    assert.equal(moon("T1").status, "implementing");
    assert.equal(g.db.all("voyages.inFlight").length, 1);
    assert.equal(moon("C").status, "emitted");
    const mark = g.db.get("events.maxId").id;

    srv = await startServer(g, { port: 0, webRoot, pollMs: 20, schedulerTickMs: 200 });
    await until(() => moon("C").status === "merged" && moon("T1").status === "adrift");
    await delay(300);

    const acted = log().filter((e) => e.id > mark && e.kind === "scheduler.acted").map((e) => `${e.payload.action} ${e.payload.task_id}`);
    assert.deepEqual(acted, ["park_stale T1", "send C", "inspect C", "dock C"]);
    assert.equal(moon("T1").status, "adrift");
    assert.match(moon("T1").park_reason, /^stale:/);
    const decisions = g.db.all("decisions.pendingByTarget", { target_id: "T1" });
    assert.equal(decisions.length, 1);
    assert.match(decisions[0].reasoning, /parked by the scheduler/);
    assert.deepEqual(g.db.all("voyages.byAssignment", { assignment_id: moon("T1").assignment_id }).map((v) => `${v.role}/${v.round}/${v.status}`), ["implement/1/adrift"]);
    assert.deepEqual(g.db.all("voyages.inFlight"), []);

    await srv.close(); srv = undefined;
    const before = dumpProjections(g.db);
    rebuild(g.db);
    assert.equal(dumpProjections(g.db), before, "rebuild byte-equal");
  } finally {
    try { if (srv) await srv.close(); } catch { /* already failing */ }
    try { g?.close(); } catch { /* already failing */ }
    for (const dir of [info.dir, info.webRoot, webRoot]) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
});
