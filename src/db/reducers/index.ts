import type { Reducer } from "../events.js";
import { systemReducers } from "./systems.js";
import { planetReducers } from "./planets.js";
import { moonReducers } from "./moons.js";
import { shipReducers } from "./ships.js";
import { voyageReducers } from "./voyages.js";
import { verdictReducers } from "./verdicts.js";
import { decisionReducers } from "./decisions.js";
export const REDUCERS: Record<string, Reducer> = { ...systemReducers, ...planetReducers, ...moonReducers, ...shipReducers, ...voyageReducers, ...verdictReducers, ...decisionReducers };
