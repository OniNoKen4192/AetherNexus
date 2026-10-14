export type Target =
  | { kind: "pm"; runner: string; target: string | null }
  | { kind: "bare"; binary: string }
  | { kind: "empty" };

const PM_RUNNERS = new Set(["pnpm", "npm", "yarn", "bun", "npx"]);

// "pnpm vitest run" → {kind:"pm", runner:"pnpm", target:"vitest"};
// "npm run test" → target "test"; "cargo test" → {kind:"bare", binary:"cargo"}.
export function resolveTarget(cmd: string): Target {
  const tokens = String(cmd).trim().split(/\s+/).filter(Boolean);
  const first = tokens[0];
  if (first === undefined) return { kind: "empty" };
  if (PM_RUNNERS.has(first)) {
    const target = (tokens[1] === "run" || tokens[1] === "exec") ? tokens[2] : tokens[1];
    return { kind: "pm", runner: first, target: target ?? null };
  }
  return { kind: "bare", binary: first };
}
