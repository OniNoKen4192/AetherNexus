import type { Bridge } from "../store";
import { timeText } from "../gauge";
import { asFuelWait, fuelWaitText, needsAttention, parkReasonText, refuelledText, statusText } from "../labels";
import { asCargo, asVoyageShip, voyageSentence } from "../ships";
import { NewSystem } from "./NewSystem";
import { AssignStream, AssignSpec } from "./Assign";

const text = (value: unknown): string => typeof value === "string" ? value : "";
const strings = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
  : [];

export function SystemView({ b }: { b: Bridge }) {
  const systems = b.snapshot?.systems;
  const failures = b.snapshot?.failures ?? [];
  const selected = systems?.find((system) => text(system["id"]) === b.systemId);

  return (
    <section className="panel system-view">
      <h2>System</h2>
      {systems !== undefined && <NewSystem b={b} />}
      {systems === undefined ? <div>Loading</div> : systems.length === 0 ? <div>No systems yet.</div> : (
        <>
          <select className="field" value={b.systemId ?? ""} onChange={(event) => b.selectSystem(event.currentTarget.value)}>
            {systems.map((system) => {
              const id = text(system["id"]);
              const title = system["title"];
              return <option key={id} value={id}>{typeof title === "string" ? title : id}</option>;
            })}
          </select>
          {selected && (
            <div className="system-planets">
              {selected.planets.map((planet) => {
                const planetId = text(planet["id"]);
                const planetName = text(planet["name"]);
                return (
                  <div className="system-planet" key={planetId}>
                    <h3>{planetName}{planet["body_status"] === "barren" && <span className="system-barren">barren</span>}</h3>
                    {planet["body_status"] === "barren" && <AssignStream b={b} systemId={text(selected["id"])} planetName={planetName} />}
                    <div className="system-moons">
                      {planet.moons.map((moon) => {
                        const moonId = text(moon["id"]);
                        const name = text(moon["name"]);
                        const taskId = typeof moon["task_id"] === "string" ? moon["task_id"] : null;
                        if (taskId === null) {
                          return <div className="system-barren-moon" key={moonId}><span>{name}</span>{moon["body_status"] === "barren" && <span>barren</span>}{moon["body_status"] === "barren" && planet["body_status"] === "assigned" && <AssignSpec b={b} planetId={planetId} moonName={name} />}</div>;
                        }
                        let latestFailure = undefined;
                        for (const failure of failures) {
                          if (failure.taskId === taskId) latestFailure = failure;
                        }
                        const waitingOn = strings(moon["waiting_on"]);
                        const waitingOnPlanets = strings(moon["waiting_on_planets"]);
                        const fuelWait = asFuelWait(moon["waiting_on_fuel"]);
                        const parkReason = text(moon["park_reason"]);
                        const inFlight = (b.snapshot?.voyages ?? [])
                          .filter((voyage) => voyage["assignment_id"] === moon["assignment_id"] && (voyage["status"] === "launched" || voyage["status"] === "working"));
                        const refuelled = inFlight
                          .map(refuelledText)
                          .filter((label): label is string => label !== null);
                        const voyageShips = inFlight
                          .map((voyage) => voyageSentence({ ship: asVoyageShip(voyage["ship"]), cargo: asCargo(voyage["cargo"]) }))
                          .filter((sentence): sentence is string => sentence !== null);
                        return (
                          <div className={`row${taskId === b.taskId ? " selected" : ""}`} key={moonId} onClick={() => b.openMoon(taskId)}>
                            <span>{name}</span>
                            <code>{taskId}</code>
                            <span className="badge">{statusText(text(moon["status"]))}</span>
                            {waitingOn.length > 0 && <span className="badge waiting-label">waiting on {waitingOn.join(", ")}</span>}
                            {waitingOnPlanets.length > 0 && <span className="badge waiting-label">waiting on planet {waitingOnPlanets.join(", ")}</span>}
                            {waitingOn.length === 0 && waitingOnPlanets.length === 0 && fuelWait !== null && <span className="badge waiting-label">{fuelWaitText(fuelWait, (iso) => timeText(iso, Date.now()))}</span>}
                            {refuelled.map((label, index) => <span className="badge waiting-label" key={`${label}-${index}`}>{label}</span>)}
                            {voyageShips.map((sentence, index) => <span className="voyage-ship" key={`${sentence}-${index}`}>{sentence}</span>)}
                            {needsAttention(moon["park_reason"]) && <span className="badge attention-label">{parkReasonText(parkReason)}</span>}
                            {latestFailure !== undefined && <span className="badge failure-badge" title={latestFailure.message}>failed</span>}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </section>
  );
}
