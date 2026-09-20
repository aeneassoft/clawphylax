// Attribution context: which tool calls are open right now.
//
// The host runs before_tool_call, then executes the tool, then after_tool_call.
// Execution does not happen inside the hook's async context, so
// AsyncLocalStorage cannot carry the tool call id into the request. We
// therefore attribute temporally: any in-process request made while exactly
// one tool call is open belongs to it. If several are open (parallel tool
// execution), we attach the most recent one and flag ambiguity in the ledger
// through the skillConfidence/toolName fields being best-effort.

import type { Attribution } from "./types.js";

export type OpenCall = Attribution & { startedAt: number };

const open = new Map<string, OpenCall>();
let counter = 0;

export function openToolCall(call: Omit<OpenCall, "startedAt">): string {
  const id = call.toolCallId ?? `anon-${++counter}`;
  open.set(id, { ...call, toolCallId: id, startedAt: Date.now() });
  return id;
}

export function closeToolCall(toolCallId: string | undefined): OpenCall | undefined {
  if (!toolCallId) {
    return undefined;
  }
  const c = open.get(toolCallId);
  open.delete(toolCallId);
  return c;
}

export function currentAttribution(): Attribution & { ambiguous: boolean } {
  if (open.size === 0) {
    return { ambiguous: false };
  }
  let latest: OpenCall | undefined;
  for (const c of open.values()) {
    if (!latest || c.startedAt > latest.startedAt) {
      latest = c;
    }
  }
  const { startedAt: _s, ...attr } = latest as OpenCall;
  return { ...attr, ambiguous: open.size > 1 };
}

export function openCount(): number {
  return open.size;
}

/** Test/maintenance helper: drop calls that never closed (host crash, timeout). */
export function sweepStale(maxAgeMs = 30 * 60_000): number {
  const now = Date.now();
  let n = 0;
  for (const [id, c] of open) {
    if (now - c.startedAt > maxAgeMs) {
      open.delete(id);
      n++;
    }
  }
  return n;
}

export function resetForTests(): void {
  open.clear();
  counter = 0;
}
