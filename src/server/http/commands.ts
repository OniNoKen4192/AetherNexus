import path from "node:path";
import { GitRefusal } from "../../core/git.js";
import { TransitionRefused } from "../../core/transitions.js";
import { assignMoon, assignPlanet } from "../commands/assign.js";
import { setRoleOrder } from "../commands/config.js";
import { answerDecision } from "../commands/decision.js";
import { dockMoon } from "../commands/dock.js";
import { launchMoon } from "../commands/launch.js";
import { dropMoon, parkStaleMoon, replyMoon, retireShip } from "../commands/park.js";
import { inspectMoon } from "../commands/review.js";
import { createSystem } from "../commands/system.js";
import { loadMoon } from "../dispatch.js";
import { Refusal } from "../errors.js";
import type { Galaxy } from "../galaxy.js";
import type { VoyageRunner } from "./runner.js";

export type CommandOutcome = { status: 200; body: { result: unknown } } | { status: 202; body: { voyageId: string } };
export class UnknownCommand extends Error {}
export class BadRequest extends Error {}

type Field = { type: "string" | "integer" | "strings"; optional?: true; values?: readonly string[] };
type Definition = { fields: Record<string, Field>; run: (g: Galaxy, runner: VoyageRunner, input: Record<string, unknown>) => unknown | Promise<unknown> };
const s = (optional = false, values?: readonly string[]): Field => ({ type: "string", ...(optional ? { optional: true as const } : {}), ...(values ? { values } : {}) });
const strings = (optional = false): Field => ({ type: "strings", ...(optional ? { optional: true as const } : {}) });

const COMMANDS: Record<string, Definition> = {
  "system.create": { fields: { slug: s(), title: s(), brief: s(), kind: s(true, ["feature", "bug"]), seed: { type: "integer", optional: true } }, run: (g, _r, i) => createSystem(g, i as Parameters<typeof createSystem>[1]) },
  "planet.assign": { fields: { systemId: s(), streamId: s(), mission: s(), territory: strings(), dependsOn: strings(true), planetName: s(true) }, run: (g, _r, i) => assignPlanet(g, i as Parameters<typeof assignPlanet>[1]) },
  "moon.assign": { fields: { planetId: s(), specPath: s(), moonName: s(true) }, run: (g, _r, i) => {
    const target = path.resolve(g.repoRoot, i["specPath"] as string);
    const rel = path.relative(path.resolve(g.repoRoot), target);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new BadRequest("specPath must be inside the repository");
    return assignMoon(g, i as Parameters<typeof assignMoon>[1]);
  } },
  "moon.launch": { fields: { taskId: s(), provider: s(true) }, run: (g, runner, i) => runner.start(i["taskId"] as string, ({ signal, onLaunched }) => launchMoon(g, { ...(i as { taskId: string; provider?: string }), signal, onLaunched })) },
  "voyage.inspect": { fields: { taskId: s(), provider: s(true) }, run: (g, runner, i) => runner.start(i["taskId"] as string, ({ signal, onLaunched }) => inspectMoon(g, { ...(i as { taskId: string; provider?: string }), signal, onLaunched })) },
  "voyage.dock": { fields: { taskId: s() }, run: (g, _r, i) => dockMoon(g, i as Parameters<typeof dockMoon>[1]) },
  "voyage.cancel": { fields: { voyageId: s() }, run: (_g, runner, i) => { runner.cancel(i["voyageId"] as string); return { cancelled: true }; } },
  "moon.reply": { fields: { taskId: s(), note: s() }, run: (g, _r, i) => replyMoon(g, i as Parameters<typeof replyMoon>[1]) },
  "moon.drop": { fields: { taskId: s() }, run: (g, _r, i) => dropMoon(g, i as Parameters<typeof dropMoon>[1]) },
  "moon.park": { fields: { taskId: s(), reason: s() }, run: (g, runner, i) => {
    const moon = loadMoon(g, i["taskId"] as string);
    for (const v of g.db.all("voyages.byAssignment", { assignment_id: moon.assignment_id })) {
      if ((v["status"] === "launched" || v["status"] === "working") && runner.tracks(String(v["id"]))) {
        throw new Refusal(`voyage ${String(v["id"])} is running in this server — cancel it instead of parking the moon`);
      }
    }
    return parkStaleMoon(g, i as Parameters<typeof parkStaleMoon>[1]);
  } },
  "fleet.retire": { fields: { shipId: s(), reason: s() }, run: (g, _r, i) => { retireShip(g, i as Parameters<typeof retireShip>[1]); return { retired: true }; } },
  "config.roles": { fields: { role: s(false, ["implement", "review"]), order: strings() }, run: (g, _r, i) => setRoleOrder(g, i as Parameters<typeof setRoleOrder>[1]) },
  "decision.answer": { fields: { decisionId: { type: "integer" }, answer: s(false, ["mine", "not_mine"]) }, run: (g, _r, i) => answerDecision(g, i as Parameters<typeof answerDecision>[1]) },
};

function validate(body: unknown, fields: Record<string, Field>): Record<string, unknown> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new BadRequest("body must be a plain object");
  const prototype = Object.getPrototypeOf(body);
  if (prototype !== Object.prototype && prototype !== null) throw new BadRequest("body must be a plain object");
  const source = body as Record<string, unknown>;
  for (const key of Object.keys(source)) if (!Object.hasOwn(fields, key)) throw new BadRequest(`unexpected field '${key}'`);
  const input: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(fields)) {
    if (!Object.hasOwn(source, key)) {
      if (!field.optional) throw new BadRequest(`missing field '${key}'`);
      continue;
    }
    const value = source[key];
    if (field.type === "string") {
      if (typeof value !== "string" || value.length === 0) throw new BadRequest(`field '${key}' must be a non-empty string`);
      if (field.values && !field.values.includes(value)) throw new BadRequest(`field '${key}' has an invalid value`);
    } else if (field.type === "integer") {
      if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) throw new BadRequest(`field '${key}' must be a finite integer`);
    } else if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
      throw new BadRequest(`field '${key}' must be an array of non-empty strings`);
    }
    input[key] = value;
  }
  return input;
}

export async function runCommand(g: Galaxy, runner: VoyageRunner, name: string, body: unknown): Promise<CommandOutcome> {
  if (!Object.hasOwn(COMMANDS, name)) throw new UnknownCommand(`unknown command '${name}'`);
  const command = COMMANDS[name]!;
  const result = await command.run(g, runner, validate(body, command.fields));
  if (name === "moon.launch" || name === "voyage.inspect") {
    const answer = result as { launched: boolean; voyageId?: string; result?: unknown };
    if (answer.launched) return { status: 202, body: { voyageId: answer.voyageId! } };
    return { status: 200, body: { result: answer.result } };
  }
  return { status: 200, body: { result } };
}

export function errorResponse(e: unknown): { status: number; body: { error: string; details?: unknown } } {
  if (e instanceof BadRequest) return { status: 400, body: { error: e.message } };
  if (e instanceof UnknownCommand) return { status: 404, body: { error: e.message } };
  if (e instanceof Refusal) return { status: 409, body: { error: e.message, ...(e.details ? { details: e.details } : {}) } };
  if (e instanceof TransitionRefused || e instanceof GitRefusal) return { status: 409, body: { error: e.message } };
  console.error(e);
  return { status: 500, body: { error: "internal error" } };
}
