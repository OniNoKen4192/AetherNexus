import { useState } from "preact/hooks";
import { familyLines, gaugeText, meterValue } from "../gauge";
import { asFormation, formationText, sortShips } from "../ships";
import type { Bridge } from "../store";
import type { PoolView, Row } from "../types";
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

function Gauge({ pool }: { pool: PoolView }) {
  const value = meterValue(pool);
  const stateClass = {
    ok: "gauge-ok", low: "gauge-low", dry: "gauge-dry",
    unknown: "gauge-unknown", free: "gauge-free",
  }[pool.state];
  return <div className={`gauge ${stateClass}`}>
    {value !== null && <meter min="0" max="1" low={pool.reserve_floor} value={value} aria-label={`${pool.provider} fuel`} />}
    <div className="gauge-text">{gaugeText(pool, Date.now())}</div>
    {familyLines(pool).map((line, index) => <div className="gauge-family" key={`${line}-${index}`}>{line}</div>)}
  </div>;
}

function Ship({ b, ship }: { b: Bridge; ship: Row }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const command = useCommand(b);
  const id = String(ship["id"]);
  const status = String(ship["status"]);
  const formation = asFormation(ship["formation"]);
  const faction = typeof ship["faction"] === "string" ? ship["faction"] : null;
  const weight = typeof ship["weight"] === "string" ? ship["weight"] : null;
  const trips = typeof ship["voyage_count"] === "number" ? ship["voyage_count"] : null;
  const retire = async () => {
    const value = reason.trim();
    if (value !== "" && await command.send("fleet.retire", { shipId: id, reason: value })) {
      setOpen(false);
      setReason("");
    }
  };

  return <div className="fleet-ship">
    <span>{String(ship["name"])}</span>
    {faction !== null && <span className="fleet-ship-meta">{faction}</span>}
    {formation !== null && <span className="fleet-ship-meta">{formationText(formation)}</span>}
    {weight !== null && <span className="fleet-ship-meta">{weight}</span>}
    <span className="badge">{status}</span>
    {trips !== null && <span className="fleet-ship-meta">{trips === 1 ? `${trips} trip` : `${trips} trips`}</span>}
    <span className="fleet-ship-meta">{String(ship["job"])}</span>
    {status === "idle" && (!open ? <button className="btn" type="button" disabled={command.busy} onClick={() => setOpen(true)}>Retire</button> :
      <div className="fleet-retire">
        <input className="field" placeholder="Reason" aria-label={`Reason to retire ${String(ship["name"])}`} value={reason} disabled={command.busy} onInput={(event) => setReason(event.currentTarget.value)} />
        <button className="btn danger" type="button" disabled={command.busy || reason.trim() === ""} onClick={() => void retire()}>Confirm retire</button>
        <button className="btn" type="button" disabled={command.busy} onClick={() => { setOpen(false); setReason(""); command.clear(); }}>Cancel</button>
      </div>)}
    {command.error !== null && <div className="msg-error">{command.error}</div>}
  </div>;
}

export function Fleet({ b }: { b: Bridge }) {
  const snapshot = b.snapshot;
  const providers = new Map<string, ProviderFleet>();
  const pools = snapshot?.pools ?? [];
  const poolsByProvider = new Map(pools.map((pool) => [pool.provider, pool]));

  if (snapshot !== null) {
    for (const ship of snapshot.fleet) {
      const providerName = String(ship["fleet"]);
      const className = String(ship["job"]);
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
      ) : snapshot.fleet.length === 0 && pools.length === 0 ? (
        <div>No ships.</div>
      ) : (
        <>
        {Array.from(providers.values()).map((provider) => (
          <div className="fleet-group" key={provider.name}>
            <h3>{provider.name}</h3>
            {poolsByProvider.has(provider.name) && <Gauge pool={poolsByProvider.get(provider.name)!} />}
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
              {/* Sorted by a key beside each row; the line gets the row exactly as the server sent it, so a row from an older server shows what it has. */}
              {sortShips(provider.ships.map((ship) => ({ ship, name: String(ship["name"]), weight: typeof ship["weight"] === "string" ? ship["weight"] : "" })), Array.isArray(snapshot.weights) ? snapshot.weights : [])
                .map((entry) => <Ship b={b} ship={entry.ship} key={String(entry.ship["id"])} />)}
            </div>
          </div>
        ))}
        {Array.from(poolsByProvider.values()).filter((pool) => !providers.has(pool.provider)).map((pool) => (
          <div className="fleet-group" key={pool.provider}>
            <h3>{pool.provider}</h3>
            <Gauge pool={pool} />
          </div>
        ))}
        </>
      )}
    </section>
  );
}
