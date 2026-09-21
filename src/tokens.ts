// "Am I using too many tokens?" — and the sharper question behind it:
// am I spending tokens to refute myself, or to put the task into practice?
//
// From OpenClaw's own transcripts, every assistant turn is classified by what
// it *did*:
//   act        — called a tool that changes something (exec, write, message …)
//   gather     — called a tool that reads something (fetch, search, read …)
//   repeat     — called a tool with the same name and arguments as an earlier
//                turn in this session (re-verifying, re-doing)
//   deliberate — produced text only, no tool call
// Output tokens are what the model generated; they are attributed to the
// turn's class. The verdict is about allocation, not about volume: a long
// task may legitimately cost a lot, but tokens that neither act nor gather
// nor conclude are the ones that distort a good first idea.

import fs from "node:fs";
import { findTranscripts, stateDir, usageOf } from "./cost.js";

const GATHER = new Set(["web_search", "web_fetch", "x_search", "read", "memory_search", "memory_get", "sessions_history", "sessions_search", "browser", "session_status", "clawphylax_report", "clawphylax_hosts", "clawphylax_outlook", "clawphylax_failures", "clawphylax_stop_or_continue", "clawphylax_circles", "clawphylax_exploration", "clawphylax_others", "clawphylax_what_worked", "clawphylax_cost", "clawphylax_which_path", "clawphylax_token_use"]);

export type TurnClass = "act" | "gather" | "repeat" | "deliberate";

export type TokenUse = {
  sessionId: string;
  agent: string;
  turns: number;
  outputTokens: number;
  inputTokens: number;
  byClass: Record<TurnClass, { turns: number; outputTokens: number; share: number }>;
  longestDeliberationStreak: number;
  outputPerTurnFirstHalf: number;
  outputPerTurnSecondHalf: number;
  repeatedCalls: Array<{ call: string; times: number }>;
  verdict: "executing" | "deliberating" | "churning" | "too-little-data";
  say: string;
};

function callKey(c: any): string {
  const name = c?.name ?? c?.function?.name ?? "tool";
  let args = c?.arguments ?? c?.input ?? c?.function?.arguments ?? "";
  if (typeof args !== "string") {
    try {
      args = JSON.stringify(args);
    } catch {
      args = String(args);
    }
  }
  return `${name}:${String(args).replace(/\s+/g, " ").slice(0, 160)}`;
}

export function analyseTranscriptText(text: string, opts: { sessionId?: string; agent?: string; sinceTs?: number } = {}): TokenUse {
  const seen = new Map<string, number>();
  const turns: Array<{ cls: TurnClass; out: number; inp: number }> = [];
  let inputTokens = 0;
  let outputTokens = 0;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    let line: any;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    const msg = line?.message && typeof line.message === "object" ? line.message : line;
    if (msg?.role !== "assistant") continue;
    const u = usageOf(line);
    if (u?.ts && opts.sinceTs && u.ts < opts.sinceTs) continue;
    const content = Array.isArray(msg.content) ? msg.content : [];
    const calls = content.filter((c: any) => c && (c.type === "toolCall" || c.type === "tool_use" || c.type === "tool_call"));
    let cls: TurnClass = "deliberate";
    if (calls.length) {
      const keys: string[] = calls.map((c: any) => callKey(c));
      const repeated = keys.filter((k: string) => seen.has(k));
      for (const k of keys) seen.set(k, (seen.get(k) ?? 0) + 1);
      if (repeated.length === keys.length) {
        cls = "repeat";
      } else {
        const names = calls.map((c: any) => c?.name ?? c?.function?.name ?? "");
        cls = names.every((n: string) => GATHER.has(n)) ? "gather" : "act";
      }
    }
    const out = u?.output ?? 0;
    const inp = u?.input ?? 0;
    outputTokens += out;
    inputTokens += inp;
    turns.push({ cls, out, inp });
  }
  const byClass: TokenUse["byClass"] = { act: { turns: 0, outputTokens: 0, share: 0 }, gather: { turns: 0, outputTokens: 0, share: 0 }, repeat: { turns: 0, outputTokens: 0, share: 0 }, deliberate: { turns: 0, outputTokens: 0, share: 0 } };
  for (const t of turns) {
    byClass[t.cls].turns++;
    byClass[t.cls].outputTokens += t.out;
  }
  // When the provider reports no output tokens (local models, mocks), fall back to turn counts.
  const denom = outputTokens || turns.length;
  for (const k of Object.keys(byClass) as TurnClass[]) {
    byClass[k].share = denom ? (outputTokens ? byClass[k].outputTokens : byClass[k].turns) / denom : 0;
  }
  let streak = 0;
  let longest = 0;
  for (const t of turns) {
    streak = t.cls === "deliberate" ? streak + 1 : 0;
    longest = Math.max(longest, streak);
  }
  const half = Math.floor(turns.length / 2);
  const avg = (xs: typeof turns) => (xs.length ? xs.reduce((s, t) => s + t.out, 0) / xs.length : 0);
  const repeatedCalls = [...seen.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([call, times]) => ({ call, times }));

  let verdict: TokenUse["verdict"] = "executing";
  if (turns.length < 4) {
    verdict = "too-little-data";
  } else if (byClass.repeat.share >= 0.3) {
    verdict = "churning";
  } else if (byClass.deliberate.share >= 0.4 || longest >= 3) {
    verdict = "deliberating";
  }
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const say =
    verdict === "too-little-data"
      ? `Only ${turns.length} assistant turns so far; nothing to judge yet.`
      : verdict === "churning"
        ? `${pct(byClass.repeat.share)} of your output went into re-running calls you had already made (${repeatedCalls
            .slice(0, 2)
            .map((r) => `"${r.call.slice(0, 50)}" ×${r.times}`)
            .join(", ")}). Identical calls give identical answers; that is verification of a result you already had, not progress. Take the result as settled and build on it.`
        : verdict === "deliberating"
          ? `${pct(byClass.deliberate.share)} of your output tokens were text with no tool call (longest run: ${longest} turns in a row), against ${pct(byClass.act.share)} acting and ${pct(byClass.gather.share)} gathering. You are arguing with yourself instead of testing. Pick the plan you had before the deliberation started and run its first step; let the result, not another paragraph, decide.`
          : `Executing: ${pct(byClass.act.share)} acting, ${pct(byClass.gather.share)} gathering, ${pct(byClass.deliberate.share)} deliberating, ${pct(byClass.repeat.share)} repeats over ${turns.length} turns. Output per turn ${Math.round(avg(turns.slice(0, half)))} → ${Math.round(avg(turns.slice(half)))} tokens.`;
  return {
    sessionId: opts.sessionId ?? "",
    agent: opts.agent ?? "",
    turns: turns.length,
    outputTokens,
    inputTokens,
    byClass,
    longestDeliberationStreak: longest,
    outputPerTurnFirstHalf: avg(turns.slice(0, half)),
    outputPerTurnSecondHalf: avg(turns.slice(half)),
    repeatedCalls,
    verdict,
    say,
  };
}

export function tokenUse(opts: { sessionId?: string; windowMinutes?: number; root?: string } = {}): TokenUse | undefined {
  const root = opts.root ?? stateDir();
  const files = findTranscripts(root).filter((f) => !opts.sessionId || f.includes(opts.sessionId));
  if (!files.length) {
    return undefined;
  }
  // Most recently modified transcript = the current conversation, unless a session id was given.
  const file = files.map((f) => ({ f, m: fs.statSync(f).mtimeMs })).sort((a, b) => b.m - a.m)[0].f;
  const parts = file.split(/[\\/]/);
  const agentIdx = parts.lastIndexOf("agents");
  return analyseTranscriptText(fs.readFileSync(file, "utf8"), {
    sessionId: parts[parts.length - 1].replace(/\.jsonl$/, ""),
    agent: agentIdx >= 0 ? parts[agentIdx + 1] : "unknown",
    sinceTs: opts.windowMinutes ? Date.now() - opts.windowMinutes * 60_000 : undefined,
  });
}

export function renderTokenUse(t: TokenUse | undefined): string {
  if (!t) {
    return "No transcripts found; nothing ran yet or the state directory is elsewhere (OPENCLAW_STATE_DIR).";
  }
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  return [
    `${t.verdict.toUpperCase()} — ${t.agent}/${t.sessionId.slice(0, 8)}, ${t.turns} assistant turns, ${t.outputTokens.toLocaleString()} output tokens`,
    t.say,
    `act ${pct(t.byClass.act.share)} · gather ${pct(t.byClass.gather.share)} · deliberate ${pct(t.byClass.deliberate.share)} · repeat ${pct(t.byClass.repeat.share)} · longest deliberation streak ${t.longestDeliberationStreak}`,
    t.repeatedCalls.length ? `repeated calls: ${t.repeatedCalls.map((r) => `${r.call.slice(0, 60)} ×${r.times}`).join(" | ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
