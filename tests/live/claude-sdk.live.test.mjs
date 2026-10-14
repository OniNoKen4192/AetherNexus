// Spends the user's Claude pool. Runs only with NEXUS_LIVE set; never in CI.
import { test } from "node:test"; import assert from "node:assert/strict";
import { worldWithMoon } from "../fixtures/world.mjs";
import { launchMoon } from "../../dist/server/commands/launch.js";

test("live: one implement voyage against a scratch repo", { skip: !process.env.NEXUS_LIVE }, async () => {
  const w = await worldWithMoon(
    "happy",
    (c) => { c.providers = { claude: { adapter: "claude-sdk", auth: "login", max_turns: 20 } }; c.roles = { implement: ["claude"], review: ["claude"] }; },
    (text) => text.replace("node run-tests.mjs", 'node -e "process.exit(0)"'),
  );
  try {
    const r = await launchMoon(w.g, { taskId: "T1" });
    assert.equal(r.moonStatus, "audited");
    const n = w.g.db.raw.prepare("SELECT count(*) AS n FROM events WHERE kind = 'voyage.event'").get().n;
    assert.ok(n > 0, "voyage.event rows exist");
  } finally { w.cleanup(); }
});
