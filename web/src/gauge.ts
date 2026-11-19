import type { PoolView } from "./types";

export function ageText(ms: number): string {
  const age = Number.isFinite(ms) && ms >= 0 ? ms : 0;
  if (age < 60_000) return `${Math.floor(age / 1_000)}s`;
  if (age < 3_600_000) return `${Math.floor(age / 60_000)}m`;
  if (age < 172_800_000) return `${Math.floor(age / 3_600_000)}h`;
  return `${Math.floor(age / 86_400_000)}d`;
}

export function timeText(iso: string, nowMs: number): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  const now = new Date(nowMs);
  const sameDay = Number.isFinite(now.getTime())
    && date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  if (sameDay) return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function percent(value: number | undefined): number {
  return Math.round((Number.isFinite(value) ? value as number : 0) * 100);
}

export function gaugeText(pool: PoolView, nowMs: number): string {
  const floor = percent(pool.reserve_floor);
  if (pool.state === "dry") return pool.until ? `dry until ${timeText(pool.until, nowMs)}` : "dry";
  if (pool.state === "unknown") return `unknown · floor ${floor}%`;
  if (pool.state === "free") return "free";

  const segments = [`${percent(pool.remaining)}% left`];
  if (pool.resets_at) segments.push(`resets ${timeText(pool.resets_at, nowMs)}`);
  if (pool.reading_ts) {
    const readingMs = Date.parse(pool.reading_ts);
    if (Number.isFinite(readingMs)) segments.push(`read ${ageText(nowMs - readingMs)} ago`);
  }
  segments.push(`floor ${floor}%`);
  if (pool.state === "low") segments.push("below floor");
  return segments.join(" · ");
}

export function familyLines(pool: PoolView): string[] {
  return (pool.windows ?? [])
    .filter((window) => Boolean(window.model_family))
    .map((window) => {
      const used = Number.isFinite(window.used) ? Math.max(0, Math.min(1, window.used)) : 0;
      return `${window.model_family}: ${Math.round((1 - used) * 100)}% left`;
    });
}

export function meterValue(pool: PoolView): number | null {
  if (pool.state === "unknown" || pool.state === "free") return null;
  if (pool.state === "dry") return 0;
  const remaining = Number.isFinite(pool.remaining) ? pool.remaining as number : 0;
  return Math.max(0, Math.min(1, remaining));
}
