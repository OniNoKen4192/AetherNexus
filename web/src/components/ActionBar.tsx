import { useEffect, useRef, useState } from "preact/hooks";
import type { Bridge } from "../store";
import type { Action, Row } from "../types";

export function useCommand(b: Bridge): {
  busy: boolean;
  error: string | null;
  send(name: string, body: object): Promise<boolean>;
  clear(): void;
} {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const request = useRef(0);

  useEffect(() => {
    mounted.current = true;
    const current = ++request.current;
    setBusy(false);
    setError(null);
    return () => {
      mounted.current = false;
      if (request.current === current) request.current++;
    };
  }, [b.taskId]);

  const send = async (name: string, body: object): Promise<boolean> => {
    const current = ++request.current;
    setBusy(true);
    setError(null);
    const result = await b.run(name, body);
    if (mounted.current && request.current === current) {
      setBusy(false);
      if (!result.ok) setError(result.message);
    }
    return result.ok;
  };

  return { busy, error, send, clear: () => setError(null) };
}

type MainTreeChange = { appeared: string[]; vanished: string[] };

const stringValue = (value: unknown): string => typeof value === "string" ? value : "";
const numberValue = (value: unknown): number | null => typeof value === "number" ? value : null;

function mainTreeChange(reasoning: unknown): MainTreeChange | null {
  if (typeof reasoning !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(reasoning);
    if (typeof parsed !== "object" || parsed === null) return null;
    const value = parsed as Record<string, unknown>;
    if (!Array.isArray(value["appeared"]) || !value["appeared"].every((path) => typeof path === "string")) return null;
    if (!Array.isArray(value["vanished"]) || !value["vanished"].every((path) => typeof path === "string")) return null;
    return { appeared: value["appeared"] as string[], vanished: value["vanished"] as string[] };
  } catch {
    return null;
  }
}

function ChangeLists({ change }: { change: MainTreeChange }) {
  return <>
    {change.appeared.length > 0 && <div><div>Appeared</div><ul>{change.appeared.map((path) => <li key={path}>{path}</li>)}</ul></div>}
    {change.vanished.length > 0 && <div><div>Vanished</div><ul>{change.vanished.map((path) => <li key={path}>{path}</li>)}</ul></div>}
  </>;
}

function ErrorMessage({ error }: { error: string | null }) {
  return error === null ? null : <div className="msg-error">{error}</div>;
}

function ProviderAction({ b, action }: { b: Bridge; action: "launch" | "inspect" }) {
  const [provider, setProvider] = useState("");
  const command = useCommand(b);
  const providers = action === "launch" ? b.snapshot?.roles.implement ?? [] : b.snapshot?.roles.review ?? [];
  const label = action === "launch" ? "Launch" : "Inspect";
  const name = action === "launch" ? "moon.launch" : "voyage.inspect";
  return <div className="action-group">
    <select className="field" value={provider} disabled={command.busy} onChange={(event) => setProvider(event.currentTarget.value)}>
      <option value="">default order</option>
      {providers.map((id) => <option value={id} key={id}>{id}</option>)}
    </select>
    <button className="btn" type="button" disabled={command.busy} onClick={() => {
      const body = provider === "" ? { taskId: b.taskId } : { taskId: b.taskId, provider };
      void command.send(name, body);
    }}>{label}</button>
    <ErrorMessage error={command.error} />
  </div>;
}

function DockAction({ b }: { b: Bridge }) {
  const command = useCommand(b);
  return <div className="action-group">
    <button className="btn" type="button" disabled={command.busy} onClick={() => void command.send("voyage.dock", { taskId: b.taskId })}>Dock</button>
    <ErrorMessage error={command.error} />
  </div>;
}

function ReplyAction({ b }: { b: Bridge }) {
  const [note, setNote] = useState("");
  const command = useCommand(b);
  const reply = async () => {
    const value = note.trim();
    if (value !== "" && await command.send("moon.reply", { taskId: b.taskId, note: value })) setNote("");
  };
  return <div className="action-group action-stack">
    <textarea className="field" value={note} disabled={command.busy} onInput={(event) => setNote(event.currentTarget.value)} />
    <button className="btn" type="button" disabled={command.busy || note.trim() === ""} onClick={() => void reply()}>Reply</button>
    <ErrorMessage error={command.error} />
  </div>;
}

function DropAction({ b }: { b: Bridge }) {
  const [open, setOpen] = useState(false);
  const command = useCommand(b);
  return <div className="action-group">
    {!open ? <button className="btn danger" type="button" disabled={command.busy} onClick={() => setOpen(true)}>Drop</button> : <>
      <span>Drop {b.taskId}? This deletes its worktree and branch.</span>
      <button className="btn danger" type="button" disabled={command.busy} onClick={() => void command.send("moon.drop", { taskId: b.taskId })}>Confirm drop</button>
      <button className="btn" type="button" disabled={command.busy} onClick={() => setOpen(false)}>Keep</button>
    </>}
    <ErrorMessage error={command.error} />
  </div>;
}

function ParkAction({ b }: { b: Bridge }) {
  const [reason, setReason] = useState("");
  const command = useCommand(b);
  return <div className="action-group">
    <input className="field" value={reason} disabled={command.busy} onInput={(event) => setReason(event.currentTarget.value)} />
    <button className="btn" type="button" disabled={command.busy || reason.trim() === ""} onClick={() => {
      const value = reason.trim();
      if (value !== "") void command.send("moon.park", { taskId: b.taskId, reason: value });
    }}>Park stale</button>
    <ErrorMessage error={command.error} />
  </div>;
}

function CancelAction({ b }: { b: Bridge }) {
  const command = useCommand(b);
  let voyage: Row | undefined;
  const voyages = b.detail?.voyages ?? [];
  for (let index = voyages.length - 1; index >= 0; index--) {
    const candidate = voyages[index];
    if (candidate && (candidate["status"] === "launched" || candidate["status"] === "working")) {
      voyage = candidate;
      break;
    }
  }
  const voyageId = stringValue(voyage?.["id"]);
  return <div className="action-group">
    <button className="btn" type="button" disabled={command.busy || voyageId === ""} onClick={() => void command.send("voyage.cancel", { voyageId })}>Cancel voyage</button>
    <ErrorMessage error={command.error} />
  </div>;
}

function AnswerAction({ b }: { b: Bridge }) {
  const command = useCommand(b);
  const decision = b.detail?.decisions.find((row) => row["kind"] === "main_tree_changed");
  const decisionId = numberValue(decision?.["id"]);
  const raw = stringValue(decision?.["reasoning"]);
  const change = mainTreeChange(decision?.["reasoning"]);
  return <div className="action-group action-stack">
    <strong>The main tree changed during this voyage.</strong>
    {change === null ? <div>{raw}</div> : <ChangeLists change={change} />}
    <div className="action-buttons">
      <button className="btn" type="button" disabled={command.busy || decisionId === null} onClick={() => decisionId !== null && void command.send("decision.answer", { decisionId, answer: "mine" })}>That was me</button>
      <button className="btn" type="button" disabled={command.busy || decisionId === null} onClick={() => decisionId !== null && void command.send("decision.answer", { decisionId, answer: "not_mine" })}>Not me</button>
    </div>
    <ErrorMessage error={command.error} />
  </div>;
}

function PendingDecision({ decision }: { decision: Row }) {
  const kind = stringValue(decision["kind"]);
  const reasoning = stringValue(decision["reasoning"]);
  const change = kind === "main_tree_changed" ? mainTreeChange(decision["reasoning"]) : null;
  return <div className="pending-decision">
    <span className="badge">{kind}</span>
    {change === null ? <div>{reasoning}</div> : <ChangeLists change={change} />}
  </div>;
}

function ActionControl({ action, b }: { action: Action; b: Bridge }) {
  switch (action) {
    case "launch": return <ProviderAction b={b} action="launch" />;
    case "inspect": return <ProviderAction b={b} action="inspect" />;
    case "dock": return <DockAction b={b} />;
    case "reply": return <ReplyAction b={b} />;
    case "drop": return <DropAction b={b} />;
    case "park_stale": return <ParkAction b={b} />;
    case "cancel": return <CancelAction b={b} />;
    case "answer": return <AnswerAction b={b} />;
  }
}

export function ActionBar({ b }: { b: Bridge }) {
  if (b.detail === null) return null;
  return <div className="action-bar">
    {b.detail.decisions.map((decision, index) => <PendingDecision decision={decision} key={`${String(decision["id"])}-${index}`} />)}
    {b.detail.actions.map((action, index) => <ActionControl action={action} b={b} key={`${b.taskId}-${action}`} />)}
  </div>;
}
