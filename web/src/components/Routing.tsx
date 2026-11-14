import type { Bridge } from "../store";
import { useCommand } from "./ActionBar";

function RoleOrder({ b, role, providers }: { b: Bridge; role: "implement" | "review"; providers: string[] }) {
  const command = useCommand(b);
  const move = (index: number, offset: -1 | 1) => {
    const order = [...providers];
    const other = index + offset;
    [order[index], order[other]] = [order[other]!, order[index]!];
    void command.send("config.roles", { role, order });
  };

  return <div className="routing-list">
    <ol>
      {providers.map((provider, index) => <li key={provider}>
        <span>{provider}</span>
        <span className="routing-buttons">
          <button className="btn" type="button" aria-label={`Move ${provider} up`} disabled={command.busy || index === 0} onClick={() => move(index, -1)}>Up</button>
          <button className="btn" type="button" aria-label={`Move ${provider} down`} disabled={command.busy || index === providers.length - 1} onClick={() => move(index, 1)}>Down</button>
        </span>
      </li>)}
    </ol>
    {command.error !== null && <div className="msg-error">{command.error}</div>}
  </div>;
}

export function Routing({ b }: { b: Bridge }) {
  const snapshot = b.snapshot;

  return (
    <section className="panel routing">
      <h2>Routing</h2>
      {snapshot === null ? (
        <div>Loading</div>
      ) : (
        <>
          <h3>Implement order</h3>
          <RoleOrder b={b} role="implement" providers={snapshot.roles.implement} />
          <h3>Review order</h3>
          <RoleOrder b={b} role="review" providers={snapshot.roles.review} />
        </>
      )}
    </section>
  );
}
