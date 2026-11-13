import type { Bridge } from "../store";

export function Routing({ b }: { b: Bridge }) {
  void b;
  return <div className="panel">Routing</div>;
}
