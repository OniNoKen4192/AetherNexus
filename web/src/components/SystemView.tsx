import type { Bridge } from "../store";
import { NewSystem } from "./NewSystem";
import { AssignStream, AssignSpec } from "./Assign";

const text = (value: unknown): string => typeof value === "string" ? value : "";

export function SystemView({ b }: { b: Bridge }) {
  const systems = b.snapshot?.systems;
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
                        return (
                          <div className={`row${taskId === b.taskId ? " selected" : ""}`} key={moonId} onClick={() => b.openMoon(taskId)}>
                            <span>{name}</span>
                            <code>{taskId}</code>
                            <span className="badge">{text(moon["status"])}</span>
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
