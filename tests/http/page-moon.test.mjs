import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";

test("built Bridge bundle contains the system and moon detail UI", async () => {
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

  for (const copy of [
    "No systems yet.", "barren", "No spec file.", "No activity yet.",
    "No audit yet.", "No verdicts yet.", "Close", "voyage.audited", "voyage.event",
  ]) {
    assert.ok(bundle.includes(copy), `built bundle is missing ${JSON.stringify(copy)}`);
  }
});

test("system and moon components replaced their placeholders", async () => {
  const system = await readFile(new URL("../../web/src/components/SystemView.tsx", import.meta.url), "utf8");
  const moon = await readFile(new URL("../../web/src/components/MoonDetail.tsx", import.meta.url), "utf8");
  assert.ok(!system.includes("void b;"), "SystemView still contains its placeholder body");
  assert.ok(!moon.includes("void b;"), "MoonDetail still contains its placeholder body");
  assert.match(moon, /import\s+\{[^}]*useBridgeStatus[^}]*\}\s+from\s+["']\.\.\/store["']/);
});

test("the shared Bridge selectors remain available", async () => {
  const css = await readFile(new URL("../../web/src/style.css", import.meta.url), "utf8");
  for (const selector of [".panel", ".row", ".badge", ".tabs", ".tab.active", ".btn", ".field", ".msg-error", ".log"]) {
    assert.ok(css.includes(selector), `style.css is missing ${selector}`);
  }
});
