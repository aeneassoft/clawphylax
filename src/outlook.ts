// Request outlook: the question an agent asks at every tool call —
// "will this request work, and if it just failed, was it me, the site, or the
// network?" — answered from the ledger this machine already keeps.
//
// Same discipline as the baseline gate: decisions on bounds, not on point
// estimates. A Beta(1,1) posterior gives the probability the next attempt
// succeeds; the Wilson interval says how sure we are; the last few events say
// what kind of failure it is.

import { wilsonUpper } from "./baseline.js";
import type { Ledger } from "./ledger.js";
import type { EgressEvent } from "./types.js";

export type Diagnosis =
  | "no-history"
  | "ok"
  | "blocked" // 401/403 streak after earlier successes, or only 401/403 ever
  | "rate-limited" // recent 429s
  | "site-error" // 5xx dominate recent attempts
  | "unreachable" // timeouts / connection errors, no status at all
  | "unreliable"; // low success rate with enough evidence

export type ToolStat = { tool: string; n: number; successes: number; rate: number };

export type Outlook = {
  host: string;
  windowMinutes: number;
  n: number;
  successes: number;
  /** Posterior mean P(next attempt succeeds), Beta(1,1) prior. */
  pNext: number;
  /** Wilson 95% lower bound on the success rate. */
  pLower: number;
  pUpper: number;
  latencyP50Ms?: number;
  latencyP95Ms?: number;
  lastStatus?: number;
  lastError?: string;
  lastSeen?: string;
  recentStatuses: Array<number | "error">;
  diagnosis: Diagnosis;
  /** Seconds to wait before the next attempt, when waiting is the answer. */
  backoffSeconds?: number;
  byTool: ToolStat[];
  bestTool?: string;
  recommendation: string;
  confidence: "high" | "medium" | "low";
};

export function wilsonLower(successes: number, n: number, z = 1.96): number {
  if (n <= 0) {
    return 0;
  }
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.max(0, (centre - margin) / denom);
}

function isSuccess(e: EgressEvent): boolean {
  return typeof e.status === "number" && e.status >= 200 && e.status < 400;
}

function pct(xs: number[], q: number): number | undefined {
  if (!xs.length) {
    return undefined;
  }
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))];
}

export function computeOutlook(host: string, events: EgressEvent[], windowMinutes: number): Outlook {
  const evs = events
    .filter((e) => e.source === "inproc") // only observed responses carry a status
    .sort((a, b) => a.ts - b.ts);
  const n = evs.length;
  const successes = evs.filter(isSuccess).length;
  const pNext = (successes + 1) / (n + 2);
  const pLower = wilsonLower(successes, n);
  const pUpper = wilsonUpper(successes, n);
  const durations = evs.map((e) => e.durationMs).filter((d): d is number => typeof d === "number" && d > 0);
  const recent = evs.slice(-10);
  const recentStatuses = recent.map((e) => (typeof e.status === "number" ? e.status : ("error" as const)));
  const last = evs[evs.length - 1];

  // Per-tool comparison for this host.
  const byToolMap = new Map<string, ToolStat>();
  for (const e of evs) {
    const tool = e.attribution.toolName ?? (e.attribution.skill ? `skill:${e.attribution.skill}` : "model-turn");
    const t = byToolMap.get(tool) ?? { tool, n: 0, successes: 0, rate: 0 };
    t.n++;
    if (isSuccess(e)) {
      t.successes++;
    }
    byToolMap.set(tool, t);
  }
  const byTool = [...byToolMap.values()].map((t) => ({ ...t, rate: t.n ? t.successes / t.n : 0 })).sort((a, b) => b.rate - a.rate);
  const bestTool = byTool.find((t) => t.n >= 5 && wilsonLower(t.successes, t.n) > 0.5)?.tool;

  let diagnosis: Diagnosis = "ok";
  let backoffSeconds: number | undefined;
  let recommendation = "";
  let confidence: Outlook["confidence"] = n >= 20 ? "high" : n >= 6 ? "medium" : "low";

  const recentCodes = recent.map((e) => e.status);
  const count = (pred: (s: number | undefined) => boolean) => recentCodes.filter(pred).length;
  const tail = (k: number) => recentCodes.slice(-k);

  if (n === 0) {
    diagnosis = "no-history";
    confidence = "low";
    recommendation = `No observed requests to ${host} on this machine yet. Try once; the answer improves with every attempt recorded.`;
  } else if (tail(3).length === 3 && tail(3).every((s) => s === 401 || s === 403) && (successes > 0 || n >= 3)) {
    diagnosis = "blocked";
    recommendation =
      successes > 0
        ? `${host} answered ${tail(3).join("/")} on the last three attempts after earlier successes: you are being refused, most likely rate- or bot-blocked. Retrying makes it worse. Stop, wait at least 15 minutes, or use a different route (official API, another tool, ask the user).`
        : `${host} has refused every attempt (${tail(3).join("/")}). This is an authentication or access problem, not a transient one. Do not retry blindly; check credentials or ask the user.`;
    backoffSeconds = 900;
  } else if (count((s) => s === 429) >= 2 || tail(1)[0] === 429) {
    diagnosis = "rate-limited";
    const stamps = recent.filter((e) => e.status === 429).map((e) => e.ts);
    const gaps: number[] = [];
    for (let i = 1; i < recent.length; i++) {
      gaps.push(recent[i].ts - recent[i - 1].ts);
    }
    const medianGap = pct(gaps, 0.5) ?? 5000;
    backoffSeconds = Math.min(300, Math.max(10, Math.round((medianGap * 3) / 1000)));
    recommendation = `${host} is rate-limiting you (${stamps.length} × 429 in the last ${recent.length} requests). Wait ~${backoffSeconds}s, then retry once. Do not fire parallel requests at this host.`;
  } else if (count((s) => typeof s === "number" && s >= 500) >= Math.max(2, Math.ceil(recent.length * 0.5))) {
    diagnosis = "site-error";
    backoffSeconds = 60;
    recommendation = `${host} is returning server errors (${count((s) => typeof s === "number" && s >= 500)} of the last ${recent.length}). That is the site, not your request. Wait ~60s and retry unchanged; rewording will not help.`;
  } else if (recent.length >= 2 && count((s) => s === undefined) >= Math.ceil(recent.length * 0.6)) {
    diagnosis = "unreachable";
    backoffSeconds = 30;
    recommendation = `Requests to ${host} are failing without a response (timeouts or connection errors, ${count((s) => s === undefined)} of the last ${recent.length}). Network or DNS, not the request. Wait ~30s; if it persists, tell the user.`;
  } else if (n >= 8 && pUpper < 0.4) {
    diagnosis = "unreliable";
    recommendation = `Only ${successes} of ${n} requests to ${host} succeeded (95% upper bound ${(pUpper * 100).toFixed(0)}%). This path is statistically unreliable; ${bestTool ? `use ${bestTool} instead — it succeeds here` : "change approach rather than retrying"}.`;
  } else {
    diagnosis = "ok";
    recommendation = `${host} is answering: ${successes}/${n} succeeded, next attempt ~${(pNext * 100).toFixed(0)}% likely to succeed (lower bound ${(pLower * 100).toFixed(0)}%). If your last call failed, the cause is probably in the request itself (URL, method, body), not the host.`;
  }

  return {
    host,
    windowMinutes,
    n,
    successes,
    pNext,
    pLower,
    pUpper,
    latencyP50Ms: pct(durations, 0.5),
    latencyP95Ms: pct(durations, 0.95),
    lastStatus: last?.status,
    lastError: undefined,
    lastSeen: last ? new Date(last.ts).toISOString() : undefined,
    recentStatuses,
    diagnosis,
    backoffSeconds,
    byTool,
    bestTool,
    recommendation,
    confidence,
  };
}

export function outlookFor(ledger: Ledger, host: string, windowMinutes = 60): Outlook {
  const since = Date.now() - windowMinutes * 60_000;
  let events = ledger.eventsForHost(host.toLowerCase(), since, 500);
  let window = windowMinutes;
  if (events.length === 0) {
    // Fall back to all-time history so a quiet host still gets an answer.
    events = ledger.eventsForHost(host.toLowerCase(), 0, 500);
    window = 0;
  }
  return computeOutlook(host.toLowerCase(), events, window);
}

export function renderOutlook(o: Outlook): string {
  const lines = [
    `${o.host} — ${o.diagnosis.toUpperCase()} (${o.confidence} confidence, ${o.n} requests${o.windowMinutes ? ` in ${o.windowMinutes} min` : " all-time"})`,
    o.recommendation,
  ];
  if (o.n > 0) {
    lines.push(
      `next attempt: ~${(o.pNext * 100).toFixed(0)}% (95% bounds ${(o.pLower * 100).toFixed(0)}–${(o.pUpper * 100).toFixed(0)}%)` +
        (o.latencyP50Ms ? ` · latency p50 ${o.latencyP50Ms}ms p95 ${o.latencyP95Ms}ms` : "") +
        ` · recent: ${o.recentStatuses.join(" ")}`,
    );
  }
  if (o.backoffSeconds) {
    lines.push(`wait: ${o.backoffSeconds}s`);
  }
  if (o.byTool.length > 1) {
    lines.push(`by tool: ${o.byTool.map((t) => `${t.tool} ${t.successes}/${t.n}`).join(", ")}${o.bestTool ? ` → prefer ${o.bestTool}` : ""}`);
  }
  return lines.join("\n");
}
