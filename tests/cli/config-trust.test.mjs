import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { makeRepo, repoRoot } from "../helpers.mjs";

const CLI = path.join(repoRoot, "dist", "cli", "main.js");
const ENV = { ...process.env, NEXUS_FAKE_SCRIPTS: path.join(repoRoot, "tests", "fixtures", "scripts") };

function nexus(dir, ...args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8", env: ENV });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

function initializedRepo() {
  const repo = makeRepo();
  assert.equal(nexus(repo.dir, "init").code, 0);
  repo.git("add", "-A");
  repo.git("commit", "-qm", "init");
  return repo;
}

test("config set trust changes the rung and reports an unchanged rung", () => {
  const { dir, cleanup } = initializedRepo();
  try {
    const changed = nexus(dir, "config", "set", "trust", "verdicts");
    assert.equal(changed.code, 0, changed.err);
    assert.equal(changed.out.trim(), "rung: manual -> verdicts");
    const config = JSON.parse(fs.readFileSync(path.join(dir, ".nexus", "config.json"), "utf8"));
    assert.equal(config.automation.level, "verdicts");

    const unchanged = nexus(dir, "config", "set", "trust", "verdicts");
    assert.equal(unchanged.code, 0, unchanged.err);
    assert.equal(unchanged.out.trim(), "rung: verdicts (unchanged)");
  } finally {
    cleanup();
  }
});

test("config set trust supports JSON output", () => {
  const { dir, cleanup } = initializedRepo();
  try {
    const response = nexus(dir, "config", "set", "trust", "verdicts", "--json");
    assert.equal(response.code, 0, response.err);
    assert.deepEqual(JSON.parse(response.out), { level: "verdicts", from: "manual", changed: true });
  } finally {
    cleanup();
  }
});

test("config set trust reports unavailable levels as refusals", () => {
  const { dir, cleanup } = initializedRepo();
  try {
    const response = nexus(dir, "config", "set", "trust", "autopilot");
    assert.equal(response.code, 2);
    assert.match(response.err, /not available yet/);
  } finally {
    cleanup();
  }
});

test("incomplete config commands print usage", () => {
  const { dir, cleanup } = initializedRepo();
  try {
    for (const args of [["config"], ["config", "set"], ["config", "set", "trust"]]) {
      const response = nexus(dir, ...args);
      assert.equal(response.code, 1, args.join(" "));
      assert.match(response.err, /usage: nexus/);
      assert.match(response.err, /config set trust <manual\|verdicts\|roundabout>/);
    }
  } finally {
    cleanup();
  }
});
