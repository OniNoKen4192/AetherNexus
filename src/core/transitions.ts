export type MoonStatus = "emitted" | "gated" | "implementing" | "audited" | "reviewing" | "merged" | "adrift" | "quarantined" | "dropped";
export type VoyageStatus = "launched" | "working" | "holding" | "cleared" | "en_route" | "docked" | "superseded" | "adrift" | "quarantined";

export class TransitionRefused extends Error {
  constructor(public entity: "moon" | "voyage", public id: string, public from: string, public event: string) {
    super(`${entity} ${id} is '${from}'; '${event}' is not allowed from there`);
  }
}

// Keys are event kinds, qualified as `kind:role` / `kind:verdict` where the payload decides the arrow.
export const MOON_TRANSITIONS: Record<string, Partial<Record<MoonStatus | "barren", MoonStatus>>> = {
  "moon.assigned": { barren: "emitted" },
  "moon.gated": { emitted: "gated", gated: "gated", adrift: "gated", quarantined: "gated", audited: "gated" },
  "moon.gate_failed": { emitted: "adrift" },
  "voyage.launched:implement": { gated: "implementing" },
  "voyage.audited": { implementing: "audited" },
  "voyage.launched:review": { audited: "reviewing" },
  "verdict.issued:APPROVE": { reviewing: "reviewing" },
  "verdict.issued:FIX": { reviewing: "audited" },
  "verdict.issued:REJECT": { reviewing: "quarantined" },
  "moon.merged": { reviewing: "merged" },
  "moon.adrift": { implementing: "adrift", audited: "adrift", reviewing: "adrift" },
  "moon.dropped": { adrift: "dropped", quarantined: "dropped" },
};

export const VOYAGE_TRANSITIONS: Record<string, Partial<Record<VoyageStatus, VoyageStatus>>> = {
  // holding/cleared/en_route: the dock's git commands are logged on the freighter voyage without changing its status
  "voyage.event": { launched: "working", working: "working", holding: "holding", cleared: "cleared", en_route: "en_route" },
  "voyage.returned:implement": { launched: "holding", working: "holding" },
  "voyage.returned:review": { launched: "docked", working: "docked" },
  "voyage.cleared": { holding: "cleared" },
  "voyage.departed": { cleared: "en_route" },
  "voyage.docked": { en_route: "docked" },
  "voyage.superseded": { holding: "superseded", cleared: "superseded", en_route: "superseded", adrift: "superseded", quarantined: "superseded" },
  // cleared -> adrift: the dock's pre-commit checks (re-audit, worktree registration) can still park an approved voyage
  "voyage.adrift": { launched: "adrift", working: "adrift", holding: "adrift", cleared: "adrift", en_route: "adrift" },
  "voyage.quarantined": { holding: "quarantined" },
};

export function nextMoonStatus(from: MoonStatus | "barren", event: string, id: string): MoonStatus {
  const to = MOON_TRANSITIONS[event]?.[from];
  if (!to) throw new TransitionRefused("moon", id, from, event);
  return to;
}
export function nextVoyageStatus(from: VoyageStatus, event: string, id: string): VoyageStatus {
  const to = VOYAGE_TRANSITIONS[event]?.[from];
  if (!to) throw new TransitionRefused("voyage", id, from, event);
  return to;
}
