import fs from "node:fs";
import path from "node:path";
import { BUILTIN } from "./builtin.js";
import type { CargoKind, Catalogue, Formation, NameRules, Vessel } from "./types.js";

const JOBS = new Set(["delivery", "customs", "transfer", "survey"]);
const ROLES = new Set(["lead", "escort", "cargo"]);

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonEmptyString(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function stringList(value: unknown): value is string[] { return Array.isArray(value) && value.every((entry) => typeof entry === "string"); }

function cloneVessel(vessel: Vessel): Vessel { return { hull: vessel.hull, count: vessel.count, role: vessel.role }; }
function cloneFormation(formation: Formation): Formation {
  const copy: Formation = { id: formation.id, name: formation.name, job: formation.job, vessels: formation.vessels.map(cloneVessel) };
  if (formation.weights !== undefined) copy.weights = [...formation.weights];
  if (formation.factions !== undefined) copy.factions = [...formation.factions];
  if ("art" in formation) copy.art = formation.art;
  return copy;
}
function cloneCargo(cargo: CargoKind): CargoKind {
  const copy: CargoKind = { id: cargo.id, label: cargo.label };
  if (cargo.weights !== undefined) copy.weights = [...cargo.weights];
  return copy;
}
function cloneRules(rules: NameRules): NameRules {
  return { pools: Object.fromEntries(Object.entries(rules.pools).map(([name, words]) => [name, [...words]])), patterns: [...rules.patterns] };
}

function validateWeightReferences(value: unknown, available: readonly string[], entry: string, source: string, errors: string[]): void {
  if (!stringList(value)) { errors.push(`${source}: ${entry} weights must be an array of strings`); return; }
  value.forEach((weight) => { if (!available.includes(weight)) errors.push(`${source}: ${entry} has unknown weight '${weight}'`); });
}

export function validateCatalogue(value: unknown, source: string): string[] {
  const errors: string[] = [];
  if (!object(value)) return [`${source}: catalogue must be an object`];

  let availableWeights: readonly string[] = BUILTIN.weights;
  if ("weights" in value) {
    if (!stringList(value.weights)) errors.push(`${source}: weights must be an array of strings`);
    else {
      availableWeights = value.weights;
      value.weights.forEach((weight, index) => { if (weight.length === 0) errors.push(`${source}: weight at index ${index} must be a non-empty string`); });
    }
  }

  if ("formations" in value) {
    if (!Array.isArray(value.formations)) errors.push(`${source}: formations must be an array`);
    else {
      const ids = new Set<string>();
      value.formations.forEach((entry, index) => {
        const at = object(entry) && nonEmptyString(entry.id) ? `formation '${entry.id}'` : `formation at index ${index}`;
        if (!object(entry)) { errors.push(`${source}: ${at} must be an object`); return; }
        if (!nonEmptyString(entry.id)) errors.push(`${source}: ${at} id must be a non-empty string`);
        else if (ids.has(entry.id)) errors.push(`${source}: ${at} has duplicate id`);
        else ids.add(entry.id);
        if (!nonEmptyString(entry.name)) errors.push(`${source}: ${at} name must be a non-empty string`);
        if (typeof entry.job !== "string" || !JOBS.has(entry.job)) errors.push(`${source}: ${at} has unknown job '${String(entry.job)}'`);
        if ("weights" in entry) validateWeightReferences(entry.weights, availableWeights, at, source, errors);
        if ("factions" in entry && !stringList(entry.factions)) errors.push(`${source}: ${at} factions must be an array of strings`);
        if ("art" in entry && entry.art !== null && typeof entry.art !== "string") errors.push(`${source}: ${at} art must be a string or null`);
        if (!Array.isArray(entry.vessels)) errors.push(`${source}: ${at} vessels must be an array`);
        else {
          let hasLead = false;
          entry.vessels.forEach((vessel, vesselIndex) => {
            const vesselAt = `${at} vessel at index ${vesselIndex}`;
            if (!object(vessel)) { errors.push(`${source}: ${vesselAt} must be an object`); return; }
            if (!nonEmptyString(vessel.hull)) errors.push(`${source}: ${vesselAt} hull must be a non-empty string`);
            if (!Number.isInteger(vessel.count) || (vessel.count as number) <= 0) errors.push(`${source}: ${vesselAt} count must be a positive integer`);
            if (typeof vessel.role !== "string" || !ROLES.has(vessel.role)) errors.push(`${source}: ${vesselAt} has invalid role '${String(vessel.role)}'`);
            if (vessel.role === "lead") hasLead = true;
          });
          if (!hasLead) errors.push(`${source}: ${at} must have a lead vessel`);
        }
      });
    }
  }

  if ("cargo" in value) {
    if (!Array.isArray(value.cargo)) errors.push(`${source}: cargo must be an array`);
    else {
      const ids = new Set<string>();
      value.cargo.forEach((entry, index) => {
        const at = object(entry) && nonEmptyString(entry.id) ? `cargo '${entry.id}'` : `cargo at index ${index}`;
        if (!object(entry)) { errors.push(`${source}: ${at} must be an object`); return; }
        if (!nonEmptyString(entry.id)) errors.push(`${source}: ${at} id must be a non-empty string`);
        else if (ids.has(entry.id)) errors.push(`${source}: ${at} has duplicate id`);
        else ids.add(entry.id);
        if (!nonEmptyString(entry.label)) errors.push(`${source}: ${at} label must be a non-empty string`);
        if ("weights" in entry) validateWeightReferences(entry.weights, availableWeights, at, source, errors);
      });
    }
  }

  if ("names" in value) {
    if (!object(value.names)) errors.push(`${source}: names must be an object`);
    else Object.entries(value.names).forEach(([faction, rules]) => {
      const at = `names '${faction}'`;
      if (!object(rules)) { errors.push(`${source}: ${at} must be an object`); return; }
      const poolNames = new Set<string>();
      if (!object(rules.pools)) errors.push(`${source}: ${at} pools must be an object`);
      else Object.entries(rules.pools).forEach(([pool, words]) => {
        poolNames.add(pool);
        if (!stringList(words)) errors.push(`${source}: ${at} pool '${pool}' must be an array of strings`);
        else if (words.length === 0) errors.push(`${source}: ${at} pool '${pool}' must not be empty`);
        else words.forEach((word, index) => { if (word.length === 0) errors.push(`${source}: ${at} pool '${pool}' word at index ${index} must be a non-empty string`); });
      });
      if (!stringList(rules.patterns)) errors.push(`${source}: ${at} patterns must be an array of strings`);
      else if (rules.patterns.length === 0) errors.push(`${source}: ${at} patterns must not be empty`);
      else rules.patterns.forEach((pattern, index) => {
        if (pattern.length === 0) errors.push(`${source}: ${at} pattern at index ${index} must be a non-empty string`);
        for (const match of pattern.matchAll(/\{([^{}]+)\}/g)) {
          if (!poolNames.has(match[1]!)) errors.push(`${source}: ${at} pattern at index ${index} names missing pool '${match[1]}'`);
        }
      });
    });
  }
  return errors;
}

function mergeById<T extends { id: string }>(base: readonly T[], extra: readonly T[], clone: (entry: T) => T): T[] {
  const replacements = new Map(extra.map((entry) => [entry.id, entry]));
  const result = base.map((entry) => clone(replacements.get(entry.id) ?? entry));
  const baseIds = new Set(base.map((entry) => entry.id));
  extra.forEach((entry) => { if (!baseIds.has(entry.id)) result.push(clone(entry)); });
  return result;
}

export function mergeCatalogue(base: Catalogue, extra: Partial<Catalogue>): Catalogue {
  const names: Record<string, NameRules> = Object.fromEntries(Object.entries(base.names).map(([faction, rules]) => [faction, cloneRules(rules)]));
  if (extra.names !== undefined) Object.entries(extra.names).forEach(([faction, rules]) => { names[faction] = cloneRules(rules); });
  return {
    weights: [...(extra.weights ?? base.weights)],
    formations: mergeById(base.formations, extra.formations ?? [], cloneFormation),
    cargo: mergeById(base.cargo, extra.cargo ?? [], cloneCargo),
    names,
  };
}

export function loadCatalogue(nexusDir: string): Catalogue {
  const file = path.join(nexusDir, "catalogue.json");
  if (!fs.existsSync(file)) return mergeCatalogue(BUILTIN, {});
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { throw new Error(`Invalid catalogue JSON in ${file}: ${error instanceof Error ? error.message : String(error)}`); }
  const errors = validateCatalogue(value, file);
  if (errors.length > 0) throw new Error(`Invalid catalogue:\n${errors.join("\n")}`);
  return mergeCatalogue(BUILTIN, value as Partial<Catalogue>);
}
