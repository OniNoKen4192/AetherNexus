import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("the built Bridge bundle contains the trust rung controls", async () => {
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
    "manual — you do every step",
    "verdicts — you send each freighter; the server inspects, docks and re-runs fixes",
    "roundabout — the server also sends a freighter to every ready moon",
    "Trust rung",
    "Raising to roundabout sends ",
    " freighter now.",
    " freighters now.",
    "Raise",
    "Cancel",
    "config.automation",
    "rung: ",
    "in flight ",
  ]) {
    assert.ok(bundle.includes(copy), `built bundle is missing exact copy: ${copy}`);
  }
});

test("the header uses inline rung confirmation", async () => {
  const source = await readFile("web/src/components/Header.tsx", "utf8");
  assert.ok(!source.includes("confirm("), "Header.tsx uses a confirm dialog");
  assert.ok(!source.includes("alert("), "Header.tsx uses an alert dialog");
  assert.ok(source.includes("ready_to_send"), "Header.tsx does not reference ready_to_send");
  assert.match(source, /import\s+\{\s*useCommand\s*\}/, "Header.tsx does not import useCommand");
});

test("the page snapshot declares ready_to_send", async () => {
  const source = await readFile("web/src/types.ts", "utf8");
  assert.match(source, /ready_to_send:\s*number/, "Snapshot does not declare ready_to_send: number");
});
