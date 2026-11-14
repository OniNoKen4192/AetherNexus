import { rowToEvent, type EventRow } from "../db/events.js";
import type { NexusDb, Row } from "../db/open.js";

export function followEvents(
  db: NexusDb,
  opts: { since: number; pollMs: number; onEvents: (rows: EventRow[]) => void },
): { cursor(): number; stop(): void } {
  let current = opts.since;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const poll = (): void => {
    if (stopped) return;
    while (!stopped) {
      let rows: EventRow[];
      try {
        rows = db.all<Row>("events.page", { id: current, limit: 500 }).map(rowToEvent);
      } catch (error) {
        console.error(error);
        break;
      }
      if (rows.length === 0) break;
      current = rows[rows.length - 1]!.id;
      try {
        opts.onEvents(rows);
      } catch (error) {
        console.error(error);
      }
      if (rows.length < 500) break;
    }
    if (!stopped) {
      timer = setTimeout(poll, opts.pollMs);
      timer.unref();
    }
  };

  poll();
  return {
    cursor: () => current,
    stop: () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
