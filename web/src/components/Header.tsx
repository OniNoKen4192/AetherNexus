import type { Bridge } from "../store";

export function Header({ b }: { b: Bridge }) {
  void b;
  return <div className="panel">Header</div>;
}
