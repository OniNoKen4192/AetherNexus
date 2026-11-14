import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { append } from "../../dist/db/events.js";
import { openDb } from "../../dist/db/open.js";
import { followEvents } from "../../dist/server/follow.js";
import { makeGalaxy, repoRoot } from "../helpers.mjs";

const CLI = path.join(repoRoot, "dist", "cli", "main.js");
const event = (paths = ["x"]) => ({ kind: "tree.written", payload: { paths } });

async function waitFor(check, message, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

test("followEvents drains pages in order, updates its cursor, and stops delivery", async () => {
  const { g, cleanup } = await makeGalaxy();
  let follower;
  try {
    const existing = g.db.all("events.all").length;
    for (let i = existing; i < 1200; i++) append(g.db, event([String(i)]));
    const pages = [];
    let returned = false;
    follower = followEvents(g.db, {
      since: 0,
      pollMs: 20,
      onEvents(rows) { pages.push(rows); if (!returned) assert.ok(rows.length > 0); },
    });
    returned = true;

    const initial = pages.flat();
    assert.equal(initial.length, 1200);
    assert.ok(pages.length > 1);
    assert.ok(pages.every((rows) => rows.length <= 500));
    assert.deepEqual(initial.map((row) => row.id), Array.from({ length: 1200 }, (_, i) => i + 1));
    assert.equal(follower.cursor(), initial.at(-1).id);

    const next = append(g.db, event(["after-initial"]));
    await waitFor(() => pages.flat().some((row) => row.id === next.id), "new event was not delivered");
    assert.equal(follower.cursor(), next.id);
    follower.stop();
    append(g.db, event(["after-stop"]));
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(pages.flat().at(-1).id, next.id);
  } finally {
    follower?.stop();
    cleanup();
  }
});

test("followEvents sees another database handle and waits when since is the maximum", async () => {
  const { g, cleanup } = await makeGalaxy();
  const existing = append(g.db, event(["existing"]));
  const second = openDb(g.paths.dbFile);
  const rows = [];
  const follower = followEvents(g.db, { since: existing.id, pollMs: 20, onEvents: (page) => rows.push(...page) });
  try {
    assert.deepEqual(rows, []);
    assert.equal(follower.cursor(), existing.id);
    const added = append(second, event(["second-handle"]));
    await waitFor(() => rows.length === 1, "event from second handle was not delivered");
    assert.deepEqual(rows.map((row) => row.id), [added.id]);
    assert.equal(follower.cursor(), added.id);
  } finally {
    follower.stop();
    second.close();
    cleanup();
  }
});

test("nexus events --follow --json prints an event appended after startup", async () => {
  const { dir, g, cleanup } = await makeGalaxy();
  const child = spawn(process.execPath, [CLI, "events", "--follow", "--json"], {
    cwd: dir,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    await waitFor(
      () => stdout.split(/\r?\n/).some((text) => text.trim() !== ""),
      `CLI did not print the existing log; stderr: ${stderr}`,
      5000,
    );
    assert.equal(child.exitCode, null, `CLI exited before following; stderr: ${stderr}`);
    const added = append(g.db, event(["cli-follow-marker"]));
    const line = await waitFor(() => stdout.split(/\r?\n/).find((text) => text.includes("cli-follow-marker")), `CLI event not printed; stderr: ${stderr}`, 5000);
    const parsed = JSON.parse(line);
    assert.equal(parsed.id, added.id);
    assert.equal(parsed.kind, "tree.written");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGINT");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
    if (child.exitCode === null && child.signalCode === null) child.kill();
    cleanup();
  }
});

test("nexus events --follow table mode prints the header once", async () => {
  const { dir, g, cleanup } = await makeGalaxy();
  const child = spawn(process.execPath, [CLI, "events", "--follow"], {
    cwd: dir,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    await waitFor(
      () => stdout.split(/\r?\n/).some((text) => text.includes("ship.registered")),
      `CLI did not print the existing ship.registered row; stderr: ${stderr}`,
      5000,
    );
    assert.equal(child.exitCode, null, `CLI exited before following; stderr: ${stderr}`);

    const first = append(g.db, event(["table-follow-marker-one"]));
    const firstLine = await waitFor(
      () => stdout.split(/\r?\n/).find((text) => text.includes("table-follow-marker-one")),
      `CLI did not print the first appended event; stderr: ${stderr}`,
      5000,
    );
    assert.ok(firstLine.startsWith(String(first.id)));

    const second = append(g.db, event(["table-follow-marker-two"]));
    const secondLine = await waitFor(
      () => stdout.split(/\r?\n/).find((text) => text.includes("table-follow-marker-two")),
      `CLI did not print the second appended event; stderr: ${stderr}`,
      5000,
    );
    assert.ok(secondLine.startsWith(String(second.id)));

    const headerLines = stdout.split(/\r?\n/).filter((text) => /^id\s+ts\s+kind\s+moon\s+payload\s*$/.test(text));
    assert.equal(headerLines.length, 1);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGINT");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
    if (child.exitCode === null && child.signalCode === null) child.kill();
    cleanup();
  }
});

test("followEvents survives a failed read and keeps delivering", async () => {
  const { g, cleanup } = await makeGalaxy();
  let follower;
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => { logged.push(args); };
  try {
    const originalAll = g.db.all.bind(g.db);
    let failed = false;
    const db = { ...g.db, all: (name, params) => { if (name === "events.page" && !failed && params.id > 0) { failed = true; throw new Error("read failed"); } return originalAll(name, params); } };
    const seen = [];
    const first = append(g.db, event(["a"]));
    follower = followEvents(db, { since: 0, pollMs: 20, onEvents(rows) { seen.push(...rows.map((r) => r.id)); } });
    const second = append(g.db, event(["b"]));
    await waitFor(() => seen.includes(second.id), "later event was not delivered after a failed read");
    assert.ok(failed);
    assert.ok(logged.length >= 1);
    assert.ok(seen.includes(first.id));
  } finally {
    console.error = originalError;
    follower?.stop();
    cleanup();
  }
});
