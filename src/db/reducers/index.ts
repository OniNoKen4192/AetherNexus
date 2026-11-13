import type { Reducer } from "../events.js";
import { systemReducers } from "./systems.js";
import { planetReducers } from "./planets.js";
import { moonReducers } from "./moons.js";
import { shipReducers } from "./ships.js";
import { voyageReducers } from "./voyages.js";
import { verdictReducers } from "./verdicts.js";
import { decisionReducers } from "./decisions.js";
// tree.written only marks a path the system itself wrote into the main tree; nothing is projected from it.
const treeReducers: Record<string, Reducer> = { "tree.written": () => {} };
export const REDUCERS: Record<string, Reducer> = { ...treeReducers, ...systemReducers, ...planetReducers, ...moonReducers, ...shipReducers, ...voyageReducers, ...verdictReducers, ...decisionReducers };
