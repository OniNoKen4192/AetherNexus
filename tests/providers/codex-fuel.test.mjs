import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { codexSessionsRoot, readCodexFuel } from "../../dist/providers/codex-mcp/fuel.js";

const fixtureRoot = path.join(process.cwd(), "tests", "fixtures", "codex-sessions");
const fixtureId = "01a1e11a-deaf-7e60-a634-bf3cc2f96ec0";
const data = (events) => events.map((event) => event.data);
const snapshot = (primary, secondary = null) => JSON.stringify({ payload: { rate_limits: { primary, secondary } } });
const window = (used_percent, window_minutes = 60, resets_at = 1800000000) => ({ used_percent, window_minutes, resets_at });

function tempRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "codex-fuel-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function log(root, id, lines, subdir = "2026/11/16") {
  const dir = path.join(root, subdir); mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-now-${id}.jsonl`);
  writeFileSync(file, `${lines.join("\n")}\n`); return file;
}

test("fixture uses newest snapshot and returns primary then secondary", () => {
  assert.deepEqual(data(readCodexFuel(fixtureRoot, fixtureId)), [
    { window: "10080m", used: 0.235, resets_at: new Date(1795186480000).toISOString() },
    { window: "300m", used: 0.61, resets_at: new Date(1794760000000).toISOString() },
  ]);
});

test("null secondary returns one reading", () => {
  const t = tempRoot(); try {
    log(t.root, "one", [snapshot(window(20), null)]);
    assert.equal(readCodexFuel(t.root, "one").length, 1);
  } finally { t.cleanup(); }
});

test("missing root, missing session, and no snapshot return no readings", () => {
  const t = tempRoot(); try {
    log(t.root, "plain", [JSON.stringify({ payload: { harmless: true } })]);
    assert.deepEqual(readCodexFuel(path.join(t.root, "missing"), "plain"), []);
    assert.deepEqual(readCodexFuel(t.root, "absent"), []);
    assert.deepEqual(readCodexFuel(t.root, "plain"), []);
  } finally { t.cleanup(); }
});

test("cut-off final JSON falls back to the prior snapshot", () => {
  const t = tempRoot(); try {
    const file = log(t.root, "cut", [snapshot(window(40)), '{"payload":{"rate_limits":']);
    writeFileSync(file, `${snapshot(window(40))}\n{"payload":{"rate_limits":`);
    assert.equal(data(readCodexFuel(t.root, "cut"))[0].used, 0.4);
  } finally { t.cleanup(); }
});

test("large log finds a snapshot near the end", () => {
  const t = tempRoot(); try {
    const padding = `${JSON.stringify({ padding: "x".repeat(1000) })}\n`.repeat(5200);
    const file = log(t.root, "large", []);
    writeFileSync(file, `${padding}${snapshot(window(75, 300))}\n{"after":1}\n{"after":2}\n`);
    assert.equal(data(readCodexFuel(t.root, "large"))[0].used, 0.75);
  } finally { t.cleanup(); }
});

test("invalid usage is dropped and usages are clamped", () => {
  const t = tempRoot(); try {
    log(t.root, "bad", [snapshot(window("x"), window(10))]);
    assert.deepEqual(data(readCodexFuel(t.root, "bad")).map((x) => x.used), [0.1]);
    log(t.root, "low", [snapshot(window(-3))]);
    log(t.root, "high", [snapshot(window(250))]);
    assert.equal(data(readCodexFuel(t.root, "low"))[0].used, 0);
    assert.equal(data(readCodexFuel(t.root, "high"))[0].used, 1);
  } finally { t.cleanup(); }
});

test("unsafe and empty thread ids return no readings", () => {
  for (const id of ["", "../x", "a/b", "*"]) assert.deepEqual(readCodexFuel(fixtureRoot, id), []);
});

test("newest matching file by modification time wins", () => {
  const t = tempRoot(); try {
    const old = log(t.root, "same", [snapshot(window(10))], "2026/11/15");
    const fresh = log(t.root, "same", [snapshot(window(90))], "2026/11/16");
    utimesSync(old, new Date(1000), new Date(1000)); utimesSync(fresh, new Date(2000), new Date(2000));
    assert.equal(data(readCodexFuel(t.root, "same"))[0].used, 0.9);
  } finally { t.cleanup(); }
});

test("codexSessionsRoot respects non-empty CODEX_HOME and otherwise uses homedir", () => {
  assert.equal(codexSessionsRoot({ CODEX_HOME: "/x" }), path.join("/x", "sessions"));
  assert.equal(codexSessionsRoot({}), path.join(homedir(), ".codex", "sessions"));
  assert.equal(codexSessionsRoot({ CODEX_HOME: "" }), path.join(homedir(), ".codex", "sessions"));
});
