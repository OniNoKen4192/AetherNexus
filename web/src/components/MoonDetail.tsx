import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { useBridgeStatus, type Bridge } from "../store";
import type { FeedEvent } from "../types";
import { ActionBar } from "./ActionBar";

type Tab = "Spec" | "Activity" | "Audit" | "Verdicts";

const text = (value: unknown): string => typeof value === "string" ? value : "";
const number = (value: unknown): number => typeof value === "number" ? value : 0;
const strings = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
  : [];

function mergeEvents(detailEvents: FeedEvent[], activity: FeedEvent[]): FeedEvent[] {
  const byId = new Map<number, FeedEvent>();
  for (const event of detailEvents) byId.set(event.id, event);
  for (const event of activity) byId.set(event.id, event);
  return [...byId.values()].sort((left, right) => left.id - right.id);
}

function eventLine(event: FeedEvent): string {
  if (event.kind === "voyage.event") {
    const nested = event.payload["event"];
    if (typeof nested === "object" && nested !== null) {
      const value = nested as Record<string, unknown>;
      return `${event.ts} ${text(value["kind"])} ${JSON.stringify(value["data"])}`;
    }
  }
  return `${event.ts} ${event.kind} ${JSON.stringify(event.payload)}`;
}

export function MoonDetail({ b }: { b: Bridge }) {
  const { detailError } = useBridgeStatus();
  const [tab, setTab] = useState<Tab>("Spec");
  const activityLog = useRef<HTMLPreElement>(null);
  const followBottom = useRef(true);

  useEffect(() => {
    setTab("Spec");
    followBottom.current = true;
  }, [b.taskId]);

  const events = b.detail ? mergeEvents(b.detail.events, b.activity) : [];
  useLayoutEffect(() => { if (activityLog.current === null) followBottom.current = true; });
  useLayoutEffect(() => {
    const log = activityLog.current;
    if (log && followBottom.current) log.scrollTop = log.scrollHeight;
  });

  if (b.taskId === null) return null;

  const close = <button className="btn" type="button" onClick={() => b.openMoon(null)}>Close</button>;
  const failures = (b.snapshot?.failures ?? []).filter((failure) => failure.taskId === b.taskId).slice().reverse();
  let audit: unknown;
  let hasAudit = false;
  for (const event of events) {
    if (event.kind === "voyage.audited") {
      audit = event.payload["audit"];
      hasAudit = true;
    }
  }

  return (
    <section className="panel moon-detail">
      <div className="moon-detail-bar"><h2>Moon</h2>{close}</div>
      {failures.map((failure, index) => <div className="msg-error" key={`${failure.ts}-${failure.voyageId ?? ""}-${index}`}>{failure.ts} {failure.message}</div>)}
      {detailError !== null && <div className="msg-error">{detailError}</div>}
      {b.detail === null && detailError === null && <div>Loading</div>}
      {b.detail !== null && (() => {
        const moon = b.detail.moon;
        const waitingOn = strings(moon["waiting_on"]);
        const waitingOnPlanets = strings(moon["waiting_on_planets"]);
        return <>
          <div className="moon-detail-heading">
            <strong>{text(moon["name"])}</strong><code>{b.taskId}</code>
            <span className="badge">{text(moon["status"])}</span><span>round {number(moon["round"])}</span>
          </div>
          {waitingOn.length > 0 && <div className="badge waiting-label">waiting on {waitingOn.join(", ")}</div>}
          {waitingOnPlanets.length > 0 && <div className="badge waiting-label">waiting on planet {waitingOnPlanets.join(", ")}</div>}
          {moon["park_reason"] !== null && <div className="moon-park-reason">{text(moon["park_reason"])}</div>}
          <ActionBar b={b} />
          <div className="tabs">
            <button className={`tab${tab === "Spec" ? " active" : ""}`} type="button" onClick={() => setTab("Spec")}>Spec</button>
            <button className={`tab${tab === "Activity" ? " active" : ""}`} type="button" onClick={() => { followBottom.current = true; setTab("Activity"); }}>Activity</button>
            <button className={`tab${tab === "Audit" ? " active" : ""}`} type="button" onClick={() => setTab("Audit")}>Audit</button>
            <button className={`tab${tab === "Verdicts" ? " active" : ""}`} type="button" onClick={() => setTab("Verdicts")}>Verdicts</button>
          </div>
          {tab === "Spec" && (b.detail.spec === null ? <div>No spec file.</div> : <pre className="log">{b.detail.spec}</pre>)}
          {tab === "Activity" && (events.length === 0 ? <div>No activity yet.</div> : (
            <pre className="log" ref={activityLog} onScroll={(event) => {
              const log = event.currentTarget;
              followBottom.current = log.scrollHeight - log.scrollTop - log.clientHeight <= 24;
            }}>{events.map(eventLine).join("\n")}</pre>
          ))}
          {tab === "Audit" && (!hasAudit ? <div>No audit yet.</div> : <pre className="log">{JSON.stringify(audit, null, 2)}</pre>)}
          {tab === "Verdicts" && (b.detail.verdicts.length === 0 ? <div>No verdicts yet.</div> : (
            <div className="moon-verdicts">
              {b.detail.verdicts.map((verdict) => (
                <div className="moon-verdict" key={number(verdict["id"])}>
                  <div className="moon-verdict-heading"><span>round {number(verdict["round"])}</span><span className="badge">{text(verdict["verdict"])}</span></div>
                  <div>{text(verdict["reasoning"])}</div>
                  {verdict["delta_spec"] !== null && <pre className="log">{text(verdict["delta_spec"])}</pre>}
                </div>
              ))}
            </div>
          ))}
        </>;
      })()}
    </section>
  );
}
