import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, normalizeConfig, validateConfig } from "../../dist/config/schema.js";

function config(refuel) {
  const c = structuredClone(DEFAULT_CONFIG);
  c.providers.fake.pool = { kind: "window", refuel };
  return c;
}

test("pool refuel defaults min_wait_minutes and preserves explicit zero", () => {
  const base = { provider: "codex", models: { sol: "gpt-5" } };
  assert.equal(normalizeConfig(config(base)).providers.fake.pool.refuel.min_wait_minutes, 30);
  assert.equal(normalizeConfig(config({ ...base, min_wait_minutes: 0 })).providers.fake.pool.refuel.min_wait_minutes, 0);
  assert.deepEqual(validateConfig(DEFAULT_CONFIG), []);
});

test("pool refuel validation rejects every malformed field with its path", () => {
  const cases = [
    [{ provider: "missing", models: { sol: "gpt" } }, "pool.refuel.provider"],
    [{ provider: "fake", models: { sol: "gpt" } }, "pool.refuel.provider"],
    [{ provider: "codex", models: {} }, "pool.refuel.models"],
    [{ provider: "codex", models: { sol: 7 } }, "pool.refuel.models"],
    [{ provider: "codex", models: { sol: "gpt" }, min_wait_minutes: -1 }, "pool.refuel.min_wait_minutes"],
    [{ provider: "codex", models: { sol: "gpt" }, min_wait_minutes: 1.5 }, "pool.refuel.min_wait_minutes"],
    [{ provider: "codex", models: { sol: "gpt" }, min_wait_minutes: "30" }, "pool.refuel.min_wait_minutes"],
    [{ provider: "codex", models: { sol: "gpt" }, surprise: true }, "pool.refuel.surprise"],
  ];
  for (const [value, path] of cases) assert.match(validateConfig(config(value)).join("; "), new RegExp(path.replaceAll(".", "\\.")));
  const bad = config(null); bad.providers.fake.pool.refuel = 1;
  assert.match(validateConfig(bad).join("; "), /providers\.fake\.pool\.refuel/);
});

test("c23: a given non-zero min_wait_minutes is kept", () => {
  const base = { provider: "codex", models: { sol: "gpt-5" }, min_wait_minutes: 45 };
  assert.equal(normalizeConfig(config(base)).providers.fake.pool.refuel.min_wait_minutes, 45);
});

test("c25: DEFAULT_CONFIG declares no pool.refuel and normalizes", () => {
  for (const provider of Object.values(DEFAULT_CONFIG.providers)) assert.equal(provider.pool?.refuel, undefined);
  const normalized = normalizeConfig(DEFAULT_CONFIG);
  for (const provider of Object.values(normalized.providers)) assert.equal(provider.pool?.refuel, undefined);
});
