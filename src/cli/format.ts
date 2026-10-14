import type { Row } from "../db/open.js";

/** Fixed-width table: header row, then one row per entry, columns padded to their widest cell. */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
  return [line(headers), ...rows.map(line)].join("\n");
}

const s = (v: unknown): string => (v === null || v === undefined ? "-" : String(v));

export function statusTable(st: { moons: Row[]; voyages: Row[] }, shipName: (id: string) => string): string {
  const rows = st.moons.map((m) => {
    const vs = st.voyages.filter((v) => v["moon_id"] === m["id"]);
    const latest = vs[vs.length - 1];
    return [s(m["task_id"]), s(m["id"]), s(m["status"] ?? m["body_status"]), s(m["round"]), latest ? `${s(latest["status"])} (${shipName(String(latest["ship_id"]))})` : "-"];
  });
  return table(["task", "body", "status", "round", "latest voyage"], rows);
}

export function fleetTable(ships: Row[]): string {
  return table(["name", "class", "fleet", "status", "voyage_count"], ships.map((r) => [s(r["name"]), s(r["class"]), s(r["fleet"]), s(r["status"]), s(r["voyage_count"])]));
}

export function eventsTable(evs: { id: number; ts: string; kind: string; moon_id?: string | null; payload: Record<string, unknown> }[]): string {
  return table(["id", "ts", "kind", "moon", "payload"], evs.map((e) => [String(e.id), e.ts, e.kind, s(e.moon_id), summarize(e.payload)]));
}

function summarize(p: Record<string, unknown>): string {
  const t = JSON.stringify(p);
  return t.length > 60 ? t.slice(0, 57) + "..." : t;
}
