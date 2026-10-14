// Spawns dist/cli/main.js against a fixture repo with the fake adapter's scripts.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { makeRepo, writeSpec, repoRoot } from "../helpers.mjs";

const CLI = path.join(repoRoot, "dist", "cli", "main.js");
const ENV = { ...process.env, NEXUS_FAKE_SCRIPTS: path.join(repoRoot, "tests", "fixtures", "scripts") };
function nexus(dir, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8", env: ENV });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const nexusFull = nexus;

test("init → system create → planet assign → moon assign → launch → inspect → dock, via the CLI, with --json", () => {
  const { dir, git, cleanup } = makeRepo();
  assert.equal(nexus(dir, "init").code, 0); git("add", "-A"); git("commit", "-qm", "init");
  const sys = JSON.parse(nexus(dir, "system", "create", "demo", "--title", "Demo", "--brief-text", "b", "--seed", "1", "--json").out);
  const planet = JSON.parse(nexus(dir, "planet", "assign", sys.systemId, "--stream", "P1", "--territory", "src/**", "--json").out);
  const spec = writeSpec(dir, "T1"); git("add", "-A"); git("commit", "-qm", "spec");
  const moon = JSON.parse(nexus(dir, "moon", "assign", planet.planetId, spec, "--json").out); assert.equal(moon.taskId, "T1");
  const l = nexusFull(dir, "moon", "launch", "T1", "--provider", "fake", "--json"); assert.equal(l.code, 0, l.err); assert.equal(JSON.parse(l.out).moonStatus, "audited");
  assert.match(l.err, /\[file_changed\] src\/lib\/thing\.js/, "events streamed to stderr");
  const q = nexusFull(dir, "voyage", "inspect", "T1", "--provider", "fake", "--json", "--quiet");
  assert.equal(JSON.parse(q.out).verdict.verdict, "APPROVE"); assert.ok(!/^\[\w+\]/m.test(q.err), "--quiet suppresses the stream");
  assert.ok(!/ExperimentalWarning/.test(q.err), "no node:sqlite ExperimentalWarning on stderr");
  assert.equal(JSON.parse(nexus(dir, "voyage", "dock", "T1", "--json").out).moonStatus, "merged");
  const st = nexus(dir, "status"); assert.match(st.out, /T1/); assert.match(st.out, /merged/);
  assert.match(nexus(dir, "fleet").out, /idle/);
  assert.match(nexus(dir, "events").out, /system\.created/);
  assert.match(nexus(dir, "db", "stats").out, /name|no stats recorded/);
  assert.match(nexus(dir, "db", "explain", "moons.byTask").out, /SEARCH|SCAN/);
  assert.equal(nexus(dir, "db", "rebuild").code, 0);
  cleanup();
});
test("refusals exit 2 with a one-line message; unknown command exits 1 with usage", () => {
  const { dir, cleanup } = makeRepo(); const r = nexus(dir, "status"); assert.equal(r.code, 2); assert.match(r.err, /nexus init/); assert.ok(!/at .*\.js:\d+/.test(r.err), "no stack on a refusal");
  const u = nexus(dir, "frobnicate"); assert.equal(u.code, 1); assert.match(u.err, /usage/i); cleanup();
});
test("validate --selftest", () => { const { dir, cleanup } = makeRepo(); const r = nexus(dir, "validate", "--selftest"); assert.equal(r.code, 0); assert.match(r.out, /selftest OK/); cleanup(); });
test("status <unknown-system> is a refusal", () => {
  const { dir, git, cleanup } = makeRepo(); nexus(dir, "init"); git("add", "-A"); git("commit", "-qm", "init");
  const r = nexus(dir, "status", "nope"); assert.equal(r.code, 2); assert.match(r.err, /unknown system 'nope'/); cleanup();
});
