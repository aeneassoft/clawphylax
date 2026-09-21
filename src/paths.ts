// "Which path is worth it?" — choosing among research or action paths under
// incomplete information, the way the poker engine chooses among lines:
// a Beta posterior per path, decisions on bounds, and an explicit price for
// information. No path is ever declared dead on a point estimate.
//
// Model per path: p ~ Beta(a, b) with a = prior*strength + successes,
// b = (1-prior)*strength + failures. One attempt costs c and pays v on success.
//   EV(attempt)      = E[p]·v − c
//   Optimistic value = UCB(p)·v − c      (what exploring could reveal)
//   Safe value       = LCB(p)·v − c      (what exploiting already guarantees)
// Recommendation: exploit the best safe value when it is positive and clearly
// ahead; otherwise explore the path with the best optimistic value whose
// posterior is still wide; fold paths whose optimistic value is negative.

import { wilsonUpper } from "./baseline.js";
import type { Ledger } from "./ledger.js";
import { wilsonLower } from "./outlook.js";

export type PathInput = {
  name: string;
  successes?: number;
  failures?: number;
  /** Prior success probability before any observation (default 0.5). */
  prior?: number;
  /** How many pseudo-observations the prior is worth (default 2). */
  priorStrength?: number;
  /** Cost of one attempt, in whatever unit you use for value (default 1). */
  costPerAttempt?: number;
  /** Payoff if an attempt succeeds, same unit (default 10). */
  valueIfSuccess?: number;
};

export type PathVerdict = {
  name: string;
  n: number;
  successes: number;
  mean: number;
  lower: number;
  upper: number;
  evAttempt: number;
  safeValue: number;
  optimisticValue: number;
  width: number;
  fromLedger: boolean;
  action: "exploit" | "explore" | "fold" | "hold";
};

export type PathsReport = {
  budget?: number;
  paths: PathVerdict[];
  recommendation: string;
  plan: string[];
};

function beta(input: PathInput, obs: { s: number; f: number }) {
  const prior = Math.min(0.99, Math.max(0.01, input.prior ?? 0.5));
  const k = Math.max(0.5, input.priorStrength ?? 2);
  const a = prior * k + obs.s;
  const b = (1 - prior) * k + obs.f;
  const n = obs.s + obs.f;
  const mean = a / (a + b);
  // Wilson bounds on the observed rate, widened by the prior mass when n is small.
  const pseudoN = n + k;
  const pseudoS = obs.s + prior * k;
  return { mean, lower: wilsonLower(pseudoS, pseudoN), upper: wilsonUpper(pseudoS, pseudoN), n };
}

export function ledgerObservations(ledger: Ledger | undefined, name: string): { s: number; f: number } | undefined {
  if (!ledger || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(name)) {
    return undefined;
  }
  const evs = ledger.eventsForHost(name.toLowerCase(), 0, 500).filter((e) => e.source === "inproc");
  if (!evs.length) {
    return undefined;
  }
  const s = evs.filter((e) => typeof e.status === "number" && e.status >= 200 && e.status < 400).length;
  return { s, f: evs.length - s };
}

export function whichPath(inputs: PathInput[], opts: { budget?: number; ledger?: Ledger } = {}): PathsReport {
  const paths: PathVerdict[] = inputs.map((p) => {
    const led = ledgerObservations(opts.ledger, p.name);
    const obs = { s: (p.successes ?? 0) + (led?.s ?? 0), f: (p.failures ?? 0) + (led?.f ?? 0) };
    const c = p.costPerAttempt ?? 1;
    const v = p.valueIfSuccess ?? 10;
    const b = beta(p, obs);
    return {
      name: p.name,
      n: b.n,
      successes: obs.s,
      mean: b.mean,
      lower: b.lower,
      upper: b.upper,
      evAttempt: b.mean * v - c,
      safeValue: b.lower * v - c,
      optimisticValue: b.upper * v - c,
      width: b.upper - b.lower,
      fromLedger: !!led,
      action: "hold",
    };
  });

  for (const p of paths) {
    if (p.optimisticValue <= 0) {
      p.action = "fold"; // even the best case does not pay for the attempt
    }
  }
  const live = paths.filter((p) => p.action !== "fold");
  const bestSafe = [...live].sort((a, b) => b.safeValue - a.safeValue)[0];
  const bestOpt = [...live].filter((p) => p.width > 0.25).sort((a, b) => b.optimisticValue - a.optimisticValue)[0];

  let recommendation: string;
  const plan: string[] = [];
  if (!live.length) {
    recommendation = "No path pays even in the best case with these costs and values. Stop, or change the task's value/cost assumptions with the user.";
  } else if (bestSafe && bestSafe.safeValue > 0 && (!bestOpt || bestOpt.name === bestSafe.name || bestSafe.safeValue >= 0.6 * bestOpt.optimisticValue)) {
    bestSafe.action = "exploit";
    recommendation = `Exploit "${bestSafe.name}": it already guarantees ${bestSafe.safeValue.toFixed(2)} per attempt at the lower bound (${(bestSafe.lower * 100).toFixed(0)}%–${(bestSafe.upper * 100).toFixed(0)}%, n=${bestSafe.n}). The unexplored paths cannot beat that by enough to justify the information cost.`;
    plan.push(`Run "${bestSafe.name}" until its lower bound drops below the next path's optimistic value.`);
    if (bestOpt && bestOpt.name !== bestSafe.name) plan.push(`If budget remains, spend at most 2 attempts on "${bestOpt.name}" to narrow its interval (${(bestOpt.lower * 100).toFixed(0)}–${(bestOpt.upper * 100).toFixed(0)}%).`);
  } else if (bestOpt) {
    bestOpt.action = "explore";
    recommendation = `Explore "${bestOpt.name}": nothing is safely profitable yet, and this path has the highest upside (${bestOpt.optimisticValue.toFixed(2)} at the upper bound) with a wide interval (${(bestOpt.lower * 100).toFixed(0)}–${(bestOpt.upper * 100).toFixed(0)}%). One or two attempts buy the most information per unit cost.`;
    plan.push(`Try "${bestOpt.name}" once. Success → its lower bound rises and it likely becomes the exploit. Failure → re-run this check; the next path moves up.`);
  } else {
    const p = bestSafe;
    p.action = "exploit";
    recommendation = `Only "${p.name}" is left with a positive mean value (${p.evAttempt.toFixed(2)} per attempt); intervals are already narrow, so there is nothing left to learn — run it or stop.`;
  }
  const folded = paths.filter((p) => p.action === "fold");
  if (folded.length) {
    plan.push(`Fold: ${folded.map((p) => `"${p.name}" (best case ${p.optimisticValue.toFixed(2)})`).join(", ")}.`);
  }
  if (opts.budget !== undefined) {
    const cheapest = Math.min(...inputs.map((p) => p.costPerAttempt ?? 1));
    plan.push(`Budget ${opts.budget} covers about ${Math.floor(opts.budget / cheapest)} attempts at the cheapest cost; stop and report when it is spent.`);
  }
  return { budget: opts.budget, paths: paths.sort((a, b) => b.safeValue - a.safeValue), recommendation, plan };
}

export function renderPaths(r: PathsReport): string {
  const lines = [r.recommendation, ""];
  for (const p of r.paths) {
    lines.push(`- ${p.action.toUpperCase().padEnd(7)} ${p.name}: p=${(p.mean * 100).toFixed(0)}% [${(p.lower * 100).toFixed(0)}–${(p.upper * 100).toFixed(0)}%] n=${p.n}${p.fromLedger ? " (from ledger)" : ""} · EV/attempt ${p.evAttempt.toFixed(2)} · safe ${p.safeValue.toFixed(2)} · optimistic ${p.optimisticValue.toFixed(2)}`);
  }
  if (r.plan.length) {
    lines.push("", ...r.plan.map((s) => `→ ${s}`));
  }
  return lines.join("\n");
}
