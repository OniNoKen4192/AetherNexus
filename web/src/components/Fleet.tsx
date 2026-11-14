import { useState } from "preact/hooks";
import type { Bridge } from "../store";
import type { Row } from "../types";
import { useCommand } from "./ActionBar";

type ShipClass = {
  name: string;
  statuses: Map<string, number>;
};

type ProviderFleet = {
  name: string;
  classes: Map<string, ShipClass>;
  ships: Row[];
};

function Ship({ b, ship }: { b: Bridge; ship: Row }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const command = useCommand(b);
  const id = String(ship["id"]);
  const status = String(ship["status"]);
  const retire = async () => {
    const value = reason.trim();
    if (value !== "" && await command.send("fleet.retire", { shipId: id, reason: value })) {
      setOpen(false);
      setReason("");
    }
  };

  return <div className="fleet-ship">
    <span>{String(ship["name"])}</span><span>{String(ship["class"])}</span><span className="badge">{status}</span>
    {status === "idle" && (!open ? <button className="btn" type="button" disabled={command.busy} onClick={() => setOpen(true)}>Retire</button> :
      <div className="fleet-retire">
        <input className="field" aria-label={`Reason to retire ${String(ship["name"])}`} value={reason} disabled={command.busy} onInput={(event) => setReason(event.currentTarget.value)} />
        <button className="btn danger" type="button" disabled={command.busy || reason.trim() === ""} onClick={() => void retire()}>Confirm retire</button>
        <button className="btn" type="button" disabled={command.busy} onClick={() => { setOpen(false); setReason(""); command.clear(); }}>Cancel</button>
        {command.error !== null && <div className="msg-error">{command.error}</div>}
      </div>)}
  </div>;
}

export function Fleet({ b }: { b: Bridge }) {
  const snapshot = b.snapshot;
  const providers = new Map<string, ProviderFleet>();

  if (snapshot !== null) {
    for (const ship of snapshot.fleet) {
      const providerName = String(ship["fleet"]);
      const className = String(ship["class"]);
      const status = String(ship["status"]);
      let provider = providers.get(providerName);
      if (provider === undefined) {
        provider = { name: providerName, classes: new Map(), ships: [] };
        providers.set(providerName, provider);
      }
      provider.ships.push(ship);
      let shipClass = provider.classes.get(className);
      if (shipClass === undefined) {
        shipClass = { name: className, statuses: new Map() };
        provider.classes.set(className, shipClass);
      }
      shipClass.statuses.set(status, (shipClass.statuses.get(status) ?? 0) + 1);
    }
  }

  return (
    <section className="panel">
      <h2>Fleet</h2>
      {snapshot === null ? (
        <div>Loading</div>
      ) : snapshot.fleet.length === 0 ? (
        <div>No ships.</div>
      ) : (
        Array.from(providers.values()).map((provider) => (
          <div className="fleet-group" key={provider.name}>
            <h3>{provider.name}</h3>
            {Array.from(provider.classes.values()).map((shipClass) => (
              <div className="fleet-line" key={shipClass.name}>
                <span>{shipClass.name}</span>
                <span>
                  {Array.from(shipClass.statuses.entries())
                    .filter(([, count]) => count > 0)
                    .map(([status, count]) => `${count} ${status}`)
                    .join(", ")}
                </span>
              </div>
            ))}
            <div className="fleet-ships">
              {provider.ships.map((ship) => <Ship b={b} ship={ship} key={String(ship["id"])} />)}
            </div>
          </div>
        ))
      )}
    </section>
  );
}
