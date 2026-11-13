import type { Bridge } from "../store";

export function Decisions({ b }: { b: Bridge }) {
  void b;
  return <div className="panel">Decisions</div>;
}
