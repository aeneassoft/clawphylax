// "What has this cost so far?" — token usage and cost from OpenClaw's own
// session transcripts. Works without the plugin's ledger: the transcripts are
// plain JSONL under the state directory, and each assistant message carries a
// usage object. Parsed defensively; unknown shapes count as zero, never as an
// error.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type SessionCost = {
  file: string;
  agent: string;
  sessionId: string;
  messages: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
  currency: string;
  firstTs?: string;
  lastTs?: string;
  models: Record<string, number>;
  toolCalls: number;
};

export type CostReport = {
  stateDir: string;
  windowMinutes: number;
  sessions: SessionCost[];
  totals: { sessions: number; messages: number; totalTokens: number; cost: number; toolCalls: number };
  perToolCall?: number;
  say: string;
};

export function stateDir(): string {
  return process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".openclaw");
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Extract usage fields from one transcript line, tolerant of nesting differences. */
export function usageOf(line: any): { input: number; output: number; total: number; cost: number; model?: string; ts?: number; role?: string; toolCalls: number } | undefined {
  const msg = line?.message && typeof line.message === "object" ? line.message : line;
  const u = msg?.usage ?? line?.usage;
  const role = typeof msg?.role === "string" ? msg.role : undefined;
  const content = Array.isArray(msg?.content) ? msg.content : [];
  const toolCalls = content.filter((c: any) => c && (c.type === "toolCall" || c.type === "tool_use" || c.type === "tool_call")).length;
  const ts = typeof line?.ts === "number" ? line.ts : typeof line?.timestamp === "number" ? line.timestamp : typeof line?.timestamp === "string" ? Date.parse(line.timestamp) : typeof line?.ts === "string" ? Date.parse(line.ts) : undefined;
  if (!u || typeof u !== "object") {
    return role || toolCalls ? { input: 0, output: 0, total: 0, cost: 0, model: msg?.model, ts, role, toolCalls } : undefined;
  }
  const input = num(u.input ?? u.input_tokens ?? u.prompt_tokens);
  const output = num(u.output ?? u.output_tokens ?? u.completion_tokens);
  const total = num(u.totalTokens ?? u.total_tokens) || input + output + num(u.cacheRead) + num(u.cacheWrite);
  const c = u.cost;
  const cost = typeof c === "number" ? c : c && typeof c === "object" ? num(c.total) || num(c.input) + num(c.output) + num(c.cacheRead) + num(c.cacheWrite) : 0;
  return { input, output, total, cost, model: typeof msg?.model === "string" ? msg.model : undefined, ts, role, toolCalls };
}

export function parseTranscript(file: string, sinceTs = 0): SessionCost | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const parts = file.split(/[\\/]/);
  const sessionId = path.basename(file).replace(/\.jsonl$/, "");
  const agentIdx = parts.lastIndexOf("agents");
  const agent = agentIdx >= 0 ? parts[agentIdx + 1] : "unknown";
  const out: SessionCost = { file, agent, sessionId, messages: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0, currency: "USD", models: {}, toolCalls: 0 };
  let first: number | undefined;
  let last: number | undefined;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    let line: any;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    const u = usageOf(line);
    if (!u) continue;
    if (u.ts && u.ts < sinceTs) continue;
    if (u.role === "assistant" || u.total > 0) {
      out.messages++;
    }
    out.inputTokens += u.input;
    out.outputTokens += u.output;
    out.totalTokens += u.total;
    out.cost += u.cost;
    out.toolCalls += u.toolCalls;
    if (u.model) out.models[u.model] = (out.models[u.model] ?? 0) + u.total;
    if (u.ts) {
      first = first === undefined ? u.ts : Math.min(first, u.ts);
      last = last === undefined ? u.ts : Math.max(last, u.ts);
    }
  }
  if (out.messages === 0 && out.totalTokens === 0 && out.toolCalls === 0) {
    return undefined;
  }
  out.firstTs = first ? new Date(first).toISOString() : undefined;
  out.lastTs = last ? new Date(last).toISOString() : undefined;
  return out;
}

export function findTranscripts(root = stateDir()): string[] {
  const files: string[] = [];
  const agentsDir = path.join(root, "agents");
  let agents: string[] = [];
  try {
    agents = fs.readdirSync(agentsDir);
  } catch {
    return files;
  }
  for (const a of agents) {
    const dir = path.join(agentsDir, a, "sessions");
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (f.endsWith(".jsonl") && !f.includes(".trajectory.")) {
        files.push(path.join(dir, f));
      }
    }
  }
  return files;
}

export function costReport(opts: { windowMinutes?: number; root?: string; sessionId?: string } = {}): CostReport {
  const root = opts.root ?? stateDir();
  const windowMinutes = opts.windowMinutes ?? 0;
  const since = windowMinutes ? Date.now() - windowMinutes * 60_000 : 0;
  const sessions = findTranscripts(root)
    .filter((f) => !opts.sessionId || f.includes(opts.sessionId))
    .map((f) => parseTranscript(f, since))
    .filter((s): s is SessionCost => !!s)
    .sort((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens);
  const totals = sessions.reduce(
    (t, s) => ({ sessions: t.sessions + 1, messages: t.messages + s.messages, totalTokens: t.totalTokens + s.totalTokens, cost: t.cost + s.cost, toolCalls: t.toolCalls + s.toolCalls }),
    { sessions: 0, messages: 0, totalTokens: 0, cost: 0, toolCalls: 0 },
  );
  const perToolCall = totals.toolCalls ? totals.cost / totals.toolCalls : undefined;
  const top = sessions[0];
  const say = !sessions.length
    ? `No transcripts with usage found under ${root}. Either nothing ran yet, or the provider does not report usage.`
    : `${totals.sessions} session(s)${windowMinutes ? ` in the last ${windowMinutes} min` : ""}: ${totals.totalTokens.toLocaleString()} tokens, ${totals.cost ? `$${totals.cost.toFixed(4)}` : "cost not reported by provider"}, ${totals.toolCalls} tool calls${perToolCall ? ` (~$${perToolCall.toFixed(4)} per tool call)` : ""}. Most expensive: ${top.agent}/${top.sessionId.slice(0, 8)} with ${top.totalTokens.toLocaleString()} tokens${top.cost ? ` ($${top.cost.toFixed(4)})` : ""}. If a task is still failing after spending this, weigh the next attempt against asking the user.`;
  return { stateDir: root, windowMinutes, sessions: sessions.slice(0, 20), totals, perToolCall, say };
}
