import path from "node:path";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { matchAny, normalizePath } from "../../validate/match.js";

export const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** PreToolUse hook: deny file-writing tools whose target is outside `cwd` or outside the `touch` globs. */
export function makeTouchGate(touch: string[], cwd: string): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse" || !WRITE_TOOLS.has(input.tool_name)) return {};
    const ti = (input.tool_input ?? {}) as Record<string, unknown>;
    const target = String(ti["file_path"] ?? ti["notebook_path"] ?? "");
    const deny = (reason: string) => ({ hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: reason } });
    if (!target) return deny("write tool call has no file path");
    const rel = path.relative(path.resolve(cwd), path.resolve(cwd, target));
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return deny(`${target} is outside the working directory`);
    const norm = normalizePath(rel);
    if (!matchAny(touch, norm)) return deny(`${norm} is outside this task's touch scope (${touch.join(", ")})`);
    return { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "allow" as const, permissionDecisionReason: "inside touch" } };
  };
}
