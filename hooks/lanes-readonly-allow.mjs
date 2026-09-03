#!/usr/bin/env node
// PreToolUse hook on Bash: pre-approve read-only lanes-validate calls.
//
// Every Lanes stage shells out to bin/lanes-validate.mjs, and each call
// prompts for permission unless settings.json carries an allow rule —
// which has to name the plugin's absolute path, version segment
// included, so it breaks on every release. This hook allows exactly the
// calls that only read: the command must be a single `node <validator>
// <sub> ...` invocation (optionally after one `cd <dir> &&`), the script
// must resolve to THIS plugin's validator, and <sub> must be one of
// gate | audit | doctor | attention | seed | config get. Everything
// else — config set, every worktree subcommand, chained commands, any
// other script — gets no decision at all, so the normal permission
// flow runs. This hook never denies and fails silent: no output = no
// opinion.

import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VALIDATOR = path.join(PLUGIN_ROOT, "bin", "lanes-validate.mjs");

const READ_ONLY = new Set(["gate", "audit", "doctor", "attention", "seed"]);
const SHELL_META = /[;&|<>`$()\r\n]/;

function canon(p) {
  const abs = path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

// A token is a double-quoted, single-quoted, or bare run; returns the
// unquoted text.
const TOKEN = /"([^"]*)"|'([^']*)'|(\S+)/g;
function tokens(s) {
  return Array.from(s.matchAll(TOKEN), (m) => m[1] ?? m[2] ?? m[3]);
}

function classify(command, cwd) {
  let rest = command.trim();
  // Optional single `cd <dir> &&` prefix — how gate/audit run inside a
  // worktree. Exactly one, and the dir token itself carries no metachars.
  const cd = rest.match(/^cd\s+("[^"]*"|'[^']*'|[^\s;&|<>`$()]+)\s*&&\s*/);
  if (cd) rest = rest.slice(cd[0].length);
  // The one variable the agents are told to use, expanded before the
  // metachar check so it isn't mistaken for arbitrary substitution.
  rest = rest.replace(/\$\{CLAUDE_PLUGIN_ROOT\}|\$CLAUDE_PLUGIN_ROOT\b/g, PLUGIN_ROOT.replace(/\\/g, "/"));
  if (SHELL_META.test(rest)) return null; // anything chained, piped, or substituted
  const parts = tokens(rest);
  if (parts.length < 3 || parts[0] !== "node") return null;
  const script = parts[1];
  const scriptAbs = path.isAbsolute(script) ? script : path.resolve(cwd, script);
  if (canon(scriptAbs) !== canon(VALIDATOR)) return null;
  const sub = parts[2];
  if (READ_ONLY.has(sub)) return sub;
  if (sub === "config" && parts[3] === "get") return "config get";
  return null;
}

const chunks = [];
for await (const c of process.stdin) chunks.push(c);

try {
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (input?.tool_name && input.tool_name !== "Bash") process.exit(0);
  const command = String(input?.tool_input?.command ?? "");
  if (!command.trim()) process.exit(0);
  const sub = classify(command, input?.cwd || process.cwd());
  if (!sub) process.exit(0);
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: `Lanes: read-only validator call (${sub})`,
    },
  }));
} catch {
  // unidentifiable input — no opinion
}
process.exit(0);
