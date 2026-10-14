import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTarget } from "../../dist/validate/tokenize.js";

const VECTORS = [
  ["pnpm vitest run", { kind: "pm", runner: "pnpm", target: "vitest" }],
  ["npm run test", { kind: "pm", runner: "npm", target: "test" }],
  ["yarn test", { kind: "pm", runner: "yarn", target: "test" }],
  ["npx tsc --noEmit", { kind: "pm", runner: "npx", target: "tsc" }],
  ["bun run lint", { kind: "pm", runner: "bun", target: "lint" }],
  ["pnpm exec playwright test", { kind: "pm", runner: "pnpm", target: "playwright" }],
  ["cargo test", { kind: "bare", binary: "cargo" }],
  ["", { kind: "empty" }],
  ["pnpm", { kind: "pm", runner: "pnpm", target: null }],
];
for (const [cmd, want] of VECTORS) {
  test(`resolveTarget(${JSON.stringify(cmd)})`, () => assert.deepEqual(resolveTarget(cmd), want));
}
