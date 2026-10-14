import { matchAny, normalizePath } from "./match.js";

export function attentionMatches(touch: string[], attention: Record<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [category, patterns] of Object.entries(attention)) {
    const hits = touch.map(normalizePath).filter((p) => matchAny(patterns, p));
    if (hits.length) out[category] = hits;
  }
  return out;
}
