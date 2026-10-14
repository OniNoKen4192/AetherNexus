// spikes/probe.mjs — throwaway. node spikes/probe.mjs <outDir>
import fs from "node:fs"; import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const out = process.argv[2] ?? "docs/spikes/probe"; fs.mkdirSync(out, { recursive: true });
const log = (name) => { const f = fs.createWriteStream(path.join(out, `${name}.jsonl`)); return { write: (o) => f.write(JSON.stringify(o) + "\n"), end: () => f.end() }; };
const env = { ...process.env }; delete env.ANTHROPIC_API_KEY;   // login mode
const base = { cwd: process.cwd(), env, settingSources: [], strictMcpConfig: true, permissionMode: "dontAsk" };
async function run(name, prompt, options) {
  const l = log(name);
  try { for await (const m of query({ prompt, options: { ...base, ...options } })) l.write(m); }
  catch (err) { l.write({ error: String(err) }); }
  l.end();
}
await run("a-tools-allowlist", "Run the shell command `echo PROBE` using the Bash tool and tell me the output. If you have no Bash tool, say exactly NO_BASH_TOOL.", { tools: ["Read"], maxTurns: 3 });
await run("b-max-turns", "List the files in this directory, then read package.json, then summarize it.", { maxTurns: 1 });
const hooks = { PreToolUse: [{ matcher: "Write|Edit", hooks: [async () => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "probe: outside touch" } })] }] };
await run("c-pretooluse-deny", "Create a file named PROBE.txt containing 'x' in the current directory. Report whether it succeeded.", { maxTurns: 3, hooks });
{ const l = log("d-codex-mcp"); let client;
  try {
    const transport = new StdioClientTransport({ command: "codex", args: ["mcp-server"], cwd: process.cwd() });
    client = new Client({ name: "nexus-probe", version: "0.0.0" }, { capabilities: {} });
    await client.connect(transport);
    const tools = await client.listTools(); l.write({ tools });
    const args = { prompt: "Reply with exactly the word PROBE and nothing else. Do not touch any files.", cwd: process.cwd(), sandbox: "read-only", "approval-policy": "never" };
    try { l.write({ result: await client.callTool({ name: "codex", arguments: args }, undefined, { timeout: 120000 }) }); }
    catch (err) { l.write({ error: String(err), args }); }
  } catch (err) { l.write({ error: String(err) }); }
  finally { try { await client?.close(); } catch {} l.end(); } }
console.log("probe complete →", out);
