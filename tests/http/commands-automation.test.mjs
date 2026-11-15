import assert from "node:assert/strict";
import test from "node:test";
import { startWorld } from "./helpers.mjs";

test("config.automation changes the trust rung and updates the snapshot", async () => {
  const x = await startWorld("happy");
  try {
    const response = await x.api("/api/commands/config.automation", { method: "POST", body: { level: "verdicts" } });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json.result, { level: "verdicts", from: "manual", changed: true });

    const snapshot = await x.api("/api/snapshot");
    assert.equal(snapshot.status, 200);
    assert.equal(snapshot.json.rung, "verdicts");
  } finally {
    await x.close();
  }
});

test("config.automation preserves trust-level refusal messages", async () => {
  const x = await startWorld("happy");
  try {
    const unavailable = await x.api("/api/commands/config.automation", { method: "POST", body: { level: "autopilot" } });
    assert.equal(unavailable.status, 409);
    assert.match(unavailable.json.error, /not available yet/);

    const unknown = await x.api("/api/commands/config.automation", { method: "POST", body: { level: "turbo" } });
    assert.equal(unknown.status, 409);
    assert.match(unknown.json.error, /level must be/);
  } finally {
    await x.close();
  }
});

test("config.automation rejects malformed input", async () => {
  const x = await startWorld("happy");
  try {
    for (const body of [{}, { level: 3 }, { level: "" }, { level: "verdicts", extra: 1 }]) {
      const response = await x.api("/api/commands/config.automation", { method: "POST", body });
      assert.equal(response.status, 400, JSON.stringify(body));
    }
  } finally {
    await x.close();
  }
});
