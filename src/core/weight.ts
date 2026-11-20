import type { NexusConfig } from "../config/schema.js";
import type { Catalogue } from "./catalogue/types.js";
import type { Role } from "../providers/adapter.js";

export function factionOf(config: NexusConfig, provider: string): string {
  return config.providers[provider]?.faction ?? provider;
}

export function weightFor(
  config: NexusConfig,
  provider: string,
  q: { role: Role; model?: string; tier?: string | null },
): string {
  const weights = config.providers[provider]?.weights ?? {};
  if (q.model !== undefined && Object.hasOwn(weights, q.model)) return weights[q.model]!;
  if (q.role === "implement" && q.model === undefined && typeof q.tier === "string" && Object.hasOwn(weights, q.tier)) return weights[q.tier]!;
  if (Object.hasOwn(weights, "default")) return weights.default!;
  return "standard";
}

/** One message per provider weight the catalogue does not list; empty when every configured weight is known. */
export function unknownWeights(config: NexusConfig, catalogue: Catalogue): string[] {
  const errors: string[] = [];
  for (const [provider, providerConfig] of Object.entries(config.providers)) {
    for (const [key, weight] of Object.entries(providerConfig.weights ?? {})) {
      if (!catalogue.weights.includes(weight)) {
        errors.push(`'providers.${provider}.weights.${key}' names weight '${weight}', which the catalogue does not list (${catalogue.weights.join(", ")})`);
      }
    }
  }
  return errors;
}
