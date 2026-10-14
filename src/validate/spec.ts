import { createHash } from "node:crypto";

export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export function idError(id: string): string {
  return `ID '${id}' is not a canonical task ID — IDs name state files, branches, and worktrees verbatim and must match [A-Za-z0-9][A-Za-z0-9._-]*`;
}

export type ParsedSpec = {
  taskId: string | undefined; modelHint: string | undefined; gravity: number | undefined;
  dependsOn: string[]; touch: string[];
};

export function specBody(text: string): string {
  return text.split(/^## Amendments[ \t]*$/m)[0]!.replace(/\s+$/, "");
}
export function specAppendix(text: string): string {
  const m = text.match(/^## Amendments[ \t]*$/m);
  return m ? text.slice(m.index) : "";
}
export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
export function hashSpec(text: string): { bodySha: string; appendixSha: string } {
  return { bodySha: sha256(specBody(text)), appendixSha: sha256(specAppendix(text)) };
}

export function parseSpec(text: string): ParsedSpec {
  const body = specBody(text);
  const meta = (re: RegExp) => (body.match(re) || [])[1];
  const taskId = meta(/^\s*-\s+\*\*Task ID\*\*:\s*(\S+)/m);
  const modelHint = meta(/^\s*-\s+\*\*Model hint\*\*:\s*(\S+)/m);
  const gravityRaw = meta(/^\s*-\s+\*\*Gravity\*\*:\s*(\d+)/m);
  const depsRaw = meta(/^\s*-\s+\*\*Depends on\*\*:\s*(.+)$/m) ?? "";
  const dependsOn = depsRaw.trim().toLowerCase() === "none" ? [] :
    depsRaw.split(",").map((s) => s.trim()).filter(Boolean);
  const touchSection = (body.split(/^### Touch\s*$/m)[1] || "").split(/^### /m)[0]!;
  const touch: string[] = [];
  for (const m of touchSection.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)) touch.push(m[1]!);
  return { taskId, modelHint, gravity: gravityRaw ? Number(gravityRaw) : undefined, dependsOn, touch };
}

export function appendAmendment(text: string, e: { round: number; date: string; author: string; note: string }): string {
  const hasSection = /^## Amendments[ \t]*$/m.test(text);
  const base = text.replace(/\s+$/, "") + "\n";
  const head = hasSection ? "" : "\n## Amendments\n";
  // Sequential counter: the next number after existing entries (e.round is accepted but not used for numbering).
  const n = (text.match(/^### A\d+ /gm) ?? []).length + 1;
  return `${base}${head}\n### A${n} — ${e.date} — ${e.author}: ${e.note}\n`;
}
