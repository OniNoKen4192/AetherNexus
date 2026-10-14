#!/usr/bin/env node
// Thin entry: silence node:sqlite's ExperimentalWarning before anything that imports it loads.
// ESM hoists static imports, so everything else lives in run.ts behind a dynamic import.
process.removeAllListeners("warning");
process.on("warning", (w) => { if (w.name !== "ExperimentalWarning") console.error(w); });
const { main } = await import("./run.js");
await main(process.argv.slice(2));
