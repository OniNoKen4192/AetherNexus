import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { append } from "../../dist/db/events.js";
import { startWorld } from "./helpers.mjs";

const waitFor = async (fn, ms = 5000) => { const end = Date.now() + ms; for (;;) { const value = await fn(); if (value) return value; if (Date.now() >= end) throw new Error("timed out"); await new Promise((resolve) => setTimeout(resolve, 20)); } };
const iso = (ms = 0) => new Date(Date.now() + ms).toISOString();
function config(c) { c.providers.fake.pool = { kind: "window", reserve_floor: 0.1 }; c.roles = { implement: ["fake"], review: ["fake"] }; }
function low(x) { const resets_at = iso(3_600_000); append(x.w.g.db, { kind: "fuel.reading", provider: "fake", payload: { window: "5h", used: 0.95, resets_at, source: "reported" } }); return resets_at; }

test("17. HTTP validates fuel command booleans and accepts an override", async () => {
  const x = await startWorld("happy", config);
  try {
    low(x);
    for (const [command, body, field] of [
      ["delivery.send", { taskId: "T1", override: "yes" }, "override"],
      ["delivery.send", { taskId: "T1", refuel: 1 }, "refuel"],
      ["customs.send", { taskId: "T1", override: null }, "override"],
    ]) { const r = await x.api(`/api/commands/${command}`, { method: "POST", body }); assert.equal(r.status, 400); assert.match(r.json.error, new RegExp(`field '${field}'`)); }
    const accepted = await x.api("/api/commands/delivery.send", { method: "POST", body: { taskId: "T1", override: true } });
    assert.equal(accepted.status, 202);
    await waitFor(() => x.w.g.db.get("moons.byTask", { task_id: "T1" }).status === "audited");
  } finally { await x.close(); }
});

test("18. HTTP returns a held launch refusal and its structured details", async () => {
  const x = await startWorld("happy", config);
  try { const until = low(x); const r = await x.api("/api/commands/delivery.send", { method: "POST", body: { taskId: "T1" } }); assert.equal(r.status, 409); assert.match(r.json.error, /waiting on fake fuel \(low\)/); assert.deepEqual(r.json.details, { provider: "fake", reason: "low", until, can_refuel: null }); } finally { await x.close(); }
});

test("19. HTTP inspect rejects a refuel field", async () => {
  const x = await startWorld("happy", config);
  try { const r = await x.api("/api/commands/customs.send", { method: "POST", body: { taskId: "T1", refuel: true } }); assert.equal(r.status, 400); assert.match(r.json.error, /unexpected field 'refuel'/); } finally { await x.close(); }
});

test("20. HTTP can drop cargo awaiting pickup while reply remains refused", async () => {
  const x = await startWorld("wall", config);
  try {
    const launched = await x.api("/api/commands/delivery.send", { method: "POST", body: { taskId: "T1" } }); assert.equal(launched.status, 202);
    await waitFor(() => x.w.g.db.get("moons.byTask", { task_id: "T1" }).status === "awaiting_pickup");
    const detail = await x.api("/api/moons/T1"); assert.deepEqual(detail.json.actions, ["send", "cancel_delivery"]);
    const reply = await x.api("/api/commands/moon.reply", { method: "POST", body: { taskId: "T1", note: "go" } }); assert.equal(reply.status, 409);
    const worktree = path.join(x.w.dir, ".nexus", "worktrees", "T1"); assert.equal(fs.existsSync(worktree), true); assert.equal(x.w.g.git.branchExists("nexus/T1"), true);
    const dropped = await x.api("/api/commands/delivery.cancel", { method: "POST", body: { taskId: "T1" } }); assert.equal(dropped.status, 200);
    assert.equal(fs.existsSync(worktree), false); assert.equal(x.w.g.git.branchExists("nexus/T1"), false);
    const moon = x.w.g.db.get("moons.byId", { id: x.w.moonId }); assert.equal(moon.task_id, null); assert.equal(moon.assignment_id, null);
  } finally { await x.close(); }
});
