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

/** Problems the Bridge shape has no room for. Components that need them call useBridgeStatus(). */
export type BridgeStatus = { unauthorized: boolean; loadError: string | null; detailError: string | null };

const DEBOUNCE_MS = 150;
/** 1 s, 2 s, 4 s, then every 5 s. */
const backoffMs = (attempt: number): number => (attempt < 3 ? 1000 * 2 ** attempt : 5000);

// Module-level so run() and the loaders can report without a component in scope.
let status: BridgeStatus = { unauthorized: false, loadError: null, detailError: null };
const watchers = new Set<() => void>();
function setStatus(patch: Partial<BridgeStatus>): void {
  const next = { ...status, ...patch };
  if (next.unauthorized === status.unauthorized && next.loadError === status.loadError && next.detailError === status.detailError) return;
  status = next;
  watchers.forEach((w) => w());
}
/** A 401 means the cookie is missing (for instance the server restarted with a new token). */
const setUnauthorized = (): void => setStatus({ unauthorized: true });
const is401 = (e: unknown): boolean => e instanceof ApiError && e.status === 401;
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function useBridgeStatus(): BridgeStatus {
  const [, bump] = useState(0);
  useEffect(() => { const w = () => bump((n) => n + 1); watchers.add(w); return () => { watchers.delete(w); }; }, []);
  return status;
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
  const [conn, setConnState] = useState<Bridge["conn"]>("loading");
  const [systemId, setSystemId] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MoonDetail | null>(null);
  const [activity, setActivity] = useState<FeedEvent[]>([]);

  const connRef = useRef<Bridge["conn"]>("loading");
  const openTask = useRef<string | null>(null);   // latest taskId, readable from feed callbacks
  const detailSeq = useRef(0);                    // drops answers for a moon that is no longer open
  const snapshotSeq = useRef(0);                  // drops a snapshot older than one already applied
  const detailTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // The one place conn changes, so the ref and the state cannot diverge.
  const setConn = useCallback((next: Bridge["conn"]) => { connRef.current = next; setConnState(next); }, []);

  const loadDetail = useCallback((id: string) => {
    const seq = ++detailSeq.current;
    getMoon(id).then((d) => {
      if (seq !== detailSeq.current || openTask.current !== id) return;
      setDetail(d);
      setStatus({ detailError: null });
      setActivity((have) => mergeActivity(have, d.events.filter(isVoyageEvent)));
    }).catch((e) => {
      if (is401(e)) return setUnauthorized();
      if (seq === detailSeq.current && openTask.current === id) setStatus({ detailError: messageOf(e) });
    });
  }, []);

  const loadDetailSoon = useCallback((id: string) => {
    clearTimeout(detailTimer.current);
    detailTimer.current = setTimeout(() => loadDetail(id), DEBOUNCE_MS);
  }, [loadDetail]);

  /** Fetch and apply a snapshot. Rejects with the failure so the caller decides about retrying. */
  const loadSnapshot = useCallback(async (): Promise<Snapshot> => {
    const seq = ++snapshotSeq.current;
    const s = await getSnapshot();
    if (seq === snapshotSeq.current) {
      setSnapshot(s);
      setStatus({ loadError: null });
      // Default to the first system when none is chosen or the chosen one is gone.
      setSystemId((cur) => (cur !== null && s.systems.some((x) => x["id"] === cur) ? cur : (s.systems[0] ? String(s.systems[0]["id"]) : null)));
    }
    return s;
  }, []);

  useEffect(() => {
    let closeFeed: (() => void) | null = null;
    let snapshotTimer: ReturnType<typeof setTimeout> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    const refreshSoon = (e: FeedEvent | null) => {
      const open = openTask.current;
      if (open !== null && (e === null || e.task_id === open)) {
        loadDetailSoon(open);
        if (e && isVoyageEvent(e)) setActivity((have) => mergeActivity(have, [e]));
      }
      clearTimeout(snapshotTimer);
      snapshotTimer = setTimeout(() => {
        loadSnapshot().catch((err) => { if (is401(err)) setUnauthorized(); else setStatus({ loadError: messageOf(err) }); });
      }, DEBOUNCE_MS);
    };

    const startFeed = (cursor: number) => {
      closeFeed?.();
      closeFeed = openFeed(cursor, {
        onEvent: (e) => refreshSoon(e),
        onServer: () => refreshSoon(null),
        onState: (state) => {
          const was = connRef.current;
          setConn(state);
          if (state === "live" && was === "reconnecting") refreshSoon(null);   // catch up after a drop
        },
        // The browser will not retry a closed EventSource (401 after a restart, 503 during shutdown): probe and reopen ourselves.
        onClosed: () => { closeFeed = null; setConn("reconnecting"); connect(0); },
      });
    };

    // First load and recovery of a closed feed: fetch a snapshot, then open the feed at its cursor; back off while it fails.
    const connect = (attempt: number) => {
      loadSnapshot().then((s) => {
        if (disposed) return;
        startFeed(s.cursor);
        const open = openTask.current;
        if (open !== null) loadDetailSoon(open);
      }, (err) => {
        if (disposed) return;
        if (is401(err)) return setUnauthorized();
        setStatus({ loadError: messageOf(err) });
        setConn("reconnecting");
        retryTimer = setTimeout(() => connect(attempt + 1), backoffMs(attempt));
      });
    };
    connect(0);

    return () => {
      disposed = true;
      clearTimeout(snapshotTimer); clearTimeout(retryTimer); clearTimeout(detailTimer.current);
      closeFeed?.();
    };
  }, [loadSnapshot, loadDetailSoon, setConn]);

  const selectSystem = useCallback((id: string) => setSystemId(id), []);
  const openMoon = useCallback((id: string | null) => {
    openTask.current = id;
    detailSeq.current++;
    clearTimeout(detailTimer.current);
    setTaskId(id); setDetail(null); setActivity([]);
    setStatus({ detailError: null });
    if (id !== null) loadDetail(id);
  }, [loadDetail]);
  const run = useCallback(async (name: string, body: object) => {
    const r = await command(name, body);
    if (!r.ok && r.status === 401) setUnauthorized();
    return r;
  }, []);

  return useMemo(
    () => ({ snapshot, conn, systemId, taskId, detail, activity, selectSystem, openMoon, run }),
    [snapshot, conn, systemId, taskId, detail, activity, selectSystem, openMoon, run],
  );
}
