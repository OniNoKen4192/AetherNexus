import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const components = ["Header", "Decisions", "Fleet", "Routing"];

test("the built Bridge bundle contains the page panel copy", async () => {
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

  for (const copy of [
    "No decisions waiting.",
    "No ships.",
    "rung: ",
    "in flight ",
    "Implement order",
    "Review order",
    "Loading",
  ]) {
    assert.ok(bundle.includes(copy), `built bundle is missing exact copy: ${copy}`);
  }
});

test("the four page panels are no longer placeholders", async () => {
  for (const component of components) {
    const source = await readFile(`web/src/components/${component}.tsx`, "utf8");
    assert.ok(!source.includes("void b;"), `${component}.tsx still contains void b;`);
  }
});

test("the existing shared style selectors remain available", async () => {
  const css = await readFile("web/src/style.css", "utf8");
  for (const selector of [".panel", ".row", ".badge", ".btn", ".msg-error", ".log"]) {
    assert.match(css, new RegExp(`\\${selector}\\s*\\{`), `style.css is missing ${selector}`);
  }
});
