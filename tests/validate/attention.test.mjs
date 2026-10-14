import { test } from "node:test"; import assert from "node:assert/strict";
import { attentionMatches } from "../../dist/validate/attention.js";
test("attentionMatches groups touched paths by category; empty when none", () => {
  const att = { billing: ["src/billing/**"], schema: ["prisma/migrations/**"] };
  assert.deepEqual(attentionMatches(["src/billing/x.ts", "src/lib/y.ts", "prisma\\migrations\\1.sql"], att), { billing: ["src/billing/x.ts"], schema: ["prisma/migrations/1.sql"] });
  assert.deepEqual(attentionMatches(["src/lib/y.ts"], att), {});
  assert.deepEqual(attentionMatches(["src/billing/x.ts"], {}), {});
});
