import type { NexusConfig } from "../config/schema.js";
import type { ProviderAdapter } from "./adapter.js";
import { createFakeAdapter } from "./fake/index.js";

function placeholder(id: string): ProviderAdapter {
  return {
    id, roles: ["implement", "review"],
    dispatch(): never { throw new Error(`adapter '${id}' not implemented yet`); },
    classify() { return "unknown"; },
    async fuel() { return { source: "unknown" as const }; },
  };
}

export function buildAdapters(config: NexusConfig, deps: { scriptsDir: string }): Record<string, ProviderAdapter> {
  const out: Record<string, ProviderAdapter> = {};
  for (const [id, p] of Object.entries(config.providers)) {
    out[id] = p.adapter === "fake" ? createFakeAdapter(deps.scriptsDir) : placeholder(p.adapter);
  }
  return out;
}
