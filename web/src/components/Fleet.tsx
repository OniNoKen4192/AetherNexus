import type { Bridge } from "../store";

export function Fleet({ b }: { b: Bridge }) {
  void b;
  return <div className="panel">Fleet</div>;
}
