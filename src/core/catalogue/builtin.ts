import type { Catalogue, ShipFormation } from "./types.js";

export const PLAIN_FORMATION: ShipFormation = {
  id: "plain",
  name: "Ship",
  vessels: [{ hull: "ship", count: 1, role: "lead" }],
};

const openaiAdjectives = ["Bright", "Calm", "Clear", "Constant", "Distant", "Earnest", "Emerald", "Faithful", "Golden", "Honest", "Kindly", "Lucid", "Patient", "Quiet", "Resolute", "Silver", "Steady", "True", "Vigilant", "Wise"];
const openaiNouns = ["Beacon", "Compass", "Crossing", "Dawn", "Harbor", "Horizon", "Journey", "Lantern", "Meridian", "Passage", "Pathfinder", "Promise", "Reach", "Sail", "Star", "Steward", "Tide", "Venture", "Waypoint", "Wind"];
const anthropicAdjectives = ["Amber", "Ancient", "Autumn", "Cedar", "Crimson", "Deep", "Flint", "Iron", "Mossy", "Ochre", "Old", "Red", "River", "Rugged", "Sable", "Stone", "Timber", "Umber", "Wild", "Winter"];
const anthropicNouns = ["Badger", "Canyon", "Cliff", "Crane", "Elk", "Falcon", "Forest", "Fox", "Grove", "Heron", "Mesa", "Mountain", "Oak", "Raven", "Ridge", "Stag", "Summit", "Trail", "Valley", "Wolf"];

export const BUILTIN: Catalogue = {
  weights: ["light", "standard", "heavy"],
  formations: [
    { id: "mining-vessel", name: "Mining vessel", job: "delivery", weights: ["light"], vessels: [{ hull: "miner", count: 1, role: "lead" }] },
    { id: "courier", name: "Courier", job: "delivery", weights: ["light"], vessels: [{ hull: "courier", count: 1, role: "lead" }] },
    { id: "freighter", name: "Freighter", job: "delivery", weights: ["standard"], vessels: [{ hull: "freighter", count: 1, role: "lead" }] },
    { id: "freighter-with-escort", name: "Freighter with escort", job: "delivery", weights: ["standard"], vessels: [{ hull: "freighter", count: 1, role: "lead" }, { hull: "corvette", count: 1, role: "escort" }] },
    { id: "carrier-group", name: "Carrier group", job: "delivery", weights: ["heavy"], vessels: [{ hull: "carrier", count: 1, role: "lead" }, { hull: "frigate", count: 4, role: "escort" }] },
    { id: "freighter-convoy", name: "Freighter convoy", job: "delivery", weights: ["heavy"], vessels: [{ hull: "freighter", count: 3, role: "lead" }, { hull: "corvette", count: 2, role: "escort" }] },
    { id: "heavy-freighter-with-military-escort", name: "Heavy freighter with military escort", job: "delivery", weights: ["heavy"], vessels: [{ hull: "heavy-freighter", count: 1, role: "lead" }, { hull: "destroyer", count: 1, role: "escort" }, { hull: "frigate", count: 2, role: "escort" }] },
    { id: "customs-cutter", name: "Customs cutter", job: "customs", vessels: [{ hull: "customs-cutter", count: 1, role: "lead" }] },
  ],
  cargo: [
    { id: "ore-samples", label: "ore samples", weights: ["light"] },
    { id: "spare-parts", label: "spare parts", weights: ["light"] },
    { id: "trade-goods", label: "trade goods", weights: ["standard"] },
    { id: "machine-tools", label: "machine tools", weights: ["standard"] },
    { id: "diplomat", label: "a diplomat", weights: ["heavy"] },
    { id: "precious-cargo", label: "precious cargo", weights: ["heavy"] },
    { id: "relief-supplies", label: "relief supplies", weights: ["heavy"] },
  ],
  names: {
    openai: { pools: { adjective: openaiAdjectives, noun: openaiNouns }, patterns: ["{adjective} {noun}"] },
    anthropic: { pools: { adjective: anthropicAdjectives, noun: anthropicNouns }, patterns: ["{adjective} {noun}"] },
  },
};
