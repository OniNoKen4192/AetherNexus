import type { Bridge } from "../store";

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
          <ol>
            {snapshot.roles.implement.map((provider) => (
              <li key={provider}>{provider}</li>
            ))}
          </ol>
          <h3>Review order</h3>
          <ol>
            {snapshot.roles.review.map((provider) => (
              <li key={provider}>{provider}</li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
