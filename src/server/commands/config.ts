import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { normalizeConfig, validateConfig, type NexusConfig } from "../../config/schema.js";
import { recordTreeWrite } from "../dispatch.js";
import { Refusal } from "../errors.js";
import type { Galaxy } from "../galaxy.js";

type Role = "implement" | "review";
type JsonObject = Record<string, unknown>;

function normalizedOrRefusal(config: unknown): NexusConfig {
  try {
    return normalizeConfig(config);
  } catch (err) {
    throw new Refusal(err instanceof Error ? err.message : String(err));
  }
}

export function setRoleOrder(
  g: Galaxy,
  input: { role: Role; order: string[] },
): { roles: NexusConfig["roles"] } {
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
  const parsed = file as JsonObject;
  const fileRoles = parsed["roles"];
  let current: string[];
  if (typeof fileRoles === "object" && fileRoles !== null && !Array.isArray(fileRoles) && (fileRoles as JsonObject)[input.role] !== undefined) {
    const value = (fileRoles as JsonObject)[input.role];
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
      const errors = validateConfig(file);
      throw new Refusal(errors.join("; "));
    }
    current = value;
  } else {
    current = normalizedOrRefusal(file).roles[input.role];
  }

  const expected = `order must contain exactly the providers listed for '${input.role}': ${current.join(", ")}`;
  const currentSet = new Set(current);
  const orderSet = new Set(input.order);
  if (input.order.length !== current.length || currentSet.size !== current.length || orderSet.size !== input.order.length || input.order.some((id) => !currentSet.has(id))) {
    throw new Refusal(expected);
  }

  const candidate = structuredClone(parsed);
  if (candidate["roles"] === undefined) {
    const normalized = normalizedOrRefusal(file);
    candidate["roles"] = { ...normalized.roles, [input.role]: [...input.order] };
  } else {
    (candidate["roles"] as JsonObject)[input.role] = [...input.order];
  }

  const errors = validateConfig(candidate);
  if (errors.length) throw new Refusal(errors.join("; "));

  recordTreeWrite(g, [relativePath]);
  const tempPath = path.join(path.dirname(configPath), `.config.json.${process.pid}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tempPath, JSON.stringify(candidate, null, 2) + "\n", { flag: "wx" });
    fs.renameSync(tempPath, configPath);
  } finally {
    try { fs.rmSync(tempPath, { force: true }); } catch { /* preserve the original write error */ }
  }

  g.config = normalizeConfig(candidate);
  return { roles: g.config.roles };
}
