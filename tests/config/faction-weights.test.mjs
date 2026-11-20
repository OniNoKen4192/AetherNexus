import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, normalizeConfig, validateConfig } from "../../dist/config/schema.js";
import { factionOf, weightFor } from "../../dist/core/weight.js";

function weighted(weights) {
  const c = structuredClone(DEFAULT_CONFIG);
  c.providers.fake.weights = weights;
  return normalizeConfig(c);
}

test("weightFor uses a model id", () => {
  assert.equal(weightFor(weighted({ model: "heavy", default: "light" }), "fake", { role: "implement", model: "model", tier: "luna" }), "heavy");
});

test("weightFor uses a delivery tier when no model is given", () => {
  assert.equal(weightFor(weighted({ sol: "heavy", default: "light" }), "fake", { role: "implement", tier: "sol" }), "heavy");
});

test("weightFor ignores a tier when a model is given", () => {
  assert.equal(weightFor(weighted({ sol: "heavy", default: "light" }), "fake", { role: "implement", model: "unknown", tier: "sol" }), "light");
});

test("weightFor ignores a tier for review", () => {
  assert.equal(weightFor(weighted({ sol: "light", default: "heavy" }), "fake", { role: "review", tier: "sol" }), "heavy");
});

test("weightFor uses the default mapping", () => {
  assert.equal(weightFor(weighted({ default: "heavy" }), "fake", { role: "implement" }), "heavy");
});

test("weightFor returns standard for an empty or absent map", () => {
  assert.equal(weightFor(weighted({}), "fake", { role: "implement" }), "standard");
  const c = structuredClone(DEFAULT_CONFIG);
  delete c.providers.fake.weights;
  assert.equal(weightFor(normalizeConfig(c), "fake", { role: "implement" }), "standard");
});

test("weightFor returns standard for an unknown provider", () => {
  assert.equal(weightFor(weighted({ default: "heavy" }), "missing", { role: "implement" }), "standard");
});

test("weightFor skips a null tier and uses own properties", () => {
  assert.equal(weightFor(weighted({ default: "light" }), "fake", { role: "implement", tier: null }), "light");
  assert.equal(weightFor(weighted({}), "fake", { role: "implement", tier: "constructor" }), "standard");
});

test("default factions and weights normalize as declared", () => {
  const c = normalizeConfig(DEFAULT_CONFIG);
  assert.equal(factionOf(c, "codex"), "openai");
  assert.equal(factionOf(c, "claude"), "anthropic");
  assert.equal(factionOf(c, "fake"), "fake");
  assert.equal(factionOf(c, "missing"), "missing");
  for (const [tier, weight] of [["sol", "heavy"], ["terra", "standard"], ["luna", "light"]]) {
    assert.equal(weightFor(c, "codex", { role: "implement", tier }), weight);
  }
  assert.equal(weightFor(c, "claude", { role: "review" }), "heavy");
  assert.equal(weightFor(c, "claude", { role: "implement", model: "claude-haiku-5-5" }), "light");
  assert.equal(weightFor(c, "fake", { role: "implement" }), "standard");
});

test("normalization defaults a faction and preserves an explicit faction", () => {
  const c = structuredClone(DEFAULT_CONFIG);
  c.providers.fake.faction = "independent";
  delete c.providers.codex.faction;
  const normalized = normalizeConfig(c);
  assert.equal(normalized.providers.fake.faction, "independent");
  assert.equal(normalized.providers.codex.faction, "codex");
  assert.deepEqual(validateConfig(DEFAULT_CONFIG), []);
});

test("provider faction and weights validation names every malformed path", () => {
  const cases = [
    ["faction", ""], ["faction", 7], ["weights", []], ["weights", "heavy"],
    ["weights", { sol: 7 }], ["weights", { sol: "" }],
  ];
  for (const [key, value] of cases) {
    const c = structuredClone(DEFAULT_CONFIG);
    c.providers.fake[key] = value;
    assert.match(validateConfig(c).join("; "), new RegExp(`providers\\.fake\\.${key}`));
  }
});
