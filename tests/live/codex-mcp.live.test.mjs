// Spends the user's Codex pool. Runs only with NEXUS_LIVE set; never in CI.
import { test } from "node:test"; import assert from "node:assert/strict";
import { worldWithMoon } from "../fixtures/world.mjs";
import { launchMoon } from "../../dist/server/commands/launch.js";

test("live: codex implements, fake reviews", { skip: !process.env.NEXUS_LIVE }, async () => {
  const w = await worldWithMoon(
    "happy",
    (c) => { c.providers = { ...c.providers, codex: { adapter: "codex-mcp", models: {} } }; c.roles = { implement: ["codex"], review: ["fake"] }; },
    (spec) => spec.replace(/node run-tests\.mjs/g, 'node -e "process.exit(0)"'),
  );
  try {
    const r = await launchMoon(w.g, { taskId: "T1" });
    assert.equal(r.moonStatus, "audited");
  } finally { w.cleanup(); }
});
