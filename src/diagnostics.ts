// Diagnostics an agent runs on itself while troubleshooting. Each function
// answers one literal self-question from the local ledger (observed requests
// plus tool outcomes). Same rule as everywhere in this plugin: verdicts rest
// on bounds and counts, never on a single observation, and the output ends
// with the concrete next action.

import { wilsonUpper } from "./baseline.js";
import { classifyHost } from "./classify.js";
import { analyzeExecCommand } from "./exec-parse.js";
import type { Ledger, ToolOutcome } from "./ledger.js";
import { outlookFor, wilsonLower } from "./outlook.js";
import type { EgressEvent, PluginConfig } from "./types.js";

// ---------------------------------------------------------------- helpers

const GATHER_TOOLS = new Set(["web_search", "web_fetch", "x_search", "read", "memory_search", "memory_get", "sessions_history", "sessions_search", "browser", "session_status"]);
const ACT_TOOLS = new Set(["exec", "bash", "write", "edit", "apply_patch", "message", "sessions_send", "conversations_send", "cron", "gateway", "process", "code_execution"]);

function hostOf(o: ToolOutcome): string | undefined {
  const h = o.argHint;
  if (!h) {
    return undefined;
  }
  const m = h.match(/^([a-z0-9.-]+\.[a-z]{2,})(\/|$)/i);
  if (m) {
    return m[1].toLowerCase();
  }
  const cmd = analyzeExecCommand(h);
  return cmd.targets[0]?.host;
}

/** Normalise an error message into a signature: drop ids, numbers, paths. */
export function errorSignature(text: string | undefined): string {
  if (!text) {
    return "(no message)";
  }
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/[a-z]:\\[^\s'"]+|\/[^\s'"]+/g, "<path>")
    .replace(/0x[0-9a-f]+|[0-9a-f]{8,}/g, "<id>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

export function resolveSessionKey(ledger: Ledger, preferred?: string): string | undefined {
  if (preferred) {
    return preferred;
  }
  return ledger.recentSessions(1)[0]?.sessionKey;
}

// ------------------------------------------------------- why do I keep failing

export type ErrorCluster = { key: string; tool: string; host?: string; signature: string; count: number; share: number; first: string; last: string; example?: string };

export type FailureReport = {
  sessionKey?: string;
  windowMinutes: number;
  failures: number;
  attempts: number;
  clusters: ErrorCluster[];
  /** How many of the top-3 clusters explain, as a share of all failures. */
  top3Share: number;
  /** Compact trail for a model to reason about: last failures, oldest first. */
  trail: Array<{ t: string; tool: string; hint?: string; error?: string; status?: number }>;
  nextQuestion: string;
};

export function failureReport(ledger: Ledger, opts: { sessionKey?: string; windowMinutes?: number } = {}): FailureReport {
  const windowMinutes = opts.windowMinutes ?? 120;
  const since = Date.now() - windowMinutes * 60_000;
  const sessionKey = resolveSessionKey(ledger, opts.sessionKey);
  const outcomes = ledger.toolOutcomes({ sessionKey, sinceTs: since, limit: 1000 });
  const failures = outcomes.filter((o) => !o.ok);
  const httpFailures = (sessionKey ? ledger.eventsForSession(sessionKey, since) : ledger.recentEvents(1000).filter((e) => e.ts >= since)).filter(
    (e) => e.source === "inproc" && (typeof e.status !== "number" || e.status >= 400),
  );

  const map = new Map<string, ErrorCluster>();
  const add = (tool: string, host: string | undefined, signature: string, ts: number, example?: string) => {
    const key = `${tool}|${host ?? "-"}|${signature}`;
    const c = map.get(key) ?? { key, tool, host, signature, count: 0, share: 0, first: new Date(ts).toISOString(), last: new Date(ts).toISOString(), example };
    c.count++;
    if (ts < Date.parse(c.first)) c.first = new Date(ts).toISOString();
    if (ts > Date.parse(c.last)) c.last = new Date(ts).toISOString();
    map.set(key, c);
  };
  for (const f of failures) {
    add(f.toolName, hostOf(f), errorSignature(f.errorText), f.ts, f.argHint);
  }
  for (const e of httpFailures) {
    add(e.attribution.toolName ?? "model-turn", e.host, typeof e.status === "number" ? `http <${Math.floor(e.status / 100)}xx> ${e.status}` : "no response (timeout/connection)", e.ts, e.path);
  }
  const total = failures.length + httpFailures.length;
  const clusters = [...map.values()].map((c) => ({ ...c, share: total ? c.count / total : 0 })).sort((a, b) => b.count - a.count);
  const top3Share = clusters.slice(0, 3).reduce((s, c) => s + c.share, 0);
  const trail = [...failures]
    .sort((a, b) => a.ts - b.ts)
    .slice(-15)
    .map((f) => ({ t: new Date(f.ts).toISOString().slice(11, 19), tool: f.toolName, hint: f.argHint, error: f.errorText?.slice(0, 160) }));

  let nextQuestion: string;
  if (total === 0) {
    nextQuestion = "No failures recorded in this window. If you are failing, the failure is not a tool call: check the task itself.";
  } else if (clusters[0] && clusters[0].share >= 0.5) {
    const c = clusters[0];
    nextQuestion = `${Math.round(c.share * 100)}% of your failures are one thing: ${c.tool}${c.host ? ` on ${c.host}` : ""} — "${c.signature}". Fix that cause first; ${c.host ? `ask the outlook for ${c.host} to see whether it is the host or your request.` : "look at the trail below for what the arguments had in common."}`;
  } else {
    nextQuestion = `${clusters.length} distinct causes, top 3 explain ${Math.round(top3Share * 100)}%. Start with the largest; if none dominates, you are probably changing too many things at once — hold the approach constant and vary one input.`;
  }
  return { sessionKey, windowMinutes, failures: total, attempts: outcomes.length, clusters: clusters.slice(0, 10), top3Share, trail, nextQuestion };
}

// --------------------------------------------------------- should I stop and ask

export type StopVerdict = {
  sessionKey?: string;
  attempts: number;
  successes: number;
  successUpper: number;
  distinctApproaches: number;
  minutesElapsed: number;
  lastSuccessAgoAttempts: number | null;
  blockedHosts: string[];
  verdict: "continue" | "change-approach" | "stop-and-ask";
  reasons: string[];
  say: string;
};

export function stopOrContinue(ledger: Ledger, opts: { sessionKey?: string; windowMinutes?: number } = {}): StopVerdict {
  const since = Date.now() - (opts.windowMinutes ?? 180) * 60_000;
  const sessionKey = resolveSessionKey(ledger, opts.sessionKey);
  const outcomes = ledger.toolOutcomes({ sessionKey, sinceTs: since, limit: 1000 }).sort((a, b) => a.ts - b.ts);
  const attempts = outcomes.length;
  const successes = outcomes.filter((o) => o.ok).length;
  const successUpper = wilsonUpper(successes, attempts);
  const approaches = new Set(outcomes.map((o) => `${o.toolName}|${hostOf(o) ?? o.argHint?.split(" ")[0] ?? ""}`));
  const minutesElapsed = attempts ? Math.round((outcomes[attempts - 1].ts - outcomes[0].ts) / 60_000) : 0;
  let lastSuccessAgoAttempts: number | null = null;
  for (let i = outcomes.length - 1, k = 0; i >= 0; i--, k++) {
    if (outcomes[i].ok) {
      lastSuccessAgoAttempts = k;
      break;
    }
  }
  const hosts = [...new Set(outcomes.map(hostOf).filter((h): h is string => !!h))];
  const blockedHosts = hosts.filter((h) => {
    const o = outlookFor(ledger, h, 120);
    return o.diagnosis === "blocked";
  });

  const reasons: string[] = [];
  let verdict: StopVerdict["verdict"] = "continue";
  if (attempts === 0) {
    reasons.push("no tool calls recorded yet");
  } else {
    if (blockedHosts.length) {
      reasons.push(`refused by ${blockedHosts.join(", ")} (403/401 streak) — retrying there makes it worse`);
    }
    if (attempts >= 8 && successUpper < 0.35 && approaches.size >= 2) {
      reasons.push(`${successes}/${attempts} succeeded across ${approaches.size} approaches (95% upper bound ${(successUpper * 100).toFixed(0)}%)`);
    }
    if (lastSuccessAgoAttempts !== null && lastSuccessAgoAttempts >= 10) {
      reasons.push(`no success in the last ${lastSuccessAgoAttempts} attempts`);
    }
    if (lastSuccessAgoAttempts === null && attempts >= 10) {
      reasons.push(`no success at all in ${attempts} attempts`);
    }
    const stop = (blockedHosts.length > 0 && approaches.size <= 2) || (attempts >= 8 && successUpper < 0.35 && approaches.size >= 2) || (lastSuccessAgoAttempts === null && attempts >= 15) || (lastSuccessAgoAttempts !== null && lastSuccessAgoAttempts >= 15);
    const change = !stop && (blockedHosts.length > 0 || (attempts >= 6 && approaches.size === 1 && successUpper < 0.5) || (lastSuccessAgoAttempts !== null && lastSuccessAgoAttempts >= 6));
    verdict = stop ? "stop-and-ask" : change ? "change-approach" : "continue";
    if (verdict === "change-approach" && approaches.size === 1) {
      reasons.push("only one approach tried");
    }
  }
  const say =
    verdict === "stop-and-ask"
      ? `Stop and tell the user: ${reasons.join("; ")}. Report what you tried and what would be needed (access, a different tool, a changed task).`
      : verdict === "change-approach"
        ? `Do not repeat the same approach: ${reasons.join("; ")}. Change tool or route once; if that fails too, stop and ask.`
        : attempts
          ? `Continue: ${successes}/${attempts} succeeded, last success ${lastSuccessAgoAttempts} attempt(s) ago.`
          : "Continue: nothing recorded yet.";
  return { sessionKey, attempts, successes, successUpper, distinctApproaches: approaches.size, minutesElapsed, lastSuccessAgoAttempts, blockedHosts, verdict, reasons, say };
}

// ---------------------------------------------------------- am I going in circles

export type CirclesVerdict = {
  sessionKey?: string;
  attempts: number;
  repetitionIndex: number; // 1 - unique/total over the recent window
  mostRepeated?: { hint: string; count: number; allFailed: boolean };
  successRecent: number;
  successBefore: number;
  verdict: "on-track" | "repeating" | "stuck";
  say: string;
};

export function circlesCheck(ledger: Ledger, opts: { sessionKey?: string; recent?: number } = {}): CirclesVerdict {
  const sessionKey = resolveSessionKey(ledger, opts.sessionKey);
  const recentN = opts.recent ?? 20;
  const all = ledger.toolOutcomes({ sessionKey, limit: 2 * recentN }).sort((a, b) => a.ts - b.ts);
  const recent = all.slice(-recentN);
  const before = all.slice(0, Math.max(0, all.length - recentN));
  const keys = recent.map((o) => `${o.toolName}|${o.argHint ?? ""}`);
  const unique = new Set(keys).size;
  const repetitionIndex = keys.length ? 1 - unique / keys.length : 0;
  const counts = new Map<string, { count: number; fails: number }>();
  for (const o of recent) {
    const k = `${o.toolName}|${o.argHint ?? ""}`;
    const c = counts.get(k) ?? { count: 0, fails: 0 };
    c.count++;
    if (!o.ok) c.fails++;
    counts.set(k, c);
  }
  const top = [...counts.entries()].sort((a, b) => b[1].count - a[1].count)[0];
  const mostRepeated = top && top[1].count > 1 ? { hint: top[0], count: top[1].count, allFailed: top[1].fails === top[1].count } : undefined;
  const rate = (xs: ToolOutcome[]) => (xs.length ? xs.filter((o) => o.ok).length / xs.length : 0);
  const successRecent = rate(recent);
  const successBefore = rate(before);
  let verdict: CirclesVerdict["verdict"] = "on-track";
  if (recent.length >= 6 && mostRepeated && mostRepeated.count >= 3 && mostRepeated.allFailed) {
    verdict = "stuck";
  } else if (recent.length >= 8 && (repetitionIndex >= 0.5 || (before.length >= 5 && successRecent < successBefore - 0.3))) {
    verdict = "repeating";
  }
  const say =
    verdict === "stuck"
      ? `You are stuck: "${mostRepeated!.hint}" ran ${mostRepeated!.count} times and failed every time. Identical input gives identical output — change the input or the tool, or stop and ask.`
      : verdict === "repeating"
        ? `You are repeating yourself: only ${unique} distinct actions in the last ${recent.length}${before.length ? `, success rate fell from ${(successBefore * 100).toFixed(0)}% to ${(successRecent * 100).toFixed(0)}%` : ""}. Write down what you have established so far, then take one new step.`
        : `On track: ${unique} distinct actions in the last ${recent.length}, success rate ${(successRecent * 100).toFixed(0)}%.`;
  return { sessionKey, attempts: recent.length, repetitionIndex, mostRepeated, successRecent, successBefore, verdict, say };
}

// ------------------------------------------- could this get the user banned/charged

const PAID_HOSTS = ["api.openai.com", "api.anthropic.com", "generativelanguage.googleapis.com", "api.twilio.com", "api.sendgrid.com", "api.mailgun.net", "api.resend.com", "api.stripe.com", "amazonaws.com", "api.elevenlabs.io", "api.replicate.com", "api.together.xyz", "api.groq.com", "openrouter.ai", "api.deepseek.com", "api.mistral.ai"];
const PURCHASE_PATH = /\/(checkout|order|orders|purchase|pay|payment|subscribe|billing|cart)(\/|$)/i;

export type RiskVerdict = {
  target?: string;
  verdict: "ok" | "caution" | "stop";
  reasons: string[];
  say: string;
};

export function riskCheck(ledger: Ledger, cfg: PluginConfig, input: { host?: string; path?: string; method?: string; command?: string }): RiskVerdict {
  const reasons: string[] = [];
  let level = 0; // 0 ok, 1 caution, 2 stop
  const bump = (n: number, why: string) => {
    level = Math.max(level, n);
    reasons.push(why);
  };
  const hosts: string[] = [];
  if (input.host) {
    hosts.push(input.host.toLowerCase());
  }
  let cmd: ReturnType<typeof analyzeExecCommand> | undefined;
  if (input.command) {
    cmd = analyzeExecCommand(input.command);
    for (const t of cmd.targets) hosts.push(t.host);
    if (cmd.sensitiveRead && cmd.upload) bump(2, "the command reads credential-like files and uploads — this is the exfiltration pattern; do not run it");
    else if (cmd.sensitiveRead) bump(1, "the command reads credential-like files");
    else if (cmd.upload) bump(1, "the command uploads data");
  }
  for (const h of hosts) {
    const cat = classifyHost(h, cfg);
    if (cat === "suspicious") bump(2, `${h} is a known drop/relay host (${cat})`);
    const o = outlookFor(ledger, h, 120);
    if (o.diagnosis === "blocked") bump(2, `${h} has refused the last attempts (403/401) — another attempt risks an account ban`);
    else if (o.diagnosis === "rate-limited") bump(1, `${h} is rate-limiting; wait ${o.backoffSeconds ?? 30}s`);
    if (PAID_HOSTS.some((p) => h === p || h.endsWith("." + p))) bump(1, `${h} bills per call`);
  }
  const path = input.path ?? cmd?.targets[0]?.path;
  const method = (input.method ?? cmd?.targets[0]?.method ?? "GET").toUpperCase();
  if (path && PURCHASE_PATH.test(path) && method !== "GET") bump(2, `${method} ${path} looks like a purchase or billing action — confirm with the user first`);
  const verdict: RiskVerdict["verdict"] = level === 2 ? "stop" : level === 1 ? "caution" : "ok";
  const say =
    verdict === "stop"
      ? `Stop: ${reasons.join("; ")}. Ask the user before proceeding.`
      : verdict === "caution"
        ? `Proceed carefully: ${reasons.join("; ")}. Do it once, not in a loop, and mention it to the user.`
        : `No known risk for ${hosts.join(", ") || "this action"} on this machine.`;
  return { target: hosts[0], verdict, reasons, say };
}

// --------------------------------------------- has another agent already solved this

export type OthersVerdict = {
  host: string;
  found: boolean;
  matches: Array<{ session: string; tool?: string; method: string; path?: string; status?: number; bytesIn?: number; agoMinutes: number }>;
  say: string;
};

export function othersSolved(ledger: Ledger, host: string, opts: { path?: string; excludeSession?: string; windowMinutes?: number } = {}): OthersVerdict {
  const since = Date.now() - (opts.windowMinutes ?? 24 * 60) * 60_000;
  const evs = ledger.eventsForHostFromOtherSessions(host.toLowerCase(), opts.excludeSession, since, 100).filter((e) => typeof e.status === "number" && e.status >= 200 && e.status < 400);
  const filtered = opts.path ? evs.filter((e) => (e.path ?? "").startsWith(opts.path!)) : evs;
  const matches = filtered.slice(0, 5).map((e) => ({
    session: e.attribution.sessionKey ?? "(unknown session)",
    tool: e.attribution.toolName,
    method: e.method,
    path: e.path,
    status: e.status,
    bytesIn: e.bytesIn,
    agoMinutes: Math.round((Date.now() - e.ts) / 60_000),
  }));
  const say = matches.length
    ? `Yes — another session on this machine reached ${host}${opts.path ? opts.path : ""} successfully ${matches[0].agoMinutes} min ago (${matches[0].tool ?? "unknown tool"}, ${matches[0].method} ${matches[0].path ?? ""} → ${matches[0].status}). Use the same tool and route; if the content is what you need, ask that session (sessions_history) instead of fetching again.`
    : `No other session on this machine has reached ${host} in the last ${opts.windowMinutes ?? 1440} min. Search ClawHub reviews for a "clawphylax-card/v1" card of the skill you are using; otherwise you are first.`;
  return { host: host.toLowerCase(), found: matches.length > 0, matches, say };
}

// ------------------------------------------------------ do I know enough to act

export type ExplorationVerdict = {
  sessionKey?: string;
  gather: number;
  act: number;
  gatherShare: number;
  distinctSources: number;
  failuresBeforeFirstAct: number;
  failuresAfterFirstAct: number;
  verdict: "still-exploring" | "balanced" | "acting-blind";
  say: string;
};

export function explorationCheck(ledger: Ledger, opts: { sessionKey?: string; windowMinutes?: number } = {}): ExplorationVerdict {
  const since = Date.now() - (opts.windowMinutes ?? 180) * 60_000;
  const sessionKey = resolveSessionKey(ledger, opts.sessionKey);
  const outcomes = ledger.toolOutcomes({ sessionKey, sinceTs: since, limit: 1000 }).sort((a, b) => a.ts - b.ts);
  const gather = outcomes.filter((o) => GATHER_TOOLS.has(o.toolName)).length;
  const act = outcomes.filter((o) => ACT_TOOLS.has(o.toolName)).length;
  const gatherShare = gather + act ? gather / (gather + act) : 0;
  const events = sessionKey ? ledger.eventsForSession(sessionKey, since) : [];
  const distinctSources = new Set(events.map((e) => e.host)).size;
  const firstActIdx = outcomes.findIndex((o) => ACT_TOOLS.has(o.toolName));
  const failuresBeforeFirstAct = outcomes.slice(0, firstActIdx < 0 ? outcomes.length : firstActIdx).filter((o) => !o.ok).length;
  const failuresAfterFirstAct = firstActIdx < 0 ? 0 : outcomes.slice(firstActIdx).filter((o) => !o.ok).length;
  let verdict: ExplorationVerdict["verdict"] = "balanced";
  if (act >= 3 && gatherShare < 0.2 && failuresAfterFirstAct >= 2) {
    verdict = "acting-blind";
  } else if (gather >= 8 && act === 0) {
    verdict = "still-exploring";
  }
  const say =
    verdict === "acting-blind"
      ? `You acted ${act} times after gathering only ${gather} times, and ${failuresAfterFirstAct} actions failed. Read before you write: fetch the docs or the target once, then act.`
      : verdict === "still-exploring"
        ? `You have gathered ${gather} times across ${distinctSources} sources without acting. If the picture is not changing, you know enough — act on one concrete step.`
        : `Balanced: ${gather} gathering vs ${act} acting calls, ${distinctSources} distinct sources.`;
  return { sessionKey, gather, act, gatherShare, distinctSources, failuresBeforeFirstAct, failuresAfterFirstAct, verdict, say };
}

// ------------------------------------------------------------ what worked here

export type Recipe = { tool: string; method: string; pathPrefix: string; n: number; successes: number; lower: number; p50Ms?: number };

export type WhatWorked = { host: string; recipes: Recipe[]; markdown: string };

export function whatWorked(ledger: Ledger, host: string): WhatWorked {
  const evs = ledger.eventsForHost(host.toLowerCase(), 0, 1000).filter((e) => e.source === "inproc");
  const groups = new Map<string, { evs: EgressEvent[] }>();
  for (const e of evs) {
    const prefix = (e.path ?? "/").split("/").slice(0, 3).join("/") || "/";
    const key = `${e.attribution.toolName ?? "model-turn"}|${e.method}|${prefix}`;
    const g = groups.get(key) ?? { evs: [] };
    g.evs.push(e);
    groups.set(key, g);
  }
  const recipes: Recipe[] = [...groups.entries()]
    .map(([key, g]) => {
      const [tool, method, pathPrefix] = key.split("|");
      const successes = g.evs.filter((e) => typeof e.status === "number" && e.status >= 200 && e.status < 400).length;
      const durs = g.evs.map((e) => e.durationMs).filter((d): d is number => typeof d === "number" && d > 0).sort((a, b) => a - b);
      return { tool, method, pathPrefix, n: g.evs.length, successes, lower: wilsonLower(successes, g.evs.length), p50Ms: durs.length ? durs[Math.floor(durs.length / 2)] : undefined };
    })
    .filter((r) => r.successes > 0)
    .sort((a, b) => b.lower - a.lower || b.n - a.n)
    .slice(0, 5);
  const lines = [`## What worked on ${host} (observed on this machine)`, ""];
  if (!recipes.length) {
    lines.push("Nothing succeeded here yet.");
  } else {
    for (const r of recipes) {
      lines.push(`- \`${r.tool}\` ${r.method} \`${r.pathPrefix}\` — ${r.successes}/${r.n} succeeded (lower bound ${(r.lower * 100).toFixed(0)}%)${r.p50Ms ? `, p50 ${r.p50Ms}ms` : ""}`);
    }
    lines.push("", "To make it repeatable, put the winning tool and route into a workspace skill (skill-creator), and post a witness card so the next agent finds it.");
  }
  return { host: host.toLowerCase(), recipes, markdown: lines.join("\n") };
}
