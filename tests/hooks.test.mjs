// Conformance suite for hooks/lanes-readonly-allow.mjs: the PreToolUse
// hook on Bash that pre-approves read-only lanes-validate calls so they
// stop prompting, without a version-pinned allow rule in settings.json
// that breaks on every plugin release. Spawns the hook (never imports it
// — it executes at module bottom). It must only ever say "allow" or say
// nothing; it never denies.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { repoRoot } from "./helpers.mjs";

const HOOK = path.join(repoRoot, "hooks", "lanes-readonly-allow.mjs");
const VALIDATOR = path.join(repoRoot, "bin", "lanes-validate.mjs");
const fwd = VALIDATOR.split(path.sep).join("/");

function run(input) {
  const stdout = execFileSync(process.execPath, [HOOK], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    cwd: repoRoot,
  });
  return stdout.trim() ? JSON.parse(stdout) : null;
}

const bash = (command, extra = {}) => ({ tool_name: "Bash", tool_input: { command }, cwd: repoRoot, ...extra });

function assertAllow(out, sub) {
  assert.ok(out, "expected an allow decision, got silence");
  assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(out.hookSpecificOutput.permissionDecision, "allow");
  assert.ok(out.hookSpecificOutput.permissionDecisionReason.includes(sub),
    `expected reason to name '${sub}', got: ${out.hookSpecificOutput.permissionDecisionReason}`);
}

describe("readonly-allow hook: allows", () => {
  for (const [name, cmd, sub] of [
    ["doctor, double-quoted path", `node "${fwd}" doctor`, "doctor"],
    ["gate with cd prefix", `cd .lanes/worktrees/T2 && node "${fwd}" gate --spec docs/tasks/T2.md`, "gate"],
    ["audit, single-quoted path", `node '${fwd}' audit --task T2`, "audit"],
    ["attention, bare path", `node ${fwd} attention --spec "docs/tasks/T2.md"`, "attention"],
    ["seed --check", `node "${fwd}" seed --check`, "seed"],
    ["config get", `node "${fwd}" config get`, "config get"],
    ["backslash path", `node "${VALIDATOR}" doctor`, "doctor"],
    ["${CLAUDE_PLUGIN_ROOT} left for the shell", 'node "${CLAUDE_PLUGIN_ROOT}/bin/lanes-validate.mjs" doctor', "doctor"],
    ["relative path from repo root", "node bin/lanes-validate.mjs doctor", "doctor"],
  ]) {
    test(name, () => assertAllow(run(bash(cmd)), sub));
  }
});

describe("readonly-allow hook: stays silent", () => {
  for (const [name, input] of [
    ["config set mutates", bash(`node "${fwd}" config set trust roundabout`)],
    ["worktree create mutates", bash(`node "${fwd}" worktree create --spec docs/tasks/T2.md`)],
    ["worktree remove mutates", bash(`node "${fwd}" worktree remove --task T2 --force`)],
    ["selftest is not on the list", bash(`node "${fwd}" selftest`)],
    ["chained command after the validator", bash(`node "${fwd}" doctor; rm -rf /`)],
    ["chained command via &&", bash(`node "${fwd}" doctor && rm -rf /`)],
    ["subshell in args", bash(`node "${fwd}" gate --spec $(cat x)`)],
    ["cd prefix with a second command", bash(`cd x; cd y && node "${fwd}" doctor`)],
    ["some other script under bin", bash(`node "${fwd.replace("lanes-validate", "other")}" doctor`)],
    ["validator from a different plugin root", bash('node "/somewhere/else/bin/lanes-validate.mjs" doctor')],
    ["not node", bash(`cat "${fwd}"`)],
    ["not Bash", { tool_name: "Read", tool_input: { file_path: fwd }, cwd: repoRoot }],
    ["no command", bash("")],
    ["unparseable input", "not json"],
  ]) {
    test(name, () => assert.equal(run(input), null));
  }
});
