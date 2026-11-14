import type { Bridge } from "../store";

export function Decisions({ b }: { b: Bridge }) {
  const snapshot = b.snapshot;

  return (
    <section className="panel">
      <h2>Decisions</h2>
      {snapshot === null ? (
        <div>Loading</div>
      ) : snapshot.decisions.length === 0 ? (
        <div>No decisions waiting.</div>
      ) : (
        snapshot.decisions.map((decision) => {
          const targetId = String(decision["target_id"]);
          const reasoning = decision["reasoning"];
          return (
            <div
              className={`row${targetId === b.taskId ? " selected" : ""}`}
              key={String(decision["id"])}
              onClick={() => b.openMoon(targetId)}
              title={reasoning === null ? undefined : String(reasoning)}
            >
              <span className="badge">{String(decision["kind"])}</span>
              <span>{targetId}</span>
            </div>
          );
        })
      )}
    </section>
  );
}
