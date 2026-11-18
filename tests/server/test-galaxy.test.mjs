import { test } from "node:test"; import assert from "node:assert/strict";
import { makeGalaxy } from "../helpers.mjs";

test("a test galaxy never flies a real adapter, even when the config patch leaves the default roles", async () => {
  const w = await makeGalaxy(() => {});
  try {
    assert.deepEqual(w.g.config.roles.implement.slice(0, 1), ["codex"], "the default config names a real provider first");
    for (const [id, provider] of Object.entries(w.g.config.providers)) {
      if (provider.adapter === "fake") continue;
      assert.throws(() => w.g.adapters[id].dispatch({}, {}), /test galaxy: provider/, id);
    }
    assert.equal(typeof w.g.adapters.fake.dispatch, "function");
  } finally { w.cleanup(); }
});
