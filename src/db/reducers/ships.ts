import type { Reducer } from "../events.js";
import type { GeneratedShip } from "../../core/fleet.js";
const setStatus = (status: string): Reducer => (db, ev) => { db.run("ships.setStatus", { id: ev.ship_id!, status, last_event_id: ev.id }); };
export const shipReducers: Record<string, Reducer> = {
  "ship.registered": (db, ev) => {
    const ship = (ev.payload as { ship: GeneratedShip }).ship;
    db.run("ships.insert", { id: ship.id, name: ship.name, class: ship.class, fleet: ship.fleet, last_event_id: ev.id });
  },
  "ship.assigned": setStatus("assigned"),
  "ship.released": (db, ev) => {
    const outcome = (ev.payload as { outcome?: string }).outcome;
    db.run("ships.release", { id: ev.ship_id!, inc: outcome === "docked" || outcome === "superseded" ? 1 : 0, last_event_id: ev.id });
  },
  "ship.adrift": setStatus("adrift"),
  "ship.quarantined": setStatus("quarantined"),
  "ship.retired": setStatus("retired"),
};
