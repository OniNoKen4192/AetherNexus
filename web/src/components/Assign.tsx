import { useState } from "preact/hooks";
import type { Bridge } from "../store";
import { useCommand } from "./ActionBar";

export function AssignStream({ b, systemId, planetName }: { b: Bridge; systemId: string; planetName: string }) {
  const [open, setOpen] = useState(false);
  const [streamId, setStreamId] = useState("");
  const [mission, setMission] = useState("");
  const [territoryText, setTerritoryText] = useState("");
  const command = useCommand(b);
  const territory = territoryText.split("\n").map((line) => line.trim()).filter((line) => line !== "");

  const cancel = () => {
    command.clear();
    setOpen(false);
  };
  const assign = async () => {
    const stream = streamId.trim();
    const purpose = mission.trim();
    if (stream === "" || purpose === "" || territory.length === 0) return;
    if (await command.send("planet.assign", { systemId, streamId: stream, mission: purpose, territory, planetName })) setOpen(false);
  };

  if (!open) return <button className="btn" type="button" onClick={() => setOpen(true)}>Assign stream</button>;
  return (
    <form className="assignment-form" onSubmit={(event) => { event.preventDefault(); void assign(); }}>
      <label>stream id<input className="field" value={streamId} disabled={command.busy} onInput={(event) => setStreamId(event.currentTarget.value)} /></label>
      <label>mission<input className="field" value={mission} disabled={command.busy} onInput={(event) => setMission(event.currentTarget.value)} /></label>
      <label>territory<textarea className="field" value={territoryText} disabled={command.busy} onInput={(event) => setTerritoryText(event.currentTarget.value)} /></label>
      <div className="assignment-buttons">
        <button className="btn" type="submit" disabled={command.busy || streamId.trim() === "" || mission.trim() === "" || territory.length === 0}>Assign</button>
        <button className="btn" type="button" disabled={command.busy} onClick={cancel}>Cancel</button>
      </div>
      {command.error !== null && <div className="msg-error">{command.error}</div>}
    </form>
  );
}

export function AssignSpec({ b, planetId, moonName }: { b: Bridge; planetId: string; moonName: string }) {
  const [open, setOpen] = useState(false);
  const [specPath, setSpecPath] = useState("");
  const command = useCommand(b);
  const specs = b.snapshot?.specs ?? [];
  const chosen = specs.find((spec) => spec.path === specPath && spec.error === null);

  const cancel = () => {
    command.clear();
    setOpen(false);
  };
  const assign = async () => {
    if (chosen && await command.send("moon.assign", { planetId, specPath: chosen.path, moonName })) setOpen(false);
  };

  if (!open) return <button className="btn" type="button" onClick={() => setOpen(true)}>Assign spec</button>;
  return (
    <form className="assignment-form" onSubmit={(event) => { event.preventDefault(); void assign(); }}>
      {specs.length === 0 ? <div>No unassigned specs.</div> : (
        <select className="field" value={specPath} disabled={command.busy} onChange={(event) => setSpecPath(event.currentTarget.value)}>
          <option value="" disabled>Choose a spec</option>
          {specs.map((spec) => <option key={spec.path} value={spec.path} disabled={spec.error !== null}>
            {spec.error === null ? `${spec.taskId} — ${spec.path}` : `${spec.path} — ${spec.error}`}
          </option>)}
        </select>
      )}
      <div className="assignment-buttons">
        <button className="btn" type="submit" disabled={command.busy || chosen === undefined}>Assign</button>
        <button className="btn" type="button" disabled={command.busy} onClick={cancel}>Cancel</button>
      </div>
      {command.error !== null && <div className="msg-error">{command.error}</div>}
    </form>
  );
}
