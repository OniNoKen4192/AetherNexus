import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { ApiError, command, getMoon, getSnapshot, openFeed, type CommandResult } from "./api";
import type { FeedEvent, MoonDetail, Snapshot } from "./types";

export type { CommandResult };

/** What every component reads. The page computes no state: it holds the server's last answers. */
export type Bridge = {
  snapshot: Snapshot | null; conn: "loading" | "live" | "reconnecting";
  systemId: string | null; taskId: string | null;
  detail: MoonDetail | null; activity: FeedEvent[];      // activity: voyage.event rows of the open moon, oldest first
  selectSystem(id: string): void; openMoon(taskId: string | null): void;
  run(name: string, body: object): Promise<CommandResult>;   // command(); no optimistic update
};

const DEBOUNCE_MS = 150;

// A 401 means the cookie is missing. Kept outside Bridge (whose shape is fixed) so App can show one plain message.
let unauthorized = false;
const watchers = new Set<() => void>();
function setUnauthorized(): void { if (!unauthorized) { unauthorized = true; watchers.forEach((w) => w()); } }
export function useUnauthorized(): boolean {
  const [, bump] = useState(0);
  useEffect(() => { const w = () => bump((n) => n + 1); watchers.add(w); return () => { watchers.delete(w); }; }, []);
  return unauthorized;
}

const isVoyageEvent = (e: FeedEvent): boolean => e.kind === "voyage.event";

/** Union by id, oldest first. */
function mergeActivity(have: FeedEvent[], more: FeedEvent[]): FeedEvent[] {
  const byId = new Map<number, FeedEvent>();
  for (const e of have) byId.set(e.id, e);
  for (const e of more) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

export function useBridge(): Bridge {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [conn, setConn] = useState<Bridge["conn"]>("loading");
  const [systemId, setSystemId] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MoonDetail | null>(null);
  const [activity, setActivity] = useState<FeedEvent[]>([]);

  const connRef = useRef<Bridge["conn"]>("loading");
  const openTask = useRef<string | null>(null);   // latest taskId, readable from feed callbacks
  const detailSeq = useRef(0);                    // drops answers for a moon that is no longer open
  const snapshotSeq = useRef(0);                  // drops a snapshot older than one already applied

  const loadDetail = useCallback((id: string) => {
    const seq = ++detailSeq.current;
    getMoon(id).then((d) => {
      if (seq !== detailSeq.current || openTask.current !== id) return;
      setDetail(d);
      setActivity((have) => mergeActivity(have, d.events.filter(isVoyageEvent)));
    }).catch((e) => { if (e instanceof ApiError && e.status === 401) setUnauthorized(); });
  }, []);

  const loadSnapshot = useCallback((): Promise<Snapshot | null> => {
    const seq = ++snapshotSeq.current;
    return getSnapshot().then((s) => {
      if (seq !== snapshotSeq.current) return null;
      setSnapshot(s);
      // Default to the first system when none is chosen or the chosen one is gone.
      setSystemId((cur) => (cur !== null && s.systems.some((x) => x["id"] === cur) ? cur : (s.systems[0] ? String(s.systems[0]["id"]) : null)));
      return s;
    }).catch((e) => {
      if (e instanceof ApiError && e.status === 401) setUnauthorized();
      else if (e instanceof ApiError && e.status === 0) setConn("reconnecting");
      return null;
    });
  }, []);

  useEffect(() => {
    let closeFeed: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    const refreshSoon = (e: FeedEvent | null) => {
      const open = openTask.current;
      if (open !== null && (e === null || e.task_id === open)) {
        loadDetail(open);
        if (e && isVoyageEvent(e)) setActivity((have) => mergeActivity(have, [e]));
      }
      clearTimeout(timer);
      timer = setTimeout(() => { void loadSnapshot(); }, DEBOUNCE_MS);
    };

    void loadSnapshot().then((s) => {
      if (disposed || !s) return;
      closeFeed = openFeed(s.cursor, {
        onEvent: (e) => refreshSoon(e),
        onServer: () => refreshSoon(null),
        onState: (state) => {
          const was = connRef.current;
          connRef.current = state;
          setConn(state);
          if (state === "live" && was === "reconnecting") refreshSoon(null);   // catch up after a drop
        },
      });
    });

    return () => { disposed = true; clearTimeout(timer); closeFeed?.(); };
  }, [loadSnapshot, loadDetail]);

  const selectSystem = useCallback((id: string) => setSystemId(id), []);
  const openMoon = useCallback((id: string | null) => {
    openTask.current = id;
    detailSeq.current++;
    setTaskId(id); setDetail(null); setActivity([]);
    if (id !== null) loadDetail(id);
  }, [loadDetail]);
  const run = useCallback((name: string, body: object) => command(name, body), []);

  return useMemo(
    () => ({ snapshot, conn, systemId, taskId, detail, activity, selectSystem, openMoon, run }),
    [snapshot, conn, systemId, taskId, detail, activity, selectSystem, openMoon, run],
  );
}
