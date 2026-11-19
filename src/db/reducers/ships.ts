import type { Reducer } from "../events.js";
import { legacyShip, type GeneratedShip, type ShipRecord } from "../../core/fleet.js";
import type { NexusDb } from "../open.js";
const setStatus = (status: string): Reducer => (db, ev) => { db.run("ships.setStatus", { id: ev.ship_id!, status, last_event_id: ev.id }); };
// The whole record is copied from the event: a reducer never reads the catalogue or the config.
function insertShip(db: NexusDb, ship: ShipRecord, eventId: number): void {
  db.run("ships.insert", { id: ship.id, name: ship.name, job: ship.job, fleet: ship.fleet, faction: ship.faction, weight: ship.weight, formation: JSON.stringify(ship.formation), last_event_id: eventId });
}
export const shipReducers: Record<string, Reducer> = {
  "ship.registered": (db, ev) => {
    // a ship of the fleet that was registered up front (before migration 003): same rows as the migration gives
    insertShip(db, legacyShip((ev.payload as { ship: GeneratedShip }).ship), ev.id);
  },
  "ship.commissioned": (db, ev) => { insertShip(db, (ev.payload as { ship: ShipRecord }).ship, ev.id); },
  "ship.released": (db, ev) => {
    const outcome = (ev.payload as { outcome?: string }).outcome;
    db.run("ships.release", { id: ev.ship_id!, inc: outcome === "docked" || outcome === "superseded" ? 1 : 0, last_event_id: ev.id });
  },
  "ship.adrift": setStatus("adrift"),
  "ship.quarantined": setStatus("quarantined"),
  "ship.retired": setStatus("retired"),
};
