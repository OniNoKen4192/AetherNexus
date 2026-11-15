import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { normalizeConfig, validateConfig, type NexusConfig } from "../../config/schema.js";
import { append } from "../../db/events.js";
import { recordTreeWrite } from "../dispatch.js";
import { Refusal } from "../errors.js";
import type { Galaxy } from "../galaxy.js";

type Role = "implement" | "review";
type JsonObject = Record<string, unknown>;
export type SelectableRung = "manual" | "verdicts" | "roundabout";

type ConfigUpdate<T> = { candidate: JsonObject; result: T } | { result: T };

function normalizedOrRefusal(config: unknown): NexusConfig {
  try {
    return normalizeConfig(config);
  } catch (err) {
    throw new Refusal(err instanceof Error ? err.message : String(err));
  }
}

function updateDiskConfig<T>(g: Galaxy, update: (file: JsonObject) => ConfigUpdate<T>): T {
  const relativePath = ".nexus/config.json";
  const configPath = path.join(g.repoRoot, ".nexus", "config.json");
  let file: unknown;
  try {
    file = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (err) {
    throw new Refusal(`${relativePath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (typeof file !== "object" || file === null || Array.isArray(file)) {
    throw new Refusal(validateConfig(file).join("; "));
  }

  const change = update(file as JsonObject);
  if (!("candidate" in change)) return change.result;

  const errors = validateConfig(change.candidate);
  if (errors.length) throw new Refusal(errors.join("; "));

  recordTreeWrite(g, [relativePath]);
  const tempPath = path.join(path.dirname(configPath), `.config.json.${process.pid}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tempPath, JSON.stringify(change.candidate, null, 2) + "\n", { flag: "wx" });
    fs.renameSync(tempPath, configPath);
  } finally {
    try { fs.rmSync(tempPath, { force: true }); } catch { /* preserve the original write error */ }
  }

  g.config = normalizeConfig(change.candidate);
  return change.result;
}

export function setRoleOrder(
  g: Galaxy,
  input: { role: Role; order: string[] },
): { roles: NexusConfig["roles"] } {
  return updateDiskConfig(g, (parsed) => {
    const fileRoles = parsed["roles"];
    let current: string[];
    if (typeof fileRoles === "object" && fileRoles !== null && !Array.isArray(fileRoles) && (fileRoles as JsonObject)[input.role] !== undefined) {
      const value = (fileRoles as JsonObject)[input.role];
      if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
        const errors = validateConfig(parsed);
        throw new Refusal(errors.join("; "));
      }
      current = value;
    } else {
      current = normalizedOrRefusal(parsed).roles[input.role];
    }

    const expected = `order must contain exactly the providers listed for '${input.role}': ${current.join(", ")}`;
    const currentSet = new Set(current);
    const orderSet = new Set(input.order);
    if (input.order.length !== current.length || currentSet.size !== current.length || orderSet.size !== input.order.length || input.order.some((id) => !currentSet.has(id))) {
      throw new Refusal(expected);
    }

    const candidate = structuredClone(parsed);
    if (candidate["roles"] === undefined) {
      const normalized = normalizedOrRefusal(parsed);
      candidate["roles"] = { ...normalized.roles, [input.role]: [...input.order] };
    } else {
      (candidate["roles"] as JsonObject)[input.role] = [...input.order];
    }

    return { candidate, result: { roles: normalizedOrRefusal(candidate).roles } };
  });
}

export function setAutomationLevel(
  g: Galaxy,
  input: { level: string },
): { level: SelectableRung; from: string; changed: boolean } {
  if (input.level === "highways" || input.level === "autopilot") {
    throw new Refusal(`'${input.level}' is not available yet — it arrives in a later release`);
  }
  if (input.level !== "manual" && input.level !== "verdicts" && input.level !== "roundabout") {
    throw new Refusal("level must be manual, verdicts or roundabout");
  }
  const level: SelectableRung = input.level;
  let from = "manual";
  const result = updateDiskConfig(g, (file) => {
    const errors = validateConfig(file);
    if (errors.length) throw new Refusal(errors.join("; "));
    const normalized = normalizeConfig(file);
    from = normalized.automation.level;
    const response = { level, from, changed: from !== level };
    if (!response.changed) return { result: response };

    const candidate = structuredClone(file);
    const automation = candidate["automation"];
    candidate["automation"] = automation === undefined
      ? { ...normalized.automation, level }
      : { ...(automation as JsonObject), level };
    return { candidate, result: response };
  });

  if (result.changed) {
    append(g.db, { kind: "config.changed", payload: { key: "automation.level", from, to: level, pid: process.pid } });
  }
  return result;
}

export function reloadConfig(g: Galaxy): { ok: true } | { ok: false; error: string } {
  const relativePath = ".nexus/config.json";
  const configPath = path.join(g.repoRoot, ".nexus", "config.json");
  try {
    let file: unknown;
    try {
      file = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch (err) {
      throw new Error(`${relativePath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    const errors = validateConfig(file);
    if (errors.length) throw new Error(errors.join("; "));
    const config = normalizeConfig(file);
    g.config = config;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
