import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = process.cwd();

test("fleet, routing, and voyage failures are present in the built page", async () => {
  const assets = path.join(root, "dist", "web", "assets");
  let names;
  try {
    names = await readdir(assets);
  } catch (error) {
    assert.fail(`dist/web/assets is missing; run npm run build:web first (${error.message})`);
  }
  const scripts = names.filter((name) => name.endsWith(".js"));
  assert.ok(scripts.length > 0, "dist/web/assets contains no JavaScript bundle");
  const bundle = (await Promise.all(scripts.map((name) => readFile(path.join(assets, name), "utf8")))).join("\n");

  for (const value of ["fleet.retire", "config.roles", "Confirm retire", "shipId", "Up", "Down", "failed"]) {
    assert.ok(bundle.includes(value), `built bundle does not contain ${JSON.stringify(value)}`);
  }
});

test("page controls use the shared command hook and snapshot failures", async () => {
  const components = path.join(root, "web", "src", "components");
  const fleet = await readFile(path.join(components, "Fleet.tsx"), "utf8");
  const routing = await readFile(path.join(components, "Routing.tsx"), "utf8");
  const systemView = await readFile(path.join(components, "SystemView.tsx"), "utf8");
  const moonDetail = await readFile(path.join(components, "MoonDetail.tsx"), "utf8");

  assert.match(fleet, /import\s+\{\s*useCommand\s*\}\s+from\s+["']\.\/ActionBar["']/);
  assert.match(routing, /import\s+\{\s*useCommand\s*\}\s+from\s+["']\.\/ActionBar["']/);
  assert.ok(systemView.includes("failures"), "SystemView.tsx does not read failures");
  assert.ok(moonDetail.includes("failures"), "MoonDetail.tsx does not read failures");

  for (const [name, source] of [["Fleet.tsx", fleet], ["Routing.tsx", routing], ["SystemView.tsx", systemView], ["MoonDetail.tsx", moonDetail]]) {
    assert.doesNotMatch(source, /(?:confirm|alert|prompt|fetch)\s*\(/, `${name} contains a forbidden browser or fetch call`);
  }
});

test("useCommand state is independent of the open moon", async () => {
  const source = await readFile(path.join(root, "web", "src", "components", "ActionBar.tsx"), "utf8");
  const start = source.indexOf("export function useCommand");
  assert.notEqual(start, -1, "ActionBar.tsx does not export useCommand");
  const lines = source.slice(start).split(/\r?\n/);
  const end = lines.findIndex((line, index) => index > 0 && line.startsWith("}"));
  assert.notEqual(end, -1, "could not find the end of useCommand");
  assert.ok(!lines.slice(0, end + 1).join("\n").includes("b.taskId"), "useCommand depends on b.taskId");
});
