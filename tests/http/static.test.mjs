import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startWorld } from "./helpers.mjs";

const realWebRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "web");

test("the built page is served at / and references a script that is served with a JS content type", async () => {
  // startWorld deletes its webRoot on close, so serve a copy; the real build output must survive the test.
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-web-copy-"));
  fs.cpSync(realWebRoot, copy, { recursive: true });
  const x = await startWorld(undefined, undefined, { webRoot: copy });
  try {
    const page = await x.api("/");
    assert.equal(page.status, 200);
    assert.match(page.headers["content-type"], /text\/html/);
    assert.match(page.text, /id="app"/);
    const script = /src="(\/assets\/[^"]+\.js)"/.exec(page.text);
    assert.ok(script, "index.html references a script under /assets/");
    const js = await x.api(script[1]);
    assert.equal(js.status, 200);
    assert.match(js.headers["content-type"], /javascript/);
    const css = /href="(\/assets\/[^"]+\.css)"/.exec(page.text);
    assert.ok(css, "index.html references a stylesheet under /assets/");
    const style = await x.api(css[1]);
    assert.equal(style.status, 200);
    assert.match(style.headers["content-type"], /text\/css/);
  } finally { await x.close(); }
});
