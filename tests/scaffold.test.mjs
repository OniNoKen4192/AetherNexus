import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { repoRoot, read } from "./helpers.mjs";

test("package.json: name, version, engines, exact dependency set", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.name, "aether-nexus");
  assert.equal(pkg.version, "0.1.0");
  assert.equal(pkg.type, "module");
  assert.equal(pkg.engines.node, ">=22.13");
  assert.deepEqual(Object.keys(pkg.dependencies).sort(),
    ["@anthropic-ai/claude-agent-sdk", "@modelcontextprotocol/sdk"]);
  assert.deepEqual(Object.keys(pkg.devDependencies).sort(), ["@types/node", "typescript"]);
});

test("manifests carry the package version", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(JSON.parse(read(".claude-plugin/plugin.json")).version, pkg.version);
  assert.equal(JSON.parse(read(".claude-plugin/marketplace.json")).plugins[0].version, pkg.version);
});

test("gitattributes forces LF", () => {
  assert.match(read(".gitattributes"), /^\* text=auto eol=lf$/m);
});

test("dist is built and exports VERSION", async () => {
  assert.ok(fs.existsSync(`${repoRoot}/dist/index.js`), "run npm run build first");
  const mod = await import("../dist/index.js");
  assert.equal(mod.VERSION, "0.1.0");
});
