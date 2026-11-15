import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeGalaxy } from "../helpers.mjs";
import { reloadConfig, setAutomationLevel } from "../../dist/server/commands/config.js";
import { Refusal } from "../../dist/server/errors.js";

const withTwoProviders = (c) => {
  c.providers.fake2 = { ...c.providers.fake };
  c.roles = { implement: ["fake", "fake2"], review: ["fake"] };
};

const configPath = (w) => path.join(w.dir, ".nexus", "config.json");
const configText = (w) => fs.readFileSync(configPath(w), "utf8");
const configJson = (w) => JSON.parse(configText(w));
const events = (w) => w.g.db.all("events.all").map((row) => ({
  ...row,
  payload: JSON.parse(row.payload),
}));

test("sets each selectable rung while preserving other configuration", async () => {
  const w = await makeGalaxy(withTwoProviders);
  try {
    const before = configJson(w);
    for (const [level, from] of [["verdicts", "manual"], ["roundabout", "verdicts"], ["manual", "roundabout"]]) {
      assert.deepEqual(setAutomationLevel(w.g, { level }), { level, from, changed: true });
      assert.equal(w.g.config.automation.level, level);
      assert.equal(configJson(w).automation.level, level);
    }
    const after = configJson(w);
    assert.equal(after.automation.max_fix_rounds, before.automation.max_fix_rounds);
    assert.deepEqual(after.roles, before.roles);
  } finally { w.cleanup(); }
});

test("logs tree.written before config.changed with the writer pid", async () => {
  const w = await makeGalaxy();
  try {
    setAutomationLevel(w.g, { level: "verdicts" });
    const logged = events(w);
    const changedIndex = logged.findLastIndex((event) => event.kind === "config.changed");
    assert.ok(changedIndex > 0);
    assert.deepEqual(logged[changedIndex].payload, {
      key: "automation.level", from: "manual", to: "verdicts", pid: process.pid,
    });
    const writtenIndex = logged.findLastIndex((event, index) => index < changedIndex && event.kind === "tree.written");
    assert.ok(writtenIndex >= 0);
    assert.ok(logged[writtenIndex].payload.paths.includes(".nexus/config.json"));
  } finally { w.cleanup(); }
});

test("setting the current rung is a byte-identical no-op with no event", async () => {
  const w = await makeGalaxy();
  try {
    const before = configText(w);
    const eventCount = events(w).length;
    assert.deepEqual(setAutomationLevel(w.g, { level: "manual" }), {
      level: "manual", from: "manual", changed: false,
    });
    assert.equal(configText(w), before);
    assert.equal(events(w).length, eventCount);
  } finally { w.cleanup(); }
});

test("future and unknown rungs refuse without changing the file", async () => {
  const w = await makeGalaxy();
  try {
    for (const level of ["highways", "autopilot"]) {
      const before = configText(w);
      assert.throws(() => setAutomationLevel(w.g, { level }), (err) => err instanceof Refusal && /is not available yet/.test(err.message));
      assert.equal(configText(w), before);
    }
    for (const level of ["turbo", ""]) {
      assert.throws(() => setAutomationLevel(w.g, { level }), (err) => err instanceof Refusal && /level must be manual, verdicts or roundabout/.test(err.message));
    }
  } finally { w.cleanup(); }
});

test("invalid JSON refuses without changing bytes, memory, or events", async () => {
  const w = await makeGalaxy();
  try {
    const beforeConfig = structuredClone(w.g.config);
    const eventCount = events(w).length;
    fs.writeFileSync(configPath(w), "{ not json");
    const beforeBytes = configText(w);
    assert.throws(
      () => setAutomationLevel(w.g, { level: "verdicts" }),
      (err) => err instanceof Refusal && err.message.includes(".nexus/config.json is not valid JSON"),
    );
    assert.equal(configText(w), beforeBytes);
    assert.deepEqual(w.g.config, beforeConfig);
    assert.equal(events(w).length, eventCount);
  } finally { w.cleanup(); }
});

test("starts from disk and preserves a hand edit", async () => {
  const w = await makeGalaxy(withTwoProviders);
  try {
    const edited = configJson(w);
    edited.roles.implement.reverse();
    fs.writeFileSync(configPath(w), JSON.stringify(edited, null, 2) + "\n");
    setAutomationLevel(w.g, { level: "verdicts" });
    assert.deepEqual(configJson(w).roles.implement, ["fake2", "fake"]);
  } finally { w.cleanup(); }
});

test("creates a normalized automation block when it is absent", async () => {
  const w = await makeGalaxy((c) => { delete c.automation; });
  try {
    assert.deepEqual(setAutomationLevel(w.g, { level: "verdicts" }), {
      level: "verdicts", from: "manual", changed: true,
    });
    assert.deepEqual(configJson(w).automation, { level: "verdicts", max_fix_rounds: 2 });
  } finally { w.cleanup(); }
});

test("reloadConfig follows a valid disk edit", async () => {
  const w = await makeGalaxy();
  try {
    const edited = configJson(w);
    edited.automation.level = "roundabout";
    fs.writeFileSync(configPath(w), JSON.stringify(edited, null, 2) + "\n");
    assert.deepEqual(reloadConfig(w.g), { ok: true });
    assert.equal(w.g.config.automation.level, "roundabout");
  } finally { w.cleanup(); }
});

test("reloadConfig leaves memory untouched for invalid and missing files", async (t) => {
  for (const [name, alter] of [
    ["invalid", (w) => fs.writeFileSync(configPath(w), "{ not json")],
    ["missing", (w) => fs.rmSync(configPath(w))],
  ]) {
    await t.test(name, async () => {
      const w = await makeGalaxy();
      try {
        const before = structuredClone(w.g.config);
        alter(w);
        const result = reloadConfig(w.g);
        assert.equal(result.ok, false);
        assert.ok(result.error.length > 0);
        assert.deepEqual(w.g.config, before);
      } finally { w.cleanup(); }
    });
  }
});

test("setting the rung the file was hand-edited to brings the running config along", async () => {
  const w = await makeGalaxy(withTwoProviders);
  try {
    const file = configJson(w);
    file.automation = { ...file.automation, level: "verdicts" };
    fs.writeFileSync(configPath(w), JSON.stringify(file, null, 2) + "\n");
    assert.equal(w.g.config.automation.level, "manual", "the hand edit has not been read yet");
    const bytes = configText(w);
    const before = events(w).length;

    assert.deepEqual(setAutomationLevel(w.g, { level: "verdicts" }), { level: "verdicts", from: "verdicts", changed: false });
    assert.equal(w.g.config.automation.level, "verdicts");
    assert.equal(configText(w), bytes);
    assert.equal(events(w).length, before);
  } finally {
    w.cleanup();
  }
});
