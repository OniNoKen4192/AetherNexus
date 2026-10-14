import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { openGalaxy, type Galaxy } from "../server/galaxy.js";
import { Refusal } from "../server/errors.js";
import { TransitionRefused } from "../core/transitions.js";
import { GitRefusal } from "../core/git.js";
import { initGalaxy } from "../server/commands/init.js";
import { createSystem, showSystem } from "../server/commands/system.js";
import { assignPlanet, assignMoon } from "../server/commands/assign.js";
import { launchMoon } from "../server/commands/launch.js";
import { inspectMoon } from "../server/commands/review.js";
import { dockMoon } from "../server/commands/dock.js";
import { replyMoon, dropMoon, retireShip, parkStaleMoon } from "../server/commands/park.js";
import { status, events, fleet } from "../server/commands/query.js";
import { rebuild } from "../db/rebuild.js";
import { STATEMENTS, type StatementName } from "../db/statements.js";
import { parseSpec } from "../validate/spec.js";
import { attentionMatches } from "../validate/attention.js";
import { matchesPattern } from "../validate/match.js";
import { resolveTarget } from "../validate/tokenize.js";
import type { AgentEvent } from "../providers/adapter.js";
import { eventsTable, fleetTable, statusTable, table } from "./format.js";

const USAGE = `usage: nexus [--json] <command>

  init [--force]
  system create <slug> --title <t> (--brief <file> | --brief-text <text>) [--kind feature|bug] [--seed <n>]
  system show <system-id>
  planet assign <system-id> --stream <id> [--mission <m>] [--territory <glob>]... [--planet <name>]
  moon assign <planet-id> <spec-path> [--moon <name>]
  moon launch <task-id> [--provider <p>] [--quiet]
  moon reply <task-id> --note <text>
  moon drop <task-id>
  moon park <task-id> --reason <text>      for a voyage whose process died (crash, kill, reboot):
                                           parks it as 'stale:<text>' so reply/drop can proceed
  voyage inspect <task-id> [--provider <p>] [--quiet]
  voyage dock <task-id>
  status [<system-id>]
  events [--since <id>] [--moon <id>]      (--follow arrives with the daemon)
  fleet [retire <ship-id> --reason <r>]
  db rebuild | stats | explain <name> | analyze
  validate <spec-path> | --selftest

--json prints the result object as JSON. --quiet suppresses the event stream on stderr.
Ctrl-C (SIGINT/SIGTERM) during launch/inspect parks the voyage as 'interrupted' and exits 2.
Env: NEXUS_FAKE_SCRIPTS overrides the fake adapter's scripts directory.
Exit codes: 0 ok, 2 refused (message only), 1 error or unknown command.`;

class Usage extends Error {}

const TOKENIZER_VECTORS: [string, unknown][] = [
  ["pnpm vitest run", { kind: "pm", runner: "pnpm", target: "vitest" }],
  ["npm run test", { kind: "pm", runner: "npm", target: "test" }],
  ["yarn test", { kind: "pm", runner: "yarn", target: "test" }],
  ["npx tsc --noEmit", { kind: "pm", runner: "npx", target: "tsc" }],
  ["bun run lint", { kind: "pm", runner: "bun", target: "lint" }],
  ["pnpm exec playwright test", { kind: "pm", runner: "pnpm", target: "playwright" }],
  ["cargo test", { kind: "bare", binary: "cargo" }],
  ["", { kind: "empty" }],
  ["pnpm", { kind: "pm", runner: "pnpm", target: null }],
];

function selftest(): string {
  const failures: string[] = [];
  let nMatch = 0;
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "tests", "fixtures", "match-vectors.json");
  if (fs.existsSync(file)) {
    const vectors = JSON.parse(fs.readFileSync(file, "utf8")) as [string, string, boolean][];
    for (const [pattern, p, want] of vectors) {
      nMatch++;
      if (matchesPattern(pattern, p) !== want) failures.push(`match(${JSON.stringify(pattern)}, ${JSON.stringify(p)}) != ${want}`);
    }
  }
  for (const [cmd, want] of TOKENIZER_VECTORS) {
    if (JSON.stringify(resolveTarget(cmd)) !== JSON.stringify(want)) failures.push(`resolveTarget(${JSON.stringify(cmd)})`);
  }
  if (failures.length) throw new Error(`selftest: ${failures.length} failure(s)\n${failures.join("\n")}`);
  return nMatch === 0 ? "selftest OK (0 vectors — fixtures not shipped)" : `selftest OK (${nMatch} match vectors + ${TOKENIZER_VECTORS.length} tokenizer vectors)`;
}

function streamEvent(e: AgentEvent): void {
  let summary: string;
  switch (e.kind) {
    case "text": summary = e.data.text.slice(0, 80); break;
    case "tool_use": summary = `${e.data.name} ${(JSON.stringify(e.data.input) ?? "").slice(0, 60)}`; break;
    case "tool_result": summary = e.data.ok ? "ok" : "failed"; break;
    case "file_changed": summary = e.data.path; break;
    case "usage": summary = `in=${e.data.input_tokens ?? 0} out=${e.data.output_tokens ?? 0}`; break;
    case "done": { const r = e.data.report as { status?: string; verdict?: string }; summary = r.status ?? r.verdict ?? ""; break; }
    case "error": summary = `${e.data.classification}: ${e.data.message}`; break;
  }
  console.error(`[${e.kind}] ${summary}`);
}

function parse(argv: string[]) {
  try {
    return parseArgs({
      args: argv, allowPositionals: true, strict: true,
      options: {
        json: { type: "boolean" }, quiet: { type: "boolean" }, force: { type: "boolean" }, selftest: { type: "boolean" }, help: { type: "boolean", short: "h" }, follow: { type: "boolean" },
        title: { type: "string" }, brief: { type: "string" }, "brief-text": { type: "string" }, kind: { type: "string" }, seed: { type: "string" },
        stream: { type: "string" }, mission: { type: "string" }, territory: { type: "string", multiple: true }, moon: { type: "string" }, planet: { type: "string" },
        provider: { type: "string" }, note: { type: "string" }, since: { type: "string" }, reason: { type: "string" },
      },
    });
  } catch (e) { throw new Refusal((e as Error).message); }
}
type Opts = ReturnType<typeof parse>["values"];

function need(v: string | undefined, what: string): string {
  if (v === undefined || v === "") throw new Refusal(`missing ${what}`);
  return v;
}

async function run(argv: string[]): Promise<void> {
  const { values: o, positionals: pos } = parse(argv);
  const out = (result: unknown, human: () => string) => console.log(o.json ? JSON.stringify(result, null, 2) : human());
  const [c0, c1] = pos;
  if (o.help) { console.log(USAGE); return; }
  if (c0 === undefined) throw new Usage();

  // Commands that need no galaxy.
  if (c0 === "validate" && o.selftest) { console.log(selftest()); return; }
  if (c0 === "init") {
    const r = initGalaxy(process.cwd(), { force: o.force === true });
    out(r, () => `initialized ${r.configPath} (${r.ships} ships); commit .nexus/config.json and .nexus/.gitignore`);
    return;
  }
  if (!["system", "planet", "moon", "voyage", "status", "events", "fleet", "db", "validate"].includes(c0)) throw new Usage();

  const g = openGalaxy(process.cwd(), process.env["NEXUS_FAKE_SCRIPTS"] ? { scriptsDir: process.env["NEXUS_FAKE_SCRIPTS"] } : {});
  try {
    await dispatch(g, pos, o, out);
  } finally { g.close(); }
}

async function dispatch(g: Galaxy, pos: string[], o: Opts, out: (r: unknown, h: () => string) => void): Promise<void> {
  const [c0, c1] = pos;
  const onEvent = o.quiet ? undefined : streamEvent;
  const launchIn = (taskId: string) => ({ taskId, ...(o.provider ? { provider: o.provider } : {}), ...(onEvent ? { onEvent } : {}) });

  // Single-word commands take their argument from the second positional.
  if (c0 === "status") {
    const r = status(g, c1);
    return out(r, () => statusTable(r, (id) => String(g.db.get("ships.byId", { id })?.["name"] ?? id)));
  }
  if (c0 === "events") {
    if (o.follow) throw new Refusal("--follow arrives with the daemon; v0 prints the log once");
    const r = events(g, { ...(o.since !== undefined ? { since: Number(o.since) } : {}), ...(o.moon ? { moon: o.moon } : {}) });
    return out(r, () => eventsTable(r));
  }
  if (c0 === "fleet" && c1 === undefined) { const r = fleet(g); return out(r, () => fleetTable(r)); }
  if (c0 === "validate") {
    if (c1 === undefined) throw new Refusal("usage: nexus validate <spec-path> | --selftest");
    const parsed = parseSpec(fs.readFileSync(path.resolve(c1), "utf8"));
    console.log(JSON.stringify({ ...parsed, attention: attentionMatches(parsed.touch, g.config.routing.attention) }, null, 2));
    return;
  }

  const rest = pos.slice(2);
  switch (`${c0} ${c1}`) {
    case "system create": {
      const brief = o["brief-text"] ?? (o.brief ? fs.readFileSync(path.resolve(o.brief), "utf8") : undefined);
      if (o.kind !== undefined && o.kind !== "feature" && o.kind !== "bug") throw new Refusal("--kind must be 'feature' or 'bug'");
      const r = createSystem(g, { slug: need(rest[0], "<slug>"), title: need(o.title, "--title"), brief: need(brief, "--brief <file> or --brief-text <text>"), ...(o.kind ? { kind: o.kind } : {}), ...(o.seed !== undefined ? { seed: Number(o.seed) } : {}) });
      return out(r, () => `created ${r.systemId} (${r.planets} planets, ${r.moons} moons) at ${r.baseSha.slice(0, 8)}`);
    }
    case "system show": {
      const r = showSystem(g, need(rest[0], "<system-id>"));
      return out(r, () => [`${r.system["id"]}  ${r.system["title"]}`, ...r.planets.map((p) => `  ${p["id"]}  ${p["name"]}  moons: ${p.moons.length}`)].join("\n"));
    }
    case "planet assign": {
      const r = assignPlanet(g, { systemId: need(rest[0], "<system-id>"), streamId: need(o.stream, "--stream"), mission: o.mission ?? "", territory: o.territory ?? [], ...(o.planet ? { planetName: o.planet } : {}) });
      return out(r, () => `assigned planet ${r.planetId} on ${r.branch}${r.discovered ? " (discovered)" : ""}`);
    }
    case "moon assign": {
      const r = assignMoon(g, { planetId: need(rest[0], "<planet-id>"), specPath: need(rest[1], "<spec-path>"), ...(o.moon ? { moonName: o.moon } : {}) });
      return out(r, () => `assigned moon ${r.moonId} (task ${r.taskId})`);
    }
    case "moon launch": {
      const taskId = need(rest[0], "<task-id>");
      const r = await interruptible((signal) => launchMoon(g, { ...launchIn(taskId), signal }));
      if (r.interrupted && interruptedPark(g, taskId)) return interruptedExit();
      return out(r.value, () => `voyage ${r.value.voyageId}: moon ${r.value.moonStatus}`);
    }
    case "moon inspect": case "voyage inspect": {
      const taskId = need(rest[0], "<task-id>");
      const r = await interruptible((signal) => inspectMoon(g, { ...launchIn(taskId), signal }));
      if (r.interrupted && interruptedPark(g, taskId)) return interruptedExit();
      return out(r.value, () => `voyage ${r.value.voyageId}: verdict ${r.value.verdict?.verdict ?? "none"}, moon ${r.value.moonStatus}`);
    }
    case "moon park": {
      const r = parkStaleMoon(g, { taskId: need(rest[0], "<task-id>"), reason: need(o.reason, "--reason") });
      return out(r, () => `parked voyage ${r.voyageId} (${r.reason})`);
    }
    case "moon dock": case "voyage dock": {
      const r = dockMoon(g, { taskId: need(rest[0], "<task-id>") });
      return out(r, () => `moon ${r.moonStatus}${r.mergeSha ? ` at ${r.mergeSha.slice(0, 8)}` : ""} into ${r.planetBranch}`);
    }
    case "moon reply": {
      const r = replyMoon(g, { taskId: need(rest[0], "<task-id>"), note: need(o.note, "--note") });
      return out(r, () => `recorded reply; next launch is round ${r.round}`);
    }
    case "moon drop": {
      const r = dropMoon(g, { taskId: need(rest[0], "<task-id>") });
      return out(r, () => `dropped ${r.moonId}`);
    }
    case "fleet retire": {
      const shipId = need(rest[0], "<ship-id>"); retireShip(g, { shipId, reason: need(o.reason, "--reason") });
      return out({ shipId, retired: true }, () => `retired ${shipId}`);
    }
    case "db rebuild": { const r = rebuild(g.db); return out(r, () => `rebuilt projections from ${r.events} events`); }
    case "db stats": {
      const r = g.db.all("stats.all");
      return out(r, () => r.length === 0 ? "no stats recorded (enable config.db.stats)"
        : table(["name", "calls", "total_ms", "max_ms", "last_rows"], r.map((x) => [String(x["name"]), String(x["calls"]), Number(x["total_ms"]).toFixed(2), Number(x["max_ms"]).toFixed(2), String(x["last_rows"])])));
    }
    case "db explain": {
      const name = need(rest[0], "<statement-name>");
      if (!Object.hasOwn(STATEMENTS, name)) throw new Refusal(`unknown statement '${name}'; available: ${Object.keys(STATEMENTS).join(", ")}`);
      // The one place SQL text is composed at runtime (exempt in tests/db/registry.test.mjs).
      const plan = g.db.raw.prepare("EXPLAIN QUERY PLAN " + STATEMENTS[name as StatementName]).all() as { detail: string }[];
      return out(plan, () => plan.map((p) => p.detail).join("\n"));
    }
    case "db analyze": { g.db.raw.exec("ANALYZE"); return out({ analyzed: true }, () => "analyzed"); }
    default: throw new Usage();
  }
}

/** Run a voyage with SIGINT/SIGTERM wired to abort it (the voyage then parks as 'interrupted' instead of wedging the moon). */
async function interruptible<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<{ value: T; interrupted: boolean }> {
  const ac = new AbortController();
  const onSignal = (): void => ac.abort();
  process.on("SIGINT", onSignal); process.on("SIGTERM", onSignal);
  try { return { value: await fn(ac.signal), interrupted: ac.signal.aborted }; }
  finally { process.off("SIGINT", onSignal); process.off("SIGTERM", onSignal); }
}
const interruptedPark = (g: Galaxy, taskId: string): boolean => g.db.get<{ park_reason: string | null }>("moons.byTask", { task_id: taskId })?.park_reason === "interrupted";
function interruptedExit(): void { console.error("interrupted — voyage parked"); process.exitCode = 2; }

export async function main(argv: string[]): Promise<void> {
  try {
    await run(argv);
  } catch (e) {
    if (e instanceof Usage) { console.error(USAGE); process.exitCode = 1; }
    else if (e instanceof Refusal || e instanceof TransitionRefused || e instanceof GitRefusal) { console.error(e.message); process.exitCode = 2; }
    else { console.error(e); process.exitCode = 1; }
  }
}
