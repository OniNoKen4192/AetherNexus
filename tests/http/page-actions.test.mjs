import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";

test("built Bridge bundle contains every moon action command and its copy", async () => {
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
  for (const command of [
    "delivery.send", "customs.send", "cargo.dock", "voyage.cancel",
    "moon.reply", "delivery.cancel", "moon.park", "decision.answer",
  ]) assert.ok(bundle.includes(command), `built bundle is missing command ${JSON.stringify(command)}`);
  for (const copy of [
    "default order", "Send delivery", "Cancel delivery", "Confirm cancel", "This deletes its worktree and branch.",
    "Park stale", "Cancel voyage", "The main tree changed during this voyage.",
    "That was me", "Not me", "not_mine",
  ]) assert.ok(bundle.includes(copy), `built bundle is missing copy ${JSON.stringify(copy)}`);
});

test("MoonDetail mounts the action bar", async () => {
  const source = await readFile(new URL("../../web/src/components/MoonDetail.tsx", import.meta.url), "utf8");
  assert.match(source, /import\s+\{\s*ActionBar\s*\}\s+from\s+["']\.\/ActionBar["']/);
  assert.ok(source.includes("<ActionBar"), "MoonDetail does not render <ActionBar");
});

test("action components export their interfaces without browser commands", async () => {
  const actionBar = await readFile(new URL("../../web/src/components/ActionBar.tsx", import.meta.url), "utf8");
  const moonDetail = await readFile(new URL("../../web/src/components/MoonDetail.tsx", import.meta.url), "utf8");
  assert.match(actionBar, /export\s+function\s+ActionBar\b/);
  assert.match(actionBar, /export\s+function\s+useCommand\b/);
  for (const forbidden of ["confirm(", "alert(", "prompt(", "fetch("]) {
    assert.ok(!actionBar.includes(forbidden), `ActionBar contains forbidden ${forbidden}`);
    assert.ok(!moonDetail.includes(forbidden), `MoonDetail contains forbidden ${forbidden}`);
  }
});

test("ActionControl key does not depend on the action position", async () => {
  const source = await readFile(new URL("../../web/src/components/ActionBar.tsx", import.meta.url), "utf8");
  const tags = source.match(/<ActionControl\b[^>]*>/g) ?? [];
  assert.equal(tags.length, 1, "ActionBar must contain exactly one <ActionControl> opening tag");
  assert.match(tags[0], /\bkey=/);
  assert.doesNotMatch(tags[0], /index/);
});
