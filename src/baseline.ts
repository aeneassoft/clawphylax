// Destination baseline per origin, ported from the poker engine's opponent
// model: a Dirichlet posterior over the hosts an origin contacts, and a
// lower-confidence-bound gate that only calls a host "unexpected" when the
// baseline is statistically settled. Until then we observe and say so.
//
// Why this shape: a static list knows nothing about *this* skill. A skill that
// has made 200 calls to exactly two hosts and now opens a third is a different
// event from a skill on its fifth call ever. The gate fires only on the first
// kind — the same rule the poker bot uses before it exploits a measured leak:
// act on the bound, never on the point estimate.

import type { Ledger } from "./ledger.js";

export type BaselineStatus = "learning" | "stable" | "volatile";

export type Baseline = {
  key: string;
  n: number; // observed events for this origin
  distinct: number; // distinct hosts so far
  /** Posterior predictive probability that the next event hits a new host. */
  pNew: number;
  /** Upper 95% confidence bound on the novelty rate (distinct / n). */
  noveltyUpper: number;
  status: BaselineStatus;
};

export const BASELINE_MIN_EVENTS = 20;
const ALPHA_NEW = 1; // Dirichlet-process style mass reserved for unseen hosts
const NOVELTY_STABLE_UPPER = 0.25; // an origin is "stable" when even the upper bound of its novelty rate is low
const Z = 1.96;

/** Wilson score interval upper bound for a proportion. */
export function wilsonUpper(successes: number, n: number, z = Z): number {
  if (n <= 0) {
    return 1;
  }
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.min(1, (centre + margin) / denom);
}

export function computeBaseline(key: string, n: number, distinct: number): Baseline {
  const pNew = ALPHA_NEW / (n + ALPHA_NEW);
  const noveltyUpper = wilsonUpper(distinct, n);
  let status: BaselineStatus = "learning";
  if (n >= BASELINE_MIN_EVENTS) {
    status = noveltyUpper <= NOVELTY_STABLE_UPPER ? "stable" : "volatile";
  }
  return { key, n, distinct, pNew, noveltyUpper, status };
}

export function baselineFor(ledger: Ledger, key: string): Baseline {
  const rows = ledger.hostsFor(key);
  const n = rows.reduce((s, r) => s + r.count, 0);
  return computeBaseline(key, n, rows.length);
}

/**
 * The gate. Returns true only when a *new* host for this origin is genuinely
 * unexpected: enough history, and the origin's novelty rate is bounded low.
 * A learning or volatile origin never triggers — that is the safety property.
 */
export function isUnexpectedNewHost(b: Baseline): boolean {
  return b.status === "stable";
}

/** Surprise in bits for a new host under the posterior predictive, for the report. */
export function surpriseBits(b: Baseline): number {
  return -Math.log2(Math.max(b.pNew, 1e-9));
}
