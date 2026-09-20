// `openclaw clawphylax …` — reads the ledger; does not need the Gateway.

import { Ledger, defaultLedgerPath } from "./ledger.js";
import { renderCard, renderHosts, renderRecent, renderSummary, summaryJson } from "./report.js";

type Command = {
  command: (name: string) => Command;
  description: (d: string) => Command;
  option: (flags: string, d?: string, def?: unknown) => Command;
  argument: (name: string, d?: string) => Command;
  action: (fn: (...args: any[]) => void | Promise<void>) => Command;
};

export const CLI_DESCRIPTOR = {
  name: "clawphylax",
  description: "Report outbound network activity per skill and tool call",
  hasSubcommands: true,
};

export function sinceMs(v: unknown): number {
  if (typeof v !== "string" || !v) {
    return 0;
  }
  const m = v.match(/^(\d+)([smhd])$/);
  if (!m) {
    return 0;
  }
  const n = Number(m[1]);
  const mult = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
  return Date.now() - n * mult;
}

export function registerCli(program: Command, out: (s: string) => void = (s) => console.log(s)): void {
  const root = program.command("clawphylax").description(CLI_DESCRIPTOR.description);

  root
    .command("report")
    .description("Outbound connections grouped by skill / tool (default: all time)")
    .option("--since <window>", "e.g. 24h, 7d, 30m")
    .option("--json", "JSON output")
    .option("--db <path>", "ledger path")
    .action((opts: Record<string, unknown>) => {
      const l = new Ledger(typeof opts.db === "string" ? opts.db : defaultLedgerPath());
      try {
        out(opts.json ? summaryJson(l.summaries(sinceMs(opts.since))) : renderSummary(l, sinceMs(opts.since)));
      } finally {
        l.close();
      }
    });

  root
    .command("hosts")
    .description("Hosts contacted by one origin, e.g. skill:notes-sync or tool:web_fetch")
    .argument("<origin>")
    .option("--db <path>", "ledger path")
    .action((origin: string, opts: Record<string, unknown>) => {
      const l = new Ledger(typeof opts.db === "string" ? opts.db : defaultLedgerPath());
      try {
        out(renderHosts(l, origin));
      } finally {
        l.close();
      }
    });

  root
    .command("recent")
    .description("Most recent events")
    .option("--limit <n>", "number of events", "50")
    .option("--origin <key>", "filter by origin key")
    .option("--db <path>", "ledger path")
    .action((opts: Record<string, unknown>) => {
      const l = new Ledger(typeof opts.db === "string" ? opts.db : defaultLedgerPath());
      try {
        out(renderRecent(l, Number(opts.limit ?? 50), typeof opts.origin === "string" ? opts.origin : undefined));
      } finally {
        l.close();
      }
    });

  root
    .command("allow")
    .description("Never flag or block this host for an origin ('*' for all)")
    .argument("<origin>")
    .argument("<host>")
    .option("--db <path>", "ledger path")
    .action((origin: string, host: string, opts: Record<string, unknown>) => {
      const l = new Ledger(typeof opts.db === "string" ? opts.db : defaultLedgerPath());
      try {
        l.addRule(origin, host.toLowerCase(), "allow");
        out(`allow ${origin} -> ${host}`);
      } finally {
        l.close();
      }
    });

  root
    .command("deny")
    .description("Flag (observe) or block (enforce) this host for an origin ('*' for all)")
    .argument("<origin>")
    .argument("<host>")
    .option("--db <path>", "ledger path")
    .action((origin: string, host: string, opts: Record<string, unknown>) => {
      const l = new Ledger(typeof opts.db === "string" ? opts.db : defaultLedgerPath());
      try {
        l.addRule(origin, host.toLowerCase(), "deny");
        out(`deny ${origin} -> ${host}`);
      } finally {
        l.close();
      }
    });

  root
    .command("rules")
    .description("List rules")
    .option("--db <path>", "ledger path")
    .action((opts: Record<string, unknown>) => {
      const l = new Ledger(typeof opts.db === "string" ? opts.db : defaultLedgerPath());
      try {
        const rows = l.rules();
        out(rows.length ? rows.map((r) => `${r.id}\t${r.decision}\t${r.scope}\t${r.host}`).join("\n") : "No rules.");
      } finally {
        l.close();
      }
    });

  root
    .command("export")
    .description("Dump events as JSON lines")
    .option("--since <window>", "e.g. 24h")
    .option("--db <path>", "ledger path")
    .action((opts: Record<string, unknown>) => {
      const l = new Ledger(typeof opts.db === "string" ? opts.db : defaultLedgerPath());
      try {
        const since = sinceMs(opts.since);
        for (const e of l.recentEvents(1_000_000)) {
          if (e.ts >= since) {
            out(JSON.stringify(e));
          }
        }
      } finally {
        l.close();
      }
    });

  root
    .command("card")
    .description("Witness card for one origin, to paste into a ClawHub review or issue (markdown; --json for machines)")
    .argument("<origin>")
    .option("--json", "JSON output")
    .option("--db <path>", "ledger path")
    .action((origin: string, opts: Record<string, unknown>) => {
      const l = new Ledger(typeof opts.db === "string" ? opts.db : defaultLedgerPath());
      try {
        out(renderCard(l, origin, opts.json ? "json" : "md"));
      } finally {
        l.close();
      }
    });

  root
    .command("scan")
    .description("Scan a skill folder before installing it: hosts, uploads, credential reads")
    .argument("<path>")
    .option("--json", "JSON output")
    .action(async (p: string, opts: Record<string, unknown>) => {
      const { scanSkillFolder } = await import("./install-scan.js");
      const { classifyHost } = await import("./classify.js");
      const { DEFAULT_CONFIG } = await import("./types.js");
      const r = scanSkillFolder(p, (h) => classifyHost(h, DEFAULT_CONFIG) === "suspicious");
      if (opts.json) {
        out(JSON.stringify(r, null, 2));
        return;
      }
      const lines = [`${r.verdict.toUpperCase()} — ${r.filesScanned} files, ${r.hosts.length} host(s): ${r.hosts.join(", ") || "none"}`];
      for (const f of r.findings) {
        lines.push(`  ${f.file}:${f.line}  ${f.host ? `${f.method} ${f.host}` : "(no host)"}${f.upload ? " [upload]" : ""}${f.sensitiveRead ? " [sensitive-read]" : ""}  ${f.snippet}`);
      }
      out(lines.join("\n"));
    });

  root
    .command("status")
    .description("Ledger location and counts")
    .option("--db <path>", "ledger path")
    .action((opts: Record<string, unknown>) => {
      const l = new Ledger(typeof opts.db === "string" ? opts.db : defaultLedgerPath());
      try {
        const c = l.counts();
        out(`ledger: ${l.path}\nevents: ${c.events}\norigins: ${c.keys}\nhost pairs: ${c.hosts}`);
      } finally {
        l.close();
      }
    });
}
