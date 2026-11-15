import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("the built Bridge bundle contains moon waiting labels", async () => {
  const assets = path.resolve("dist/web/assets");
  let names;
  try {
    names = await readdir(assets);
  } catch (error) {
    assert.fail(`dist/web/assets is missing; run npm run build:web first (${error.message})`);
  }

  const scripts = names.filter((name) => name.endsWith(".js"));
  assert.ok(scripts.length > 0, "dist/web/assets contains no JavaScript bundles");
  const bundle = (
    await Promise.all(scripts.map((name) => readFile(path.join(assets, name), "utf8")))
  ).join("\n");

  assert.ok(bundle.includes("waiting on "), "built bundle is missing waiting-on copy");
  assert.ok(bundle.includes("waiting on planet "), "built bundle is missing waiting-on-planet copy");
  assert.ok(!bundle.includes("blocked from"), "built bundle contains forbidden blocked-from copy");
});

test("the system view reads both moon waiting fields", async () => {
  const source = await readFile("web/src/components/SystemView.tsx", "utf8");
  assert.ok(source.includes("waiting_on"), "SystemView.tsx does not reference waiting_on");
  assert.ok(source.includes("waiting_on_planets"), "SystemView.tsx does not reference waiting_on_planets");
});

test("the moon detail reads both moon waiting fields", async () => {
  const source = await readFile("web/src/components/MoonDetail.tsx", "utf8");
  assert.ok(source.includes("waiting_on"), "MoonDetail.tsx does not reference waiting_on");
  assert.ok(source.includes("waiting_on_planets"), "MoonDetail.tsx does not reference waiting_on_planets");
});
