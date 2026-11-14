import type { Bridge } from "../store";

type ShipClass = {
  name: string;
  statuses: Map<string, number>;
};

type ProviderFleet = {
  name: string;
  classes: Map<string, ShipClass>;
};

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
        provider = { name: providerName, classes: new Map() };
        providers.set(providerName, provider);
      }
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
          </div>
        ))
      )}
    </section>
  );
}
