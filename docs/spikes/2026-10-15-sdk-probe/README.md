# SDK / MCP probe findings (throwaway spike)

Run: `node spikes/probe.mjs docs/spikes/2026-10-15-sdk-probe` (login mode; `ANTHROPIC_API_KEY` deleted from the env passed to the SDK).
Versions: `@anthropic-ai/claude-agent-sdk` 0.3.299, `@modelcontextprotocol/sdk` 1.32.1, Claude Code 2.1.299 (`claude_code_version` in init), `codex` CLI 0.145.0, Node 22.14.
Deviations from the brief's script: each probe wrapped in try/catch (logs `{error}` and continues); Codex `callTool` given a 120 s timeout and `client.close()` in `finally`. No import or field-name changes were needed; the Codex call worked on the first try (no retry).
Redaction: grep for `sk-ant`, `Bearer`, `api_key`, `apiKey"` found nothing; `token` matches only usage counters (`input_tokens`, etc.). Nothing redacted. Logs contain opaque `thinking` `signature` blobs (not credentials).
Cost observed: a $0.018, b $0.258 (big system prompt, cache write), c $0.059.

## 1. R3: is `tools: ["Read"]` a strict allowlist?
Yes. With `tools: ["Read"]` the init message lists exactly that and the model answered `NO_BASH_TOOL`.
- `a-tools-allowlist.jsonl` init: `"apiKeySource":"none","tools":["Read"]`
- assistant text: `{"type":"text","text":"NO_BASH_TOOL"}`
- Without `tools` (probes b, c) init lists ~31 tools incl. `Bash`, `Write`, `Edit`, `PowerShell`, `Task`, `WebFetch`, `Artifact*`, `Cron*`.

Recommendation for the adapter: use `tools: [<explicit per-role list>]` as an allowlist (e.g. reviewer `["Read","Glob","Grep"]`), NOT `disallowedTools`, since the default set is large and grows with the CLI version. Optionally also pass `disallowedTools` as belt-and-braces; it is not needed for correctness. (Not tested here: whether `disallowedTools` alone works.)

## 2. `apiKeySource` under login with key deleted
Value is `"none"`, not `"oauth"` or `"/login managed key"`:
`"apiKeySource":"none"` in all three SDK probes. The calls nevertheless succeeded and billed against the login pool (`rate_limit_event` shows `rateLimitType":"five_hour"`, `"isUsingOverage":false`; `total_cost_usd` is list-price-basis, `"costBasis":"list"`). Conclusion: on this build the login path reports `"none"`; do not assert `apiKeySource === "oauth"` in the adapter. Treat "an API key was used" as `apiKeySource` in a set of key-ish values, or better, just ensure `ANTHROPIC_API_KEY` is absent from the env.

## 3. `result` subtype for `maxTurns: 1`
Result message: `"subtype":"error_max_turns","is_error":true,"terminal_reason":"max_turns","num_turns":2,"errors":["Reached maximum number of turns (1)"],"stop_reason":"tool_use"`.
Fields present: `type, subtype, is_error, terminal_reason, stop_reason, errors, num_turns, session_id, total_cost_usd, usage, modelUsage, permission_denials, duration_ms, duration_api_ms, uuid, fast_mode_state, subagent_stats, safety_stops, queued_turn_count, result_index`. No `result` text field on the error subtype. Note `num_turns` is 2 for `maxTurns: 1`.
Success shape (probe a): `"subtype":"success","is_error":false,"terminal_reason":"completed","num_turns":1,"total_cost_usd":0.0183393,"usage":{"input_tokens":2,...,"output_tokens":78,...}`.
IMPORTANT: after yielding the error result, the `query()` async iterator THROWS: `Error: Claude Code returned an error result: Reached maximum number of turns (1)` (logged as the last line of `b-max-turns.jsonl`). The adapter must capture the `result` message before/while catching, and not treat the throw as the primary signal.

## 4. Function hook denying Write
The hook denied it. Denial is carried in two places:
- The tool_result seen by the model: `{"type":"tool_result","content":"PreToolUse:Write hook error: probe: outside touch","is_error":true,...}` (the `permissionDecisionReason` is embedded in the text).
- `result.permission_denials`: `[{"tool_name":"Write","tool_use_id":"toolu_01Uz...","tool_input":{"file_path":"S:\AetherNexus\PROBE.txt","content":"x"}}]` (no reason field).
No separate `SDKPermissionDeniedMessage` appeared (message types: `system/init, rate_limit_event, assistant, user, assistant, assistant, result/success`). `PROBE.txt` was not created (verified). The model did not try to circumvent via Bash/PowerShell.

## 5. Codex MCP (`codex mcp-server`)
Tools: `codex`, `codex-reply`.
- `codex` inputSchema properties: `prompt` (required), `cwd`, `sandbox` (enum `read-only|workspace-write|danger-full-access`), `approval-policy` (enum `untrusted|on-request|never`), `model`, `base-instructions`, `developer-instructions`, `compact-prompt`, `config` (object overriding config.toml). `additionalProperties: false`.
- `codex-reply` inputSchema: `prompt` (required), `threadId` (preferred), `conversationId` (DEPRECATED alias).
- Both have `outputSchema`: `{threadId: string, content: string}`.
- Actual result (first try, brief's argument names correct): `{"result":{"content":[{"type":"text","text":"PROBE"}],"structuredContent":{"threadId":"01a13ad0-bee6-7871-8e6a-01f9cbbe345a","content":"PROBE"}}}`.
Follow-up turns are addressed by `threadId` from `structuredContent.threadId`. (`codex-reply` itself was not called; only its schema was observed.) Server stderr showed a non-fatal `failed to load models cache: missing field base_instructions`.

## 6. `rate_limit_event`
Seen in every SDK probe, as the second message after init, even when allowed:
`{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1792000800,"rateLimitType":"five_hour","overageStatus":"allowed","overageResetsAt":1793491200,"isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.06,"resetsAt":1792000800},"seven_day":{"utilization":0.03,"resetsAt":1792562400}}},"uuid":...,"session_id":...}`.
So the adapter must filter on `rate_limit_info.status !== "allowed"` rather than on event presence. Non-"allowed" status values were not observed.
