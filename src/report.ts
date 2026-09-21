// Text rendering for the CLI and the reply footer.

import { BASELINE_MIN_EVENTS, baselineFor } from "./baseline.js";
import type { Ledger, SkillSummary } from "./ledger.js";
import type { EgressEvent } from "./types.js";

export function fmtBytes(n: number | undefined): string {
  if (!n) {
    return "0 B";
  }
  if (n < 1024) {
    return `${n} B`;
  }
  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(1)} KB`;
  }
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function fmtAgo(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) {
    return `${s}s ago`;
  }
  if (s < 3600) {
    return `${Math.round(s / 60)}m ago`;
  }
  if (s < 86400) {
    return `${Math.round(s / 3600)}h ago`;
  }
  return `${Math.round(s / 86400)}d ago`;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

export function renderSummary(ledger: Ledger, sinceTs = 0): string {
  const rows = ledger.summaries(sinceTs);
  const c = ledger.counts();
  const lines: string[] = [];
  lines.push(`ClawPhylax — outbound connections by origin (${c.events} events, ${c.hosts} host pairs)`);
  lines.push(`ledger: ${ledger.path}`);
  lines.push("");
  if (rows.length === 0) {
    lines.push("No events recorded yet. Run an agent turn, then come back.");
    return lines.join("\n");
  }
  lines.push(`${pad("origin", 34)} ${pad("hosts", 6)} ${pad("calls", 6)} ${pad("sent", 9)} ${pad("flagged", 8)} ${pad("blocked", 8)} ${pad("baseline", 10)} last`);
  for (const r of rows) {
    const b = baselineFor(ledger, r.key);
    lines.push(
      `${pad(r.key, 34)} ${pad(String(r.hosts), 6)} ${pad(String(r.calls), 6)} ${pad(fmtBytes(r.bytes_out), 9)} ${pad(String(r.suspicious), 8)} ${pad(String(r.blocked), 8)} ${pad(b.status, 10)} ${fmtAgo(r.last_seen)}`,
    );
  }
  lines.push("");
  lines.push(`baseline: learning = fewer than ${BASELINE_MIN_EVENTS} events · stable = settled destination set, a new host is unexpected · volatile = many destinations by nature`);
  const flagged = ledger.flagged(sinceTs, 10);
  if (flagged.length) {
    lines.push("");
    lines.push("Flagged (most recent):");
    for (const e of flagged) {
      lines.push(`  ${renderEventLine(e)}`);
    }
  }
  return lines.join("\n");
}

export function renderHosts(ledger: Ledger, key: string): string {
  const rows = ledger.hostsFor(key);
  if (!rows.length) {
    return `No hosts recorded for ${key}.`;
  }
  const lines = [`${key} — ${rows.length} host(s)`, ""];
  for (const r of rows) {
    lines.push(`  ${pad(r.host, 44)} ${pad(String(r.count) + "x", 7)} first ${fmtAgo(r.first_seen)}, last ${fmtAgo(r.last_seen)}`);
  }
  return lines.join("\n");
}

export function renderEventLine(e: EgressEvent): string {
  const who = e.attribution.skill ? `skill:${e.attribution.skill}` : e.attribution.toolName ? `tool:${e.attribution.toolName}` : "model-turn";
  const flags = e.flags.length ? ` [${e.flags.join(",")}]` : "";
  const blocked = e.blocked ? " BLOCKED" : "";
  const via = e.source === "exec" ? "exec" : e.protocol;
  return `${new Date(e.ts).toISOString().slice(11, 19)} ${pad(who, 28)} ${pad(e.method, 5)} ${e.host}${e.path ? e.path.slice(0, 40) : ""} via ${via} (${e.category})${flags}${blocked}`;
}

export function renderRecent(ledger: Ledger, limit: number, key?: string): string {
  const evs = ledger.recentEvents(limit, key);
  if (!evs.length) {
    return "No events.";
  }
  return evs.map(renderEventLine).join("\n");
}

/** One line for the agent reply: only when something is worth a look. */
export function renderRunFooter(events: EgressEvent[]): string | undefined {
  const silent = events.filter((e) => e.source === "inproc" && e.attribution.toolCallId && (typeof e.status !== "number" || e.status >= 400));
  const external = events.filter((e) => e.category !== "model" && e.category !== "local" && e.category !== "channel");
  if (!external.length && !silent.length) {
    return undefined;
  }
  if (!external.length) {
    const f = silent[0];
    return `🛡 ClawPhylax: STOP CONDITION — ${f.attribution.toolName ?? "a tool"} made ${f.method} ${f.host} which returned ${typeof f.status === "number" ? f.status : "no response"}. Do not build on that result; run /phylax check.`;
  }
  const suspicious = external.filter(
    (e) => e.category === "suspicious" || e.flags.includes("sensitive-read") || e.flags.includes("unexpected-host") || e.blocked,
  );
  const newHosts = external.filter((e) => e.flags.includes("new-host") && !e.flags.includes("unexpected-host"));
  if (!suspicious.length && !newHosts.length) {
    return undefined;
  }
  const parts: string[] = [];
  if (suspicious.length) {
    const first = suspicious[0];
    const who = first.attribution.skill ?? first.attribution.toolName ?? "unknown origin";
    parts.push(`${suspicious.length} flagged — e.g. ${first.host} via ${who}${first.blocked ? " (blocked)" : ""}`);
  }
  if (newHosts.length) {
    const hosts = [...new Set(newHosts.map((e) => e.host))].slice(0, 3).join(", ");
    parts.push(`${newHosts.length} new host${newHosts.length > 1 ? "s" : ""}: ${hosts}`);
  }
  return `🛡 ClawPhylax: ${parts.join(" · ")} — \`openclaw clawphylax report\``;
}

/**
 * Witness card: what one origin did on this machine, in a form another
 * person or agent can read before installing the same skill. No identity, no
 * payloads, no server — just hosts, counts, flags and the baseline. The
 * marker line makes cards findable in ClawHub reviews and issue threads.
 */
export function renderCard(ledger: Ledger, key: string, format: "json" | "md" = "md"): string {
  const hosts = ledger.hostsFor(key);
  const events = ledger.recentEvents(1000, key);
  const b = baselineFor(ledger, key);
  const flagged = events.filter((e) => e.category === "suspicious" || e.blocked || e.flags.includes("sensitive-read") || e.flags.includes("unexpected-host"));
  const card = {
    card: "clawphylax-card/v1",
    origin: key,
    observed_events: events.length,
    first_seen: hosts.length ? new Date(Math.min(...hosts.map((h) => h.first_seen))).toISOString() : null,
    last_seen: hosts.length ? new Date(Math.max(...hosts.map((h) => h.last_seen))).toISOString() : null,
    baseline: b.status,
    hosts: hosts.map((h) => ({ host: h.host, count: h.count })),
    flagged: flagged.slice(0, 10).map((e) => ({ host: e.host, method: e.method, via: e.source, flags: e.flags.filter((f) => f !== "new-host") })),
    platform: process.platform,
    plugin: "clawphylax@0.4.0",
  };
  if (format === "json") {
    return JSON.stringify(card, null, 2);
  }
  const lines = [
    `<!-- clawphylax-card/v1 -->`,
    `**ClawPhylax witness card** — \`${key}\` on ${process.platform}, ${events.length} observed events, baseline: ${b.status}`,
    ``,
    hosts.length ? `Hosts contacted:` : `No network activity observed.`,
    ...hosts.map((h) => `- \`${h.host}\` ×${h.count}`),
  ];
  if (flagged.length) {
    lines.push(``, `Flagged:`);
    for (const e of flagged.slice(0, 10)) {
      lines.push(`- ${e.method} \`${e.host}\` via ${e.source}${e.flags.length ? ` [${e.flags.filter((f) => f !== "new-host").join(", ")}]` : ""}${e.blocked ? " — blocked" : ""}`);
    }
  }
  lines.push(``, `_Generated by [ClawPhylax](https://github.com/aeneassoft/clawphylax). Evidence from one machine; not a verdict._`);
  return lines.join("\n");
}

export function summaryJson(rows: SkillSummary[]): string {
  return JSON.stringify(rows, null, 2);
}
