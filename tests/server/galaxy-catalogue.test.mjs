import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeGalaxy } from "../helpers.mjs";
import { BUILTIN } from "../../dist/core/catalogue/builtin.js";
import { openGalaxy } from "../../dist/server/galaxy.js";
import { Refusal } from "../../dist/server/errors.js";

const pinFake = (c) => { c.roles = { implement: ["fake"], review: ["fake"] }; };
const catalogueFile = (dir) => path.join(dir, ".nexus", "catalogue.json");
const configFile = (dir) => path.join(dir, ".nexus", "config.json");

function assertDatabaseUnlocked(dir) {
  const db = path.join(dir, ".nexus", "nexus.db");
  const moved = `${db}.moved`;
  fs.renameSync(db, moved);
  fs.renameSync(moved, db);
}

function cleanupClosed(fixture) {
  try { fixture.cleanup(); }
  catch (error) {
    if (!/database is not open/.test(String(error?.message))) throw error;
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
}

test("an opened galaxy carries the built-in catalogue", async () => {
  const { g, cleanup } = await makeGalaxy(pinFake);
  try { assert.deepEqual(g.catalogue, BUILTIN); } finally { cleanup(); }
});

test("an opened galaxy merges an owner formation", async () => {
  const fixture = await makeGalaxy(pinFake);
  fixture.g.close();
  fs.writeFileSync(catalogueFile(fixture.dir), JSON.stringify({ formations: [{
    id: "owner-scout", name: "Owner scout", job: "delivery",
    vessels: [{ hull: "scout", count: 1, role: "lead" }],
  }] }));
  const reopened = openGalaxy(fixture.dir);
  try {
    assert.ok(reopened.catalogue.formations.some((entry) => entry.id === "freighter"));
    assert.ok(reopened.catalogue.formations.some((entry) => entry.id === "owner-scout"));
  } finally {
    reopened.close();
    cleanupClosed(fixture);
  }
});

async function refusalFixture() {
  const fixture = await makeGalaxy(pinFake);
  fixture.g.close();
  return fixture;
}

test("invalid catalogue JSON is refused before the database is opened", async () => {
  const fixture = await refusalFixture();
  try {
    fs.writeFileSync(catalogueFile(fixture.dir), "{");
    assert.throws(() => openGalaxy(fixture.dir), (error) => error instanceof Refusal && /catalogue\.json/.test(error.message));
    assertDatabaseUnlocked(fixture.dir);
    fs.rmSync(catalogueFile(fixture.dir));
    const corrected = openGalaxy(fixture.dir);
    corrected.close();
    assertDatabaseUnlocked(fixture.dir);
  } finally { cleanupClosed(fixture); }
});

test("a catalogue with an unknown job is refused before the database is opened", async () => {
  const fixture = await refusalFixture();
  try {
    fs.writeFileSync(catalogueFile(fixture.dir), JSON.stringify({ formations: [{
      id: "wrong-job", name: "Wrong job", job: "exploration",
      vessels: [{ hull: "scout", count: 1, role: "lead" }],
    }] }));
    assert.throws(() => openGalaxy(fixture.dir), (error) => error instanceof Refusal && /catalogue\.json/.test(error.message));
    assertDatabaseUnlocked(fixture.dir);
    fs.rmSync(catalogueFile(fixture.dir));
    const corrected = openGalaxy(fixture.dir);
    corrected.close();
    assertDatabaseUnlocked(fixture.dir);
  } finally { cleanupClosed(fixture); }
});

test("an unknown configured weight is refused before the database is opened", async () => {
  const fixture = await refusalFixture();
  try {
    const config = JSON.parse(fs.readFileSync(configFile(fixture.dir), "utf8"));
    config.providers.codex.weights = { sol: "huge" };
    fs.writeFileSync(configFile(fixture.dir), JSON.stringify(config, null, 2));
    assert.throws(
      () => openGalaxy(fixture.dir),
      (error) => error instanceof Refusal && /providers\.codex\.weights\.sol/.test(error.message) && /huge/.test(error.message),
    );
    assertDatabaseUnlocked(fixture.dir);
    config.providers.codex.weights = { sol: "heavy" };
    fs.writeFileSync(configFile(fixture.dir), JSON.stringify(config, null, 2));
    const corrected = openGalaxy(fixture.dir);
    corrected.close();
    assertDatabaseUnlocked(fixture.dir);
  } finally { cleanupClosed(fixture); }
});

test("an owner catalogue weight may be used by a provider", async () => {
  const fixture = await refusalFixture();
  try {
    fs.writeFileSync(catalogueFile(fixture.dir), JSON.stringify({ weights: ["light", "standard", "heavy", "colossal"] }));
    const config = JSON.parse(fs.readFileSync(configFile(fixture.dir), "utf8"));
    config.providers.fake.weights = { sol: "colossal" };
    fs.writeFileSync(configFile(fixture.dir), JSON.stringify(config, null, 2));
    const reopened = openGalaxy(fixture.dir);
    try { assert.ok(reopened.catalogue.weights.includes("colossal")); } finally { reopened.close(); }
  } finally { cleanupClosed(fixture); }
});
