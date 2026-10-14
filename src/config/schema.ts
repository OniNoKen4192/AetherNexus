import fs from "node:fs";
import path from "node:path";

// Strict, fail-closed validation of .nexus/config.json (schema v2).
// Ported from the Lanes v1 validator (bin/lanes-validate.mjs): unknown keys,
// wrong types, or a wrong schema_version are refusals — a misspelled security
// list must die loudly, never be silently ignored.

export type ProviderConfig = {
  adapter: "fake" | "claude-sdk" | "codex-mcp";
  auth?: "login" | "api_key";
  api_key_env?: string;
  models?: Record<string, string>;
  tiers?: string[];
  ratelimit_signal?: string[];
  pool?: { kind: "window" | "daily" | "per-token" | "free"; reserve_floor?: number };
  command?: string;
  endpoint?: string;
  max_budget_usd?: number;
  max_turns?: number;
};

export type NexusConfig = {
  schema_version: 2;
  project: { app_subdir: string; command_prefix: string };
  commands: { test: string; lint: string; typecheck: string; acceptance_runner: string };
  providers: Record<string, ProviderConfig>;
  roles: { implement: string[]; review: string[] };
  routing: { security_routed: string[]; do_not_touch: string[]; attention: Record<string, string[]> };
  review_suite?: { suite_command: string; id_pattern: string; id_index: string; route_map: Record<string, string[]> };
  pipeline: { plans_dir: string; tasks_dir: string; ledger: string };
  automation: { level: "manual" | "verdicts" | "roundabout" | "highways" | "autopilot"; max_fix_rounds: number };
  scheduler: { max_concurrent_ships: number; max_concurrent_systems: number; per_provider_max: Record<string, number> };
  db: { stats: boolean };
  fleet: { freighters: number; customs: number; carriers: number; surveyors: number; name_theme: string; seed?: number };
  intake?: unknown;
  idle?: unknown;
  gravity?: unknown;
};

type Obj = Record<string, unknown>;

// Block -> field -> type tag. A trailing "?" means optional.
const SCHEMA_V2: Record<string, Record<string, string>> = {
  project: { app_subdir: "string", command_prefix: "string" },
  commands: { test: "string", lint: "string", typecheck: "string", acceptance_runner: "string" },
  providers: {}, // map keyed by arbitrary provider ids; validated per entry
  roles: { implement: "string[]", review: "string[]" },
  routing: { security_routed: "string[]", do_not_touch: "string[]", attention: "topic_map?" },
  review_suite: { suite_command: "string", id_pattern: "string", id_index: "string", route_map: "route_map" },
  pipeline: { plans_dir: "string", tasks_dir: "string", ledger: "string" },
  automation: { level: "string", max_fix_rounds: "posint?" },
  scheduler: { max_concurrent_ships: "posint?", max_concurrent_systems: "posint?", per_provider_max: "posint_map?" },
  db: { stats: "bool?" },
  fleet: { freighters: "posint?", customs: "posint?", carriers: "posint?", surveyors: "posint?", name_theme: "string?", seed: "number?" },
  intake: {},
  idle: {},
  gravity: {},
};
const OPTIONAL_BLOCKS = new Set(["review_suite", "automation", "roles", "scheduler", "db", "fleet", "intake", "idle", "gravity"]);
// Accepted and validated as plain objects only; contents ignored in v0.
const FREEFORM_BLOCKS = new Set(["intake", "idle", "gravity"]);

const ADAPTERS = ["fake", "claude-sdk", "codex-mcp"];
const POOL_KINDS = ["window", "daily", "per-token", "free"];
const LEVELS = ["manual", "verdicts", "roundabout", "highways", "autopilot"];
const PROVIDER_KEYS = ["adapter", "auth", "api_key_env", "models", "tiers", "ratelimit_signal", "pool", "command", "endpoint", "max_budget_usd", "max_turns"];

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}
function isPosInt(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= 1;
}

export function validateConfig(cfg: unknown): string[] {
  if (!isObj(cfg)) return ["config root is not a JSON object"];
  if (cfg["schema_version"] !== 2) {
    if (cfg["schema_version"] === 1) {
      return ["schema_version must be the number 2, got 1 — this is a Lanes v1 config; rewrite it against templates/config.example.json (a migration command arrives in v0.5)"];
    }
    return [`schema_version must be the number 2, got ${JSON.stringify(cfg["schema_version"])}`];
  }
  const errors: string[] = [];
  for (const key of Object.keys(cfg)) {
    if (key !== "schema_version" && !(key in SCHEMA_V2)) errors.push(`unknown key '${key}'`);
  }
  for (const [block, fields] of Object.entries(SCHEMA_V2)) {
    const val = cfg[block];
    if (val === undefined) {
      if (!OPTIONAL_BLOCKS.has(block)) errors.push(`required block '${block}' is missing`);
      continue;
    }
    if (!isObj(val)) {
      errors.push(`'${block}' must be a JSON object`);
      continue;
    }
    if (FREEFORM_BLOCKS.has(block)) continue;
    if (block === "providers") {
      for (const [id, p] of Object.entries(val)) {
        if (!isObj(p)) errors.push(`'providers.${id}' must be a JSON object`);
      }
      continue;
    }
    for (const key of Object.keys(val)) {
      if (!(key in fields)) errors.push(`unknown key '${block}.${key}'`);
    }
    for (const [key, type] of Object.entries(fields)) {
      const v = val[key];
      const name = `'${block}.${key}'`;
      if (v === undefined) {
        if (!type.endsWith("?")) errors.push(`required field '${block}.${key}' is missing`);
      } else if (type === "posint?" && !isPosInt(v)) {
        errors.push(`${name} must be an integer >= 1`);
      } else if (type === "posint_map?" && !(isObj(v) && Object.values(v).every(isPosInt))) {
        errors.push(`${name} must be an object mapping provider ids to integers >= 1`);
      } else if (type === "number?" && typeof v !== "number") {
        errors.push(`${name} must be a number`);
      } else if (type === "bool?" && typeof v !== "boolean") {
        errors.push(`${name} must be a boolean`);
      } else if ((type === "string" || type === "string?") && typeof v !== "string") {
        errors.push(`${name} must be a string`);
      } else if ((type === "string[]" || type === "string[]?") && !isStringArray(v)) {
        errors.push(`${name} must be an array of strings`);
      } else if (type === "topic_map?" && !(isObj(v) && Object.values(v).every(isStringArray))) {
        errors.push(`${name} must be an object mapping category names to arrays of glob strings`);
      } else if (type === "route_map" && !(isObj(v) && Object.values(v).every(isStringArray))) {
        errors.push(`${name} must be an object mapping glob strings to arrays of ID strings`);
      }
    }
  }
  if (errors.length) return errors; // field rules below assume the structure above held

  const providers = cfg["providers"] as Record<string, Obj>;
  if (Object.keys(providers).length === 0) errors.push("'providers' must declare at least one provider");
  for (const [id, p] of Object.entries(providers)) {
    for (const k of Object.keys(p)) if (!PROVIDER_KEYS.includes(k)) errors.push(`unknown key 'providers.${id}.${k}'`);
    if (!ADAPTERS.includes(p["adapter"] as string)) errors.push(`'providers.${id}.adapter' must be one of ${ADAPTERS.join(", ")}`);
    if (p["auth"] !== undefined) {
      if (p["adapter"] !== "claude-sdk") errors.push(`'providers.${id}.auth' is only valid for adapter 'claude-sdk'`);
      else if (!["login", "api_key"].includes(p["auth"] as string)) errors.push(`'providers.${id}.auth' must be "login" or "api_key"`);
    }
    for (const k of ["api_key_env", "command", "endpoint"]) {
      if (p[k] !== undefined && typeof p[k] !== "string") errors.push(`'providers.${id}.${k}' must be a string`);
    }
    const models = p["models"];
    if (models !== undefined && !(isObj(models) && Object.values(models).every((x) => typeof x === "string"))) {
      errors.push(`'providers.${id}.models' must be an object mapping names to model id strings`);
    }
    for (const k of ["max_budget_usd", "max_turns"]) {
      const n = p[k];
      if (n !== undefined && !(typeof n === "number" && n > 0)) errors.push(`'providers.${id}.${k}' must be a number > 0`);
    }
    const tiers = p["tiers"];
    if (tiers !== undefined) {
      if (!isStringArray(tiers)) errors.push(`'providers.${id}.tiers' must be an array of strings`);
      else if (!tiers.length) errors.push(`'providers.${id}.tiers' must be a non-empty array`);
    }
    if (p["ratelimit_signal"] !== undefined && !isStringArray(p["ratelimit_signal"])) errors.push(`'providers.${id}.ratelimit_signal' must be an array of strings`);
    const pool = p["pool"];
    if (pool !== undefined) {
      if (!isObj(pool)) errors.push(`'providers.${id}.pool' must be a JSON object`);
      else {
        for (const k of Object.keys(pool)) if (k !== "kind" && k !== "reserve_floor") errors.push(`unknown key 'providers.${id}.pool.${k}'`);
        if (!POOL_KINDS.includes(pool["kind"] as string)) errors.push(`'providers.${id}.pool.kind' must be window, daily, per-token, or free`);
        const rf = pool["reserve_floor"];
        if (rf !== undefined && !(typeof rf === "number" && rf >= 0 && rf <= 1)) errors.push(`'providers.${id}.pool.reserve_floor' must be between 0 and 1`);
      }
    }
  }
  const roles = cfg["roles"] as Record<string, string[]> | undefined;
  if (roles) {
    for (const role of ["implement", "review"]) {
      for (const id of roles[role] ?? []) {
        if (!(id in providers)) errors.push(`roles.${role} names unknown provider '${id}'`);
      }
    }
  }
  const automation = cfg["automation"] as Obj | undefined;
  if (automation && !LEVELS.includes(automation["level"] as string)) {
    errors.push(automation["level"] === "conveyor"
      ? `'automation.level' "conveyor" was renamed to "roundabout" — edit .nexus/config.json and set automation.level to "roundabout"`
      : `'automation.level' must be ${LEVELS.map((l) => `"${l}"`).join(", ")}, got ${JSON.stringify(automation["level"])}`);
  }
  const commands = cfg["commands"] as Record<string, string>;
  for (const key of ["test", "acceptance_runner"]) {
    if ((commands[key] ?? "").trim() === "") {
      errors.push(`'commands.${key}' must be non-empty — "" is only allowed for lint and typecheck ("no such step")`);
    }
  }
  return errors;
}

export function normalizeConfig(cfg: unknown): NexusConfig {
  const errors = validateConfig(cfg);
  if (errors.length) throw new Error(errors.join("; "));
  const out = structuredClone(cfg) as Obj;
  const providers = out["providers"] as Record<string, ProviderConfig>;
  const ids = Object.keys(providers);
  const automation = (out["automation"] ?? {}) as Obj;
  out["automation"] = { level: automation["level"] ?? "manual", max_fix_rounds: automation["max_fix_rounds"] ?? 2 };
  const routing = out["routing"] as Obj;
  routing["attention"] = routing["attention"] ?? {};
  const roles = (out["roles"] ?? {}) as Obj;
  out["roles"] = { implement: roles["implement"] ?? [...ids], review: roles["review"] ?? [...ids] };
  const sched = (out["scheduler"] ?? {}) as Obj;
  out["scheduler"] = {
    max_concurrent_ships: sched["max_concurrent_ships"] ?? 6,
    max_concurrent_systems: sched["max_concurrent_systems"] ?? 1,
    per_provider_max: sched["per_provider_max"] ?? {},
  };
  const db = (out["db"] ?? {}) as Obj;
  out["db"] = { stats: db["stats"] ?? false };
  const fleet = (out["fleet"] ?? {}) as Obj;
  out["fleet"] = {
    freighters: fleet["freighters"] ?? 6,
    customs: fleet["customs"] ?? 2,
    carriers: fleet["carriers"] ?? 1,
    surveyors: fleet["surveyors"] ?? 1,
    name_theme: fleet["name_theme"] ?? "classic",
    ...(fleet["seed"] !== undefined ? { seed: fleet["seed"] } : {}),
  };
  for (const p of Object.values(providers)) {
    if (p.adapter === "claude-sdk") {
      p.auth ??= "login";
      p.api_key_env ??= "ANTHROPIC_API_KEY";
    }
  }
  return out as unknown as NexusConfig;
}

export function loadConfig(repoRoot: string): NexusConfig {
  const p = path.join(repoRoot, ".nexus", "config.json");
  if (!fs.existsSync(p)) throw new Error(".nexus/config.json not found — run 'nexus init' first");
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (err) {
    throw new Error(`.nexus/config.json is not valid JSON: ${String((err as Error).message || err)}`);
  }
  return normalizeConfig(raw);
}

export const DEFAULT_CONFIG: NexusConfig = {
  schema_version: 2,
  project: { app_subdir: "", command_prefix: "" },
  commands: { test: "npm test", lint: "", typecheck: "", acceptance_runner: "npm test" },
  providers: {
    fake: { adapter: "fake" },
    codex: {
      adapter: "codex-mcp",
      tiers: ["sol", "terra", "luna"],
      ratelimit_signal: ["usage limit", "rate limit", "429"],
      pool: { kind: "window", reserve_floor: 0.1 },
    },
    claude: {
      adapter: "claude-sdk",
      auth: "login",
      models: { frontier: "claude-opus-5-5", fast: "claude-haiku-5-5" },
      pool: { kind: "window", reserve_floor: 0.25 },
      max_turns: 60,
    },
  },
  roles: { implement: ["codex", "fake"], review: ["claude", "fake"] },
  routing: { security_routed: [], do_not_touch: [], attention: {} },
  pipeline: { plans_dir: ".nexus/plans", tasks_dir: ".nexus/specs", ledger: "docs/nexus/manifest.md" },
  automation: { level: "manual", max_fix_rounds: 2 },
  scheduler: { max_concurrent_ships: 6, max_concurrent_systems: 1, per_provider_max: {} },
  db: { stats: false },
  fleet: { freighters: 6, customs: 2, carriers: 1, surveyors: 1, name_theme: "classic" },
};
