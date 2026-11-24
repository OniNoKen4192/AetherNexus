import { useState } from "preact/hooks";
import type { Bridge } from "../store";
import { useCommand } from "./ActionBar";

export function Header({ b }: { b: Bridge }) {
  const snapshot = b.snapshot;
  const command = useCommand(b);
  const [pending, setPending] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const readyToSend = snapshot !== null && typeof snapshot.ready_to_send === "number" ? snapshot.ready_to_send : 0;

  const changeRung = async (level: string) => {
    command.clear();
    setPending(level);
    setConfirming(false);
    if (level === "roundabout" && readyToSend > 0) {
      setConfirming(true);
      return;
    }
    await command.send("config.automation", { level });
    setPending(null);
  };

  const raise = async () => {
    await command.send("config.automation", { level: "roundabout" });
    setConfirming(false);
    setPending(null);
  };

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
        <>
          <div className="bridge-summary">
            <strong>{snapshot.repo}</strong>
            <label className="rung-control">
              <span>rung: </span>
              <select
                className="field"
                aria-label="Trust rung"
                value={pending ?? snapshot.rung}
                disabled={command.busy}
                onChange={(event) => void changeRung(event.currentTarget.value)}
              >
                <option value="manual">manual — you do every step</option>
                <option value="verdicts">verdicts — you send each delivery; the server inspects, docks and re-runs fixes</option>
                <option value="roundabout">roundabout — the server also sends a delivery to every ready moon</option>
                {(snapshot.rung === "highways" || snapshot.rung === "autopilot") && (
                  <option value={snapshot.rung} disabled>{snapshot.rung}</option>
                )}
              </select>
            </label>
            <span>
              in flight {snapshot.limits.in_flight}/{snapshot.limits.max_concurrent_ships}
            </span>
            {confirming && (
              <span className="rung-confirmation">
                <span>
                  Raising to roundabout sends {readyToSend}{readyToSend === 1 ? " delivery now." : " deliveries now."}
                </span>
                <button className="btn" type="button" disabled={command.busy} onClick={() => void raise()}>Raise</button>
                <button className="btn" type="button" disabled={command.busy} onClick={() => {
                  command.clear();
                  setConfirming(false);
                  setPending(null);
                }}>Cancel</button>
              </span>
            )}
          </div>
          {command.error !== null && <div className="msg-error">{command.error}</div>}
        </>
      )}
    </header>
  );
}
