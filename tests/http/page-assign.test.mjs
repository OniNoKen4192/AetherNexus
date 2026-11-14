import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";

test("built Bridge bundle contains assignment commands and copy", async () => {
  const assets = new URL("../../dist/web/assets/", import.meta.url);
  let names;
  try {
    names = await readdir(assets);
  } catch (error) {
    assert.fail(`dist/web/assets is missing; run npm run build:web first: ${error}`);
  }
  const scripts = names.filter((name) => name.endsWith(".js"));
  assert.ok(scripts.length > 0, "dist/web/assets contains no JavaScript bundle");
  const bundle = (await Promise.all(scripts.map((name) => readFile(new URL(name, assets), "utf8")))).join("\n");

  for (const command of ["system.create", "planet.assign", "moon.assign"]) {
    assert.ok(bundle.includes(command), `built bundle is missing command ${JSON.stringify(command)}`);
  }
  for (const copy of [
    "New system", "Assign stream", "Assign spec", "Choose a spec", "No unassigned specs.",
    "planetName", "moonName", "specPath",
  ]) {
    assert.ok(bundle.includes(copy), `built bundle is missing copy ${JSON.stringify(copy)}`);
  }
});

test("SystemView mounts all create and assignment forms", async () => {
  const source = await readFile(new URL("../../web/src/components/SystemView.tsx", import.meta.url), "utf8");
  assert.match(source, /import\s+\{\s*NewSystem\s*\}\s+from\s+["']\.\/NewSystem["']/);
  assert.match(source, /import\s+\{\s*AssignStream\s*,\s*AssignSpec\s*\}\s+from\s+["']\.\/Assign["']/);
  for (const component of ["NewSystem", "AssignStream", "AssignSpec"]) {
    assert.ok(source.includes(`<${component}`), `SystemView does not render <${component}`);
  }
});

test("assignment components contain no browser dialogs or direct fetches", async () => {
  for (const component of ["NewSystem", "Assign", "SystemView"]) {
    const source = await readFile(new URL(`../../web/src/components/${component}.tsx`, import.meta.url), "utf8");
    for (const forbidden of ["confirm(", "alert(", "prompt(", "fetch("]) {
      assert.ok(!source.includes(forbidden), `${component}.tsx contains forbidden ${forbidden}`);
    }
  }
});
