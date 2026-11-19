import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BUILTIN, PLAIN_FORMATION } from "../../dist/core/catalogue/builtin.js";
import { loadCatalogue, mergeCatalogue, validateCatalogue } from "../../dist/core/catalogue/load.js";
import { pickCargo, pickFormation, shipName } from "../../dist/core/catalogue/pick.js";
import { THEMES } from "../../dist/core/names.js";
import { mulberry32 } from "../../dist/core/rng.js";

const lead = { hull: "ship", count: 1, role: "lead" };
const formation = (id = "test") => ({ id, name: "Test", job: "delivery", vessels: [{ ...lead }] });

test("built-in catalogue is valid and covers starter weights", () => {
  assert.deepEqual(validateCatalogue(BUILTIN, "builtin"), []);
  for (const weight of ["light", "standard", "heavy"]) {
    assert.ok(BUILTIN.formations.some((entry) => entry.job === "delivery" && (entry.weights?.includes(weight) ?? true)));
    assert.ok(BUILTIN.formations.some((entry) => entry.job === "customs" && (!entry.weights || entry.weights.length === 0 || entry.weights.includes(weight))));
    assert.ok(BUILTIN.cargo.some((entry) => !entry.weights || entry.weights.length === 0 || entry.weights.includes(weight)));
  }
  assert.deepEqual(PLAIN_FORMATION, { id: "plain", name: "Ship", vessels: [{ hull: "ship", count: 1, role: "lead" }] });
});

test("formation picks match job, weight and faction", () => {
  for (let seed = 0; seed < 200; seed++) {
    const picked = pickFormation(BUILTIN, { job: "delivery", weight: "heavy", faction: "openai" }, mulberry32(seed));
    const source = BUILTIN.formations.find((entry) => entry.id === picked.id);
    assert.equal(source?.job, "delivery");
    assert.ok(!source?.weights || source.weights.length === 0 || source.weights.includes("heavy"));
    assert.ok(!source?.factions || source.factions.length === 0 || source.factions.includes("openai"));
  }
  const c = mergeCatalogue(BUILTIN, { formations: [
    { ...formation("open"), factions: ["openai"] },
    { ...formation("anthropic-only"), factions: ["anthropic"] },
  ] });
  for (let seed = 0; seed < 200; seed++) {
    assert.notEqual(pickFormation(c, { job: "delivery", weight: "light", faction: "openai" }, mulberry32(seed)).id, "anthropic-only");
  }
  const only = { ...c, formations: [formation("wrong"), { ...formation("anthropic-only"), factions: ["anthropic"] }] };
  only.formations[0].factions = ["openai"];
  assert.equal(pickFormation(only, { job: "delivery", weight: "light", faction: "anthropic" }, mulberry32(1)).id, "anthropic-only");
});

test("seeded formation, cargo and name picks are deterministic", () => {
  const result = (seed) => {
    const rng = mulberry32(seed);
    return [
      pickFormation(BUILTIN, { job: "delivery", weight: "heavy", faction: "openai" }, rng),
      pickCargo(BUILTIN, "heavy", rng),
      shipName(BUILTIN, { faction: "openai", theme: "classic" }, rng, new Set()),
    ];
  };
  assert.deepEqual(result(41), result(41));
  assert.notDeepEqual(result(41), result(42));
});

test("empty and unmatched catalogues use null and plain fallbacks", () => {
  const empty = { ...BUILTIN, formations: [], cargo: [] };
  assert.deepEqual(pickFormation(empty, { job: "survey", weight: "light", faction: "none" }, mulberry32(1)), PLAIN_FORMATION);
  assert.equal(pickCargo(empty, "light", mulberry32(1)), null);
  assert.deepEqual(pickFormation(BUILTIN, { job: "survey", weight: "light", faction: "none" }, mulberry32(1)), PLAIN_FORMATION);
  assert.equal(pickCargo(BUILTIN, "unknown", mulberry32(1)), null);
});

test("merge replaces by id, appends new ids and does not mutate inputs", () => {
  const base = structuredClone(BUILTIN);
  const extra = {
    weights: ["tiny", "large"],
    formations: [{ ...formation("freighter"), name: "Replacement" }, formation("new-formation")],
    cargo: [{ id: "trade-goods", label: "replacement" }, { id: "new-cargo", label: "new" }],
    names: { openai: { pools: { word: ["New"] }, patterns: ["{word}"] } },
  };
  const baseBefore = structuredClone(base);
  const extraBefore = structuredClone(extra);
  const merged = mergeCatalogue(base, extra);
  assert.deepEqual(merged.weights, ["tiny", "large"]);
  assert.equal(merged.formations.find((entry) => entry.id === "freighter")?.name, "Replacement");
  assert.equal(merged.formations.at(-1)?.id, "new-formation");
  assert.equal(merged.cargo.find((entry) => entry.id === "trade-goods")?.label, "replacement");
  assert.equal(merged.cargo.at(-1)?.id, "new-cargo");
  assert.deepEqual(merged.names.openai, extra.names.openai);
  assert.deepEqual(merged.names.anthropic, base.names.anthropic);
  assert.deepEqual(base, baseBefore);
  assert.deepEqual(extra, extraBefore);
  merged.formations[0].vessels[0].hull = "changed";
  merged.names.anthropic.pools.adjective[0] = "changed";
  assert.deepEqual(base, baseBefore);
});

test("loadCatalogue handles missing, merged, malformed and invalid files", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalogue-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "catalogue.json");
  assert.deepEqual(loadCatalogue(dir), BUILTIN);
  fs.writeFileSync(file, JSON.stringify({ cargo: [{ id: "letter", label: "a letter", weights: ["light"] }] }));
  assert.equal(loadCatalogue(dir).cargo.at(-1).id, "letter");
  fs.writeFileSync(file, "{");
  assert.throws(() => loadCatalogue(dir), (error) => error.message.includes(file));
  fs.writeFileSync(file, JSON.stringify({
    formations: [{ id: "bad-job", name: "Bad", job: "wrong", vessels: [{ ...lead }] }],
    cargo: [{ id: "bad-weight", label: "Bad", weights: ["impossible"] }],
  }));
  assert.throws(() => loadCatalogue(dir), (error) => error.message.includes(file) && error.message.includes("bad-job") && error.message.includes("bad-weight"));
});

test("validation rejects every required structural and semantic error", () => {
  const cases = [
    null,
    { weights: "light" },
    { formations: "bad" },
    { cargo: "bad" },
    { names: [] },
    { formations: [{ ...formation(), job: "wrong" }] },
    { formations: [{ ...formation(), weights: ["wrong"] }] },
    { cargo: [{ id: "x", label: "X", weights: ["wrong"] }] },
    { formations: [formation("same"), formation("same")] },
    { cargo: [{ id: "same", label: "A" }, { id: "same", label: "B" }] },
    { formations: [{ ...formation(), vessels: [{ hull: "ship", count: 1, role: "escort" }] }] },
    { formations: [{ ...formation(), vessels: [{ ...lead, count: 0 }] }] },
    { formations: [{ ...formation(), vessels: [{ ...lead, count: 1.5 }] }] },
    { formations: [{ ...formation(), vessels: [{ ...lead, role: "wrong" }] }] },
    { formations: [{ ...formation(), id: "" }] },
    { formations: [{ ...formation(), id: 1 }] },
    { formations: [{ ...formation(), name: "" }] },
    { formations: [{ ...formation(), name: 1 }] },
    { cargo: [{ id: "", label: "X" }] },
    { cargo: [{ id: 1, label: "X" }] },
    { cargo: [{ id: "x", label: "" }] },
    { cargo: [{ id: "x", label: 1 }] },
    { formations: [{ ...formation(), vessels: [{ ...lead, hull: "" }] }] },
    { formations: [{ ...formation(), vessels: [{ ...lead, hull: 1 }] }] },
    { names: { faction: { pools: { adjective: ["Bright"] }, patterns: ["{noun}"] } } },
    { names: { faction: { pools: { adjective: ["Bright"] }, patterns: [] } } },
    { names: { faction: { pools: { adjective: [] }, patterns: ["{adjective}"] } } },
    { formations: [{ ...formation(), factions: "openai" }] },
    { formations: [{ ...formation(), art: 7 }] },
    { names: { faction: { pools: [], patterns: ["Name"] } } },
  ];
  for (const [index, bad] of cases.entries()) {
    const errors = validateCatalogue(bad, `source-${index}`);
    assert.ok(errors.length > 0, `case ${index} should fail`);
    assert.ok(errors.every((error) => error.includes(`source-${index}`)), `case ${index} should name source`);
  }
});

test("shipName produces 500 unique faction and theme names", () => {
  for (const faction of ["openai", "unconfigured"]) {
    const used = new Set();
    const rng = mulberry32(99);
    for (let index = 0; index < 500; index++) shipName(BUILTIN, { faction, theme: "classic" }, rng, used);
    assert.equal(used.size, 500);
  }
});

test("unconfigured factions use the selected theme with classic as default", () => {
  const classic = shipName(BUILTIN, { faction: "none", theme: "classic" }, mulberry32(1), new Set());
  const unknown = shipName(BUILTIN, { faction: "none", theme: "unknown" }, mulberry32(1), new Set());
  const pulp = shipName(BUILTIN, { faction: "none", theme: "pulp" }, mulberry32(1), new Set());
  assert.ok(THEMES.classic.ships.includes(classic));
  assert.ok(THEMES.classic.ships.includes(unknown));
  assert.ok(THEMES.pulp.ships.includes(pulp));
});

test("returned formations are deep copies of catalogue entries and fallback", () => {
  const catalogue = { ...BUILTIN, formations: [{ ...formation("copy"), art: "future" }] };
  const picked = pickFormation(catalogue, { job: "delivery", weight: "light", faction: "openai" }, mulberry32(1));
  picked.name = "Changed";
  picked.vessels[0].hull = "changed";
  assert.equal(catalogue.formations[0].name, "Test");
  assert.equal(catalogue.formations[0].vessels[0].hull, "ship");
  const fallback = pickFormation({ ...BUILTIN, formations: [] }, { job: "survey", weight: "light", faction: "none" }, mulberry32(1));
  fallback.vessels[0].hull = "changed";
  assert.deepEqual(PLAIN_FORMATION, { id: "plain", name: "Ship", vessels: [{ hull: "ship", count: 1, role: "lead" }] });
});
