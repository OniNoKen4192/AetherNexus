import type { Reducer } from "../events.js";
import { systemReducers } from "./systems.js";
import { planetReducers } from "./planets.js";
import { moonReducers } from "./moons.js";
import { shipReducers } from "./ships.js";
import { voyageReducers } from "./voyages.js";
import { verdictReducers } from "./verdicts.js";
import { decisionReducers } from "./decisions.js";
const treeReducers: Record<string, Reducer> = {
  // tree.written only marks a path the system itself wrote into the main tree; nothing is projected from it.
  "tree.written": () => {},
  // scheduler.acted records scheduler activity for the event log; nothing is projected from it.
  "scheduler.acted": () => {},
  // fuel.reading records a provider fuel reading for the event log; nothing is projected from it.
  "fuel.reading": () => {},
  // fuel.exhausted records provider fuel exhaustion for the event log; nothing is projected from it.
  "fuel.exhausted": () => {},
  // limiter.held records limiter activity for the event log; nothing is projected from it.
  "limiter.held": () => {},
  // limiter.rerouted records limiter activity for the event log; nothing is projected from it.
  "limiter.rerouted": () => {},
  // limiter.refuelled records limiter activity for the event log; nothing is projected from it.
  "limiter.refuelled": () => {},
  // config.changed records configuration changes for the event log; nothing is projected from it.
  "config.changed": () => {},
};
export const REDUCERS: Record<string, Reducer> = { ...treeReducers, ...systemReducers, ...planetReducers, ...moonReducers, ...shipReducers, ...voyageReducers, ...verdictReducers, ...decisionReducers };
