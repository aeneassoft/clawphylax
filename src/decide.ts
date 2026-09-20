// Decision layer, v0.1: classification + rules + denylist. Observe by default.
//
// v0.4 will replace the fixed rule with the statistical gate ported from the
// poker engine (per-key Dirichlet over destinations, lower-confidence-bound
// trigger). The interface is already shaped for it: decide() sees the key,
// the host and the ledger, and returns a verdict.

import { classifyHost, isAllowlisted, isIpLiteral } from "./classify.js";
import type { Ledger } from "./ledger.js";
import type { Category, Flag, PluginConfig } from "./types.js";

export type Verdict = {
  category: Category;
  flags: Flag[];
  block: boolean;
  reason?: string;
};

export function decide(params: {
  cfg: PluginConfig;
  ledger: Ledger;
  key: string;
  host: string;
  extraFlags?: Flag[];
}): Verdict {
  const { cfg, ledger, key, host } = params;
  const flags: Flag[] = [...(params.extraFlags ?? [])];
  const category = classifyHost(host, cfg);
  if (isIpLiteral(host) && category !== "local") {
    flags.push("raw-ip");
  }

  const rule = ledger.ruleFor(key, host);
  if (rule === "allow" || isAllowlisted(host, cfg)) {
    return { category, flags, block: false };
  }
  if (rule === "deny") {
    return { category, flags, block: cfg.mode === "enforce", reason: "denied by rule" };
  }
  if (category === "suspicious") {
    return {
      category,
      flags,
      block: cfg.mode === "enforce",
      reason: "host is on the suspicious list",
    };
  }
  return { category, flags, block: false };
}
