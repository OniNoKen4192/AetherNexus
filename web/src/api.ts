import type { FeedEvent, MoonDetail, Snapshot } from "./types";

export type CommandResult =
  | { ok: true; status: 200 | 202; data: unknown }
  | { ok: false; status: number; message: string; details?: unknown };

/** Thrown for a failed read. status 401 means the cookie is missing; 0 means the server is unreachable. */
export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function getJson<T>(url: string): Promise<T> {
  let res: Response;
  try { res = await fetch(url, { headers: { accept: "application/json" } }); }
  catch (e) { throw new ApiError(0, e instanceof Error ? e.message : String(e)); }
  if (!res.ok) {
    let message = `${url} answered ${res.status}`;
    try { const j = await res.json() as { error?: unknown }; if (typeof j.error === "string") message = j.error; } catch { /* not JSON */ }
    throw new ApiError(res.status, message);
  }
  return await res.json() as T;
}

export function getSnapshot(): Promise<Snapshot> { return getJson<Snapshot>("/api/snapshot"); }
export function getMoon(taskId: string): Promise<MoonDetail> { return getJson<MoonDetail>(`/api/moons/${encodeURIComponent(taskId)}`); }

export async function command(name: string, body: object): Promise<CommandResult> {
  let res: Response;
  try {
    res = await fetch(`/api/commands/${encodeURIComponent(name)}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
  } catch (e) { return { ok: false, status: 0, message: e instanceof Error ? e.message : String(e) }; }
  let json: { result?: unknown; voyageId?: unknown; error?: unknown; details?: unknown } = {};
  try { json = await res.json(); } catch { /* empty or non-JSON body */ }
  if (res.status === 200) return { ok: true, status: 200, data: json.result };
  if (res.status === 202) return { ok: true, status: 202, data: { voyageId: json.voyageId } };
  return {
    ok: false, status: res.status,
    message: typeof json.error === "string" ? json.error : `the server answered ${res.status}`,
    ...(json.details !== undefined ? { details: json.details } : {}),
  };
}

/** Open the server-sent event feed after `since`. EventSource reconnects by itself and resumes via Last-Event-ID. Returns a closer. */
export function openFeed(
  since: number,
  h: { onEvent(e: FeedEvent): void; onServer(): void; onState(s: "live" | "reconnecting"): void },
): () => void {
  const es = new EventSource(`/api/events?since=${since}`);
  es.onopen = () => h.onState("live");
  es.onerror = () => h.onState("reconnecting");
  es.addEventListener("server", () => h.onServer());
  es.onmessage = (m) => {
    try { h.onEvent(JSON.parse(m.data as string) as FeedEvent); } catch { /* ignore a malformed row */ }
  };
  return () => es.close();
}
