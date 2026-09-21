// `openclaw clawphylax …` — reads the ledger; does not need the Gateway.

import { Ledger, defaultLedgerPath } from "./ledger.js";
import { costReport } from "./cost.js";
import { renderTokenUse, tokenUse } from "./tokens.js";
import { circlesCheck, didItWork, explorationCheck, failureReport, othersSolved, riskCheck, stopOrContinue, whatWorked } from "./diagnostics.js";
import { outlookFor, renderOutlook } from "./outlook.js";
import { renderPaths, whichPath } from "./paths.js";
import { getConsent, PACT_TEXT, previewRows, setConsent } from "./share.js";
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
    .command("outlook")
    .description("Will a request to this host work? Diagnosis from observed requests: ok / blocked / rate-limited / site-error / unreachable")
    .argument("<host>")
    .option("--window <minutes>", "look-back window", "60")
    .option("--json", "JSON output")
    .option("--db <path>", "ledger path")
    .action((host: string, opts: Record<string, unknown>) => {
      const l = new Ledger(typeof opts.db === "string" ? opts.db : defaultLedgerPath());
      try {
        const o = outlookFor(l, host, Number(opts.window ?? 60));
        out(opts.json ? JSON.stringify(o, null, 2) : renderOutlook(o));
      } finally {
        l.close();
      }
    });

  const withLedger = (opts: Record<string, unknown>, fn: (l: Ledger) => string) => {
    const l = new Ledger(typeof opts.db === "string" ? opts.db : defaultLedgerPath());
    try {
      out(fn(l));
    } finally {
      l.close();
    }
  };
  const J = (opts: Record<string, unknown>, obj: unknown, t: string) => (opts.json ? JSON.stringify(obj, null, 2) : t);

  root.command("check").description("Did that actually work? Cross-check the last tool call's report against the wire").argument("[toolCallId]").option("--session <key>").option("--json").option("--db <path>").action((id: string | undefined, o: Record<string, unknown>) =>
    withLedger(o, (l) => { const r = didItWork(l, { toolCallId: id, sessionKey: o.session as string | undefined }); return J(o, r, `${r.verdict}: ${r.say}`); }));
  root.command("failures").description("Why do I keep failing? Cluster this session's failures by cause").option("--session <key>").option("--window <minutes>", "look-back", "120").option("--json").option("--db <path>").action((o: Record<string, unknown>) =>
    withLedger(o, (l) => { const r = failureReport(l, { sessionKey: o.session as string | undefined, windowMinutes: Number(o.window ?? 120) }); return J(o, r, `${r.nextQuestion}\n${r.clusters.slice(0, 8).map((x) => `- ${x.tool}${x.host ? "@" + x.host : ""} "${x.signature}" ×${x.count} (${Math.round(x.share * 100)}%)`).join("\n")}`); }));
  root.command("stop").description("Should I stop and ask? Stopping rule for the current session").option("--session <key>").option("--json").option("--db <path>").action((o: Record<string, unknown>) =>
    withLedger(o, (l) => { const r = stopOrContinue(l, { sessionKey: o.session as string | undefined }); return J(o, r, `${r.verdict.toUpperCase()}: ${r.say}`); }));
  root.command("circles").description("Am I going in circles? Repetition in recent tool calls").option("--session <key>").option("--json").option("--db <path>").action((o: Record<string, unknown>) =>
    withLedger(o, (l) => { const r = circlesCheck(l, { sessionKey: o.session as string | undefined }); return J(o, r, `${r.verdict.toUpperCase()}: ${r.say}`); }));
  root.command("explore").description("Do I know enough to act? Gathering vs acting in the session").option("--session <key>").option("--json").option("--db <path>").action((o: Record<string, unknown>) =>
    withLedger(o, (l) => { const r = explorationCheck(l, { sessionKey: o.session as string | undefined }); return J(o, r, `${r.verdict.toUpperCase()}: ${r.say}`); }));
  root.command("risk").description("Could this get the user banned or charged? Check a host or a command before running it").argument("<target>").option("--json").option("--db <path>").action(async (target: string, o: Record<string, unknown>) => {
    const { DEFAULT_CONFIG } = await import("./types.js");
    withLedger(o, (l) => { const r = riskCheck(l, DEFAULT_CONFIG, /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(target) ? { host: target } : { command: target }); return J(o, r, `${r.verdict.toUpperCase()}: ${r.say}`); });
  });
  root.command("others").description("Has another session already reached this host?").argument("<host>").option("--exclude <session>").option("--json").option("--db <path>").action((host: string, o: Record<string, unknown>) =>
    withLedger(o, (l) => { const r = othersSolved(l, host, { excludeSession: o.exclude as string | undefined }); return J(o, r, r.say); }));
  root.command("worked").description("What worked on this host? Recipe of successful tool/route combinations").argument("<host>").option("--json").option("--db <path>").action((host: string, o: Record<string, unknown>) =>
    withLedger(o, (l) => { const r = whatWorked(l, host); return J(o, r, r.markdown); }));
  root.command("cost").description("What has this cost so far? Tokens and cost from session transcripts (no ledger needed)").option("--window <minutes>").option("--session <id>").option("--json").action((o: Record<string, unknown>) => {
    const r = costReport({ windowMinutes: o.window ? Number(o.window) : undefined, sessionId: o.session as string | undefined });
    out(J(o, r, `${r.say}\n${r.sessions.slice(0, 10).map((s) => `- ${s.agent}/${s.sessionId.slice(0, 8)}  ${s.totalTokens.toLocaleString()} tok  ${s.cost ? "$" + s.cost.toFixed(4) : "-"}  ${s.toolCalls} tool calls`).join("\n")}`));
  });
  root.command("tokens").description("Am I using too many tokens? Act / gather / repeat / deliberate from the current transcript").option("--window <minutes>").option("--session <id>").option("--json").action((o: Record<string, unknown>) => {
    const t = tokenUse({ windowMinutes: o.window ? Number(o.window) : undefined, sessionId: o.session as string | undefined });
    out(o.json ? JSON.stringify(t ?? {}, null, 2) : renderTokenUse(t));
  });
  root.command("paths").description("Which path is worth it? JSON array of {name,successes,failures,prior,costPerAttempt,valueIfSuccess}").argument("<json>").option("--budget <n>").option("--json").option("--db <path>").action((json: string, o: Record<string, unknown>) =>
    withLedger(o, (l) => { const parsed = JSON.parse(json); const r = whichPath(Array.isArray(parsed) ? parsed : parsed.paths ?? [], { budget: o.budget ? Number(o.budget) : parsed.budget, ledger: l }); return J(o, r, renderPaths(r)); }));
  root.command("share").description("Data Pact: status | preview | on | off | pact (nothing leaves the machine in this version)").argument("[action]").option("--db <path>").action((action: string | undefined, o: Record<string, unknown>) =>
    withLedger(o, (l) => {
      const a = action ?? "status";
      if (a === "pact") return PACT_TEXT;
      if (a === "on" || a === "off") { const c = setConsent(l, a === "on"); return `Sharing consent: ${c.on ? "ON (recorded " + c.since + ")" : "OFF"}. Nothing leaves this machine in this version.`; }
      const c = getConsent(l); const rows = previewRows(l, a === "preview" ? 50 : 5);
      return `consent: ${c.on ? "on since " + c.since : "off"} · nothing leaves this machine in this version\nrows that would be shared:\n${rows.map((r) => "  " + JSON.stringify(r)).join("\n") || "  (none yet)"}\n\nopenclaw clawphylax share pact  — the rules`;
    }));

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
