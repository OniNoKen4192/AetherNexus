import type { Bridge } from "../store";

export function SystemView({ b }: { b: Bridge }) {
  void b;
  return <div className="panel">SystemView</div>;
}
