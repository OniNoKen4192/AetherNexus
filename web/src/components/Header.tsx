import type { Bridge } from "../store";

export function Header({ b }: { b: Bridge }) {
  const snapshot = b.snapshot;

  return (
    <header className="panel bridge-header">
      <div className="bridge-header-line">
        <h1>Bridge</h1>
        <span className={`badge connection ${b.conn === "live" ? "live" : "waiting"}`}>
          {b.conn}
        </span>
      </div>
      {snapshot === null ? (
        <div>Loading</div>
      ) : (
        <div className="bridge-summary">
          <strong>{snapshot.repo}</strong>
          <span>rung: {snapshot.rung}</span>
          <span>
            in flight {snapshot.limits.in_flight}/{snapshot.limits.max_concurrent_ships}
          </span>
        </div>
      )}
    </header>
  );
}
