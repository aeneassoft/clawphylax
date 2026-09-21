// One-off patch for 0.3.0: register diagnostics tools, /phylax subcommands,
// CLI subcommands, manifest tool list, version bump, changelog.
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const rd = (f) => fs.readFileSync(path.join(root, f), "utf8");
const wr = (f, s) => fs.writeFileSync(path.join(root, f), s);
function must(s, from, to, label) {
  if (!s.includes(from)) throw new Error("anchor not found: " + label);
  return s.replace(from, to);
}

// ---------------------------------------------------------------- index.ts
let s = rd("src/index.ts");
s = must(s, `import { outlookFor, renderOutlook } from "./outlook.js";`, `import { costReport } from "./cost.js";
import { circlesCheck, explorationCheck, failureReport, othersSolved, riskCheck, stopOrContinue, whatWorked } from "./diagnostics.js";
import { outlookFor, renderOutlook } from "./outlook.js";
import { renderPaths, whichPath, type PathInput } from "./paths.js";
import { getConsent, PACT_TEXT, previewRows, setConsent } from "./share.js";`, "imports");

const TOOLS = `
    // ---- Self-diagnostics: the questions an agent asks itself while troubleshooting.
    const text = (t: string, details: unknown) => ({ content: [{ type: "text", text: t }], details });
    api.registerTool({
      name: "clawphylax_failures",
      description: "Why do I keep failing? Clusters this session's failed tool calls and failed requests by tool, host and error signature, says which single cause explains most of them, and returns a compact trail of the last failures for you to reason about. Use when errors pile up and you are about to retry.",
      parameters: Type.Object({ sessionKey: Type.Optional(Type.String()), windowMinutes: Type.Optional(Type.Number()) }),
      async execute(_id: string, p: { sessionKey?: string; windowMinutes?: number }) {
        const r = failureReport(core.ledger, { sessionKey: p?.sessionKey ?? core.lastSessionKey, windowMinutes: p?.windowMinutes });
        return text(\`\${r.nextQuestion}\\n\\nfailures: \${r.failures} of \${r.attempts} tool calls · clusters: \${r.clusters.slice(0, 5).map((c) => \`\${c.tool}\${c.host ? "@" + c.host : ""} "\${c.signature}" ×\${c.count}\`).join(" | ")}\\ntrail: \${r.trail.map((t) => \`\${t.t} \${t.tool} \${t.hint ?? ""} → \${t.error ?? "?"}\`).join(" ; ")}\`, r);
      },
    });
    api.registerTool({
      name: "clawphylax_stop_or_continue",
      description: "Should I stop and ask the user, change approach, or continue? A stopping rule from this session's attempts: success rate with confidence bounds across distinct approaches, attempts since the last success, and hosts that are refusing you. Use when a task is dragging on or before yet another retry.",
      parameters: Type.Object({ sessionKey: Type.Optional(Type.String()), windowMinutes: Type.Optional(Type.Number()) }),
      async execute(_id: string, p: { sessionKey?: string; windowMinutes?: number }) {
        const r = stopOrContinue(core.ledger, { sessionKey: p?.sessionKey ?? core.lastSessionKey, windowMinutes: p?.windowMinutes });
        return text(\`\${r.verdict.toUpperCase()}: \${r.say}\`, r);
      },
    });
    api.registerTool({
      name: "clawphylax_circles",
      description: "Am I going in circles? Measures repetition in this session's recent tool calls (same call repeated, identical failures, falling success rate) and tells you whether you are on track, repeating yourself, or stuck. Use when you notice you have done something before.",
      parameters: Type.Object({ sessionKey: Type.Optional(Type.String()) }),
      async execute(_id: string, p: { sessionKey?: string }) {
        const r = circlesCheck(core.ledger, { sessionKey: p?.sessionKey ?? core.lastSessionKey });
        return text(\`\${r.verdict.toUpperCase()}: \${r.say}\`, r);
      },
    });
    api.registerTool({
      name: "clawphylax_risk_check",
      description: "Could this action get the user banned, charged, or exposed? Check a host or a shell command BEFORE running it: known drop hosts, hosts currently refusing or rate-limiting you, credential reads combined with uploads, per-call billed APIs, purchase or billing paths. Returns ok / caution / stop with reasons.",
      parameters: Type.Object({ host: Type.Optional(Type.String()), path: Type.Optional(Type.String()), method: Type.Optional(Type.String()), command: Type.Optional(Type.String()) }),
      async execute(_id: string, p: { host?: string; path?: string; method?: string; command?: string }) {
        const r = riskCheck(core.ledger, core.config, p ?? {});
        return text(\`\${r.verdict.toUpperCase()}: \${r.say}\`, r);
      },
    });
    api.registerTool({
      name: "clawphylax_others",
      description: "Has another agent or session on this machine already reached this host successfully? Finds recent successful requests from other sessions (tool, route, status, how long ago) so you can reuse their route or ask that session instead of fetching again.",
      parameters: Type.Object({ host: Type.String(), path: Type.Optional(Type.String()), windowMinutes: Type.Optional(Type.Number()) }),
      async execute(_id: string, p: { host: string; path?: string; windowMinutes?: number }) {
        const r = othersSolved(core.ledger, p.host, { path: p.path, excludeSession: core.lastSessionKey, windowMinutes: p.windowMinutes });
        return text(r.say, r);
      },
    });
    api.registerTool({
      name: "clawphylax_exploration",
      description: "Do I know enough to act? Compares gathering calls (search, fetch, read) with acting calls (exec, write, message) in this session, counts distinct sources, and says whether you are acting blind, still exploring, or balanced.",
      parameters: Type.Object({ sessionKey: Type.Optional(Type.String()) }),
      async execute(_id: string, p: { sessionKey?: string }) {
        const r = explorationCheck(core.ledger, { sessionKey: p?.sessionKey ?? core.lastSessionKey });
        return text(\`\${r.verdict.toUpperCase()}: \${r.say}\`, r);
      },
    });
    api.registerTool({
      name: "clawphylax_what_worked",
      description: "What worked on this host, and how do I do it again? Ranks the tool, method and route combinations that succeeded on a host (with lower bounds and latency) and returns a recipe you can turn into a skill or a witness card.",
      parameters: Type.Object({ host: Type.String() }),
      async execute(_id: string, p: { host: string }) {
        const r = whatWorked(core.ledger, p.host);
        return text(r.markdown, r);
      },
    });
    api.registerTool({
      name: "clawphylax_cost",
      description: "What has this cost so far? Token usage and provider cost from OpenClaw's own session transcripts: per session, per model, per tool call, over a time window. Use before deciding whether another attempt is worth it, or when the user asks why the bill is high.",
      parameters: Type.Object({ windowMinutes: Type.Optional(Type.Number()), sessionId: Type.Optional(Type.String()) }),
      async execute(_id: string, p: { windowMinutes?: number; sessionId?: string }) {
        const r = costReport({ windowMinutes: p?.windowMinutes, sessionId: p?.sessionId });
        return text(r.say, r);
      },
    });
    api.registerTool({
      name: "clawphylax_which_path",
      description: "Which path is worth it? Given several research or action paths with what you know (successes, failures, prior, cost per attempt, value on success), computes for each the success probability with bounds, expected value per attempt, the safe value (lower bound) and the optimistic value (upper bound), and recommends exploit / explore / fold with a plan. Paths named by hostname pull their observed outcomes from the ledger automatically.",
      parameters: Type.Object({
        paths: Type.Array(
          Type.Object({
            name: Type.String(),
            successes: Type.Optional(Type.Number()),
            failures: Type.Optional(Type.Number()),
            prior: Type.Optional(Type.Number()),
            priorStrength: Type.Optional(Type.Number()),
            costPerAttempt: Type.Optional(Type.Number()),
            valueIfSuccess: Type.Optional(Type.Number()),
          }),
        ),
        budget: Type.Optional(Type.Number()),
      }),
      async execute(_id: string, p: { paths: PathInput[]; budget?: number }) {
        const r = whichPath(p.paths ?? [], { budget: p.budget, ledger: core.ledger });
        return text(renderPaths(r), r);
      },
    });
    api.registerTool({
      name: "clawphylax_share",
      description: "The ClawPhylax Data Pact: what opt-in sharing of request outcomes would send (six hashed fields), what contributors get back, and the rules. Shows the exact rows that would leave this machine. Nothing is uploaded in this version; the switch records consent only. Use when the user asks about data sharing or privacy.",
      parameters: Type.Object({ action: Type.Optional(Type.String({ description: "status (default) | preview | on | off | pact" })) }),
      async execute(_id: string, p: { action?: string }) {
        const a = p?.action ?? "status";
        if (a === "pact") return text(PACT_TEXT, { pact: PACT_TEXT });
        if (a === "on" || a === "off") {
          const c = setConsent(core.ledger, a === "on");
          return text(\`Sharing consent: \${c.on ? "ON (recorded " + c.since + ")" : "OFF"}. Nothing leaves this machine in this version.\`, c);
        }
        const c = getConsent(core.ledger);
        const rows = previewRows(core.ledger, 10);
        return text(\`consent: \${c.on ? "on since " + c.since : "off"} · nothing leaves this machine in this version.\\nrows that would be shared (last \${rows.length}): \${JSON.stringify(rows)}\`, { consent: c, rows });
      },
    });
`;
s = must(s, `    api.registerTool({
      name: "clawphylax_scan",`, TOOLS + `    api.registerTool({
      name: "clawphylax_scan",`, "tools");

// /phylax subcommands
s = must(s, `          if (sub === "outlook" && arg) {
            return { text: renderOutlook(outlookFor(core.ledger, arg, 60)) };
          }`, `          if (sub === "outlook" && arg) {
            return { text: renderOutlook(outlookFor(core.ledger, arg, 60)) };
          }
          if (sub === "failures") {
            const r = failureReport(core.ledger, { sessionKey: ctx?.sessionKey ?? core.lastSessionKey });
            return { text: \`\${r.nextQuestion}\\n\${r.clusters.slice(0, 5).map((c) => \`- \${c.tool}\${c.host ? "@" + c.host : ""} "\${c.signature}" ×\${c.count}\`).join("\\n")}\` };
          }
          if (sub === "stop") {
            const r = stopOrContinue(core.ledger, { sessionKey: ctx?.sessionKey ?? core.lastSessionKey });
            return { text: \`\${r.verdict.toUpperCase()}: \${r.say}\` };
          }
          if (sub === "circles") {
            const r = circlesCheck(core.ledger, { sessionKey: ctx?.sessionKey ?? core.lastSessionKey });
            return { text: \`\${r.verdict.toUpperCase()}: \${r.say}\` };
          }
          if (sub === "risk" && arg) {
            const r = riskCheck(core.ledger, core.config, /^[a-z0-9.-]+\\.[a-z]{2,}$/i.test(arg) ? { host: arg } : { command: arg });
            return { text: \`\${r.verdict.toUpperCase()}: \${r.say}\` };
          }
          if (sub === "others" && arg) {
            return { text: othersSolved(core.ledger, arg, { excludeSession: ctx?.sessionKey ?? core.lastSessionKey }).say };
          }
          if (sub === "explore") {
            const r = explorationCheck(core.ledger, { sessionKey: ctx?.sessionKey ?? core.lastSessionKey });
            return { text: \`\${r.verdict.toUpperCase()}: \${r.say}\` };
          }
          if (sub === "worked" && arg) {
            return { text: whatWorked(core.ledger, arg).markdown };
          }
          if (sub === "cost") {
            return { text: costReport({ windowMinutes: arg ? Number(arg) : undefined }).say };
          }
          if (sub === "paths" && arg) {
            try {
              const parsed = JSON.parse(arg);
              return { text: renderPaths(whichPath(Array.isArray(parsed) ? parsed : parsed.paths ?? [], { budget: parsed.budget, ledger: core.ledger })) };
            } catch {
              return { text: 'Usage: /phylax paths [{"name":"official-api","successes":3,"failures":1,"costPerAttempt":1,"valueIfSuccess":10}, ...]' };
            }
          }
          if (sub === "share") {
            if (arg === "pact") return { text: PACT_TEXT };
            if (arg === "on" || arg === "off") {
              const c = setConsent(core.ledger, arg === "on");
              return { text: \`Sharing consent: \${c.on ? "ON" : "OFF"}. Nothing leaves this machine in this version. /phylax share pact shows the rules.\` };
            }
            const c = getConsent(core.ledger);
            return { text: \`Sharing consent: \${c.on ? "on since " + c.since : "off"} · nothing leaves this machine in this version.\\nRows that would be shared: \${JSON.stringify(previewRows(core.ledger, 5))}\\n/phylax share pact | on | off\` };
          }`, "phylax subcommands");
s = must(s, `return { text: "Usage: /phylax [report [24h]] | outlook <host> | scan <folder> | hosts <origin> | card <origin>" };`,
  `return { text: "Usage: /phylax [report [24h]] | outlook <host> | failures | stop | circles | explore | risk <host|command> | others <host> | worked <host> | cost [minutes] | paths <json> | scan <folder> | hosts <origin> | card <origin> | share [pact|on|off]" };`, "usage");
s = must(s, `      handler: async (ctx: any) => {
        try {
          const args = String(ctx?.args ?? "").trim();`, `      handler: async (ctx: any) => {
        try {
          if (ctx?.sessionKey) {
            core.lastSessionKey = ctx.sessionKey;
          }
          const args = String(ctx?.args ?? "").trim();`, "handler session");
s = must(s, `and how long to wait.",`, `and how long to wait. When errors pile up, /phylax failures groups them by cause; when a task drags on, /phylax stop says whether to continue, change approach, or stop and ask the user; /phylax circles tells you if you are repeating yourself; /phylax risk <host or command> checks before an action whether it could get the user banned or charged.",`, "guidance");
wr("src/index.ts", s);

// ---------------------------------------------------------------- cli.ts
let c = rd("src/cli.ts");
c = must(c, `import { outlookFor, renderOutlook } from "./outlook.js";`, `import { costReport } from "./cost.js";
import { circlesCheck, explorationCheck, failureReport, othersSolved, riskCheck, stopOrContinue, whatWorked } from "./diagnostics.js";
import { outlookFor, renderOutlook } from "./outlook.js";
import { renderPaths, whichPath } from "./paths.js";
import { getConsent, PACT_TEXT, previewRows, setConsent } from "./share.js";`, "cli imports");
c = must(c, `  root
    .command("card")`, `  const withLedger = (opts: Record<string, unknown>, fn: (l: Ledger) => string) => {
    const l = new Ledger(typeof opts.db === "string" ? opts.db : defaultLedgerPath());
    try {
      out(fn(l));
    } finally {
      l.close();
    }
  };
  const J = (opts: Record<string, unknown>, obj: unknown, t: string) => (opts.json ? JSON.stringify(obj, null, 2) : t);

  root.command("failures").description("Why do I keep failing? Cluster this session's failures by cause").option("--session <key>").option("--window <minutes>", "look-back", "120").option("--json").option("--db <path>").action((o: Record<string, unknown>) =>
    withLedger(o, (l) => { const r = failureReport(l, { sessionKey: o.session as string | undefined, windowMinutes: Number(o.window ?? 120) }); return J(o, r, \`\${r.nextQuestion}\\n\${r.clusters.slice(0, 8).map((x) => \`- \${x.tool}\${x.host ? "@" + x.host : ""} "\${x.signature}" ×\${x.count} (\${Math.round(x.share * 100)}%)\`).join("\\n")}\`); }));
  root.command("stop").description("Should I stop and ask? Stopping rule for the current session").option("--session <key>").option("--json").option("--db <path>").action((o: Record<string, unknown>) =>
    withLedger(o, (l) => { const r = stopOrContinue(l, { sessionKey: o.session as string | undefined }); return J(o, r, \`\${r.verdict.toUpperCase()}: \${r.say}\`); }));
  root.command("circles").description("Am I going in circles? Repetition in recent tool calls").option("--session <key>").option("--json").option("--db <path>").action((o: Record<string, unknown>) =>
    withLedger(o, (l) => { const r = circlesCheck(l, { sessionKey: o.session as string | undefined }); return J(o, r, \`\${r.verdict.toUpperCase()}: \${r.say}\`); }));
  root.command("explore").description("Do I know enough to act? Gathering vs acting in the session").option("--session <key>").option("--json").option("--db <path>").action((o: Record<string, unknown>) =>
    withLedger(o, (l) => { const r = explorationCheck(l, { sessionKey: o.session as string | undefined }); return J(o, r, \`\${r.verdict.toUpperCase()}: \${r.say}\`); }));
  root.command("risk").description("Could this get the user banned or charged? Check a host or a command before running it").argument("<target>").option("--json").option("--db <path>").action(async (target: string, o: Record<string, unknown>) => {
    const { DEFAULT_CONFIG } = await import("./types.js");
    withLedger(o, (l) => { const r = riskCheck(l, DEFAULT_CONFIG, /^[a-z0-9.-]+\\.[a-z]{2,}$/i.test(target) ? { host: target } : { command: target }); return J(o, r, \`\${r.verdict.toUpperCase()}: \${r.say}\`); });
  });
  root.command("others").description("Has another session already reached this host?").argument("<host>").option("--exclude <session>").option("--json").option("--db <path>").action((host: string, o: Record<string, unknown>) =>
    withLedger(o, (l) => { const r = othersSolved(l, host, { excludeSession: o.exclude as string | undefined }); return J(o, r, r.say); }));
  root.command("worked").description("What worked on this host? Recipe of successful tool/route combinations").argument("<host>").option("--json").option("--db <path>").action((host: string, o: Record<string, unknown>) =>
    withLedger(o, (l) => { const r = whatWorked(l, host); return J(o, r, r.markdown); }));
  root.command("cost").description("What has this cost so far? Tokens and cost from session transcripts (no ledger needed)").option("--window <minutes>").option("--session <id>").option("--json").action((o: Record<string, unknown>) => {
    const r = costReport({ windowMinutes: o.window ? Number(o.window) : undefined, sessionId: o.session as string | undefined });
    out(J(o, r, \`\${r.say}\\n\${r.sessions.slice(0, 10).map((s) => \`- \${s.agent}/\${s.sessionId.slice(0, 8)}  \${s.totalTokens.toLocaleString()} tok  \${s.cost ? "$" + s.cost.toFixed(4) : "-"}  \${s.toolCalls} tool calls\`).join("\\n")}\`));
  });
  root.command("paths").description("Which path is worth it? JSON array of {name,successes,failures,prior,costPerAttempt,valueIfSuccess}").argument("<json>").option("--budget <n>").option("--json").option("--db <path>").action((json: string, o: Record<string, unknown>) =>
    withLedger(o, (l) => { const parsed = JSON.parse(json); const r = whichPath(Array.isArray(parsed) ? parsed : parsed.paths ?? [], { budget: o.budget ? Number(o.budget) : parsed.budget, ledger: l }); return J(o, r, renderPaths(r)); }));
  root.command("share").description("Data Pact: status | preview | on | off | pact (nothing leaves the machine in this version)").argument("[action]").option("--db <path>").action((action: string | undefined, o: Record<string, unknown>) =>
    withLedger(o, (l) => {
      const a = action ?? "status";
      if (a === "pact") return PACT_TEXT;
      if (a === "on" || a === "off") { const c = setConsent(l, a === "on"); return \`Sharing consent: \${c.on ? "ON (recorded " + c.since + ")" : "OFF"}. Nothing leaves this machine in this version.\`; }
      const c = getConsent(l); const rows = previewRows(l, a === "preview" ? 50 : 5);
      return \`consent: \${c.on ? "on since " + c.since : "off"} · nothing leaves this machine in this version\\nrows that would be shared:\\n\${rows.map((r) => "  " + JSON.stringify(r)).join("\\n") || "  (none yet)"}\\n\\nopenclaw clawphylax share pact  — the rules\`;
    }));

  root
    .command("card")`, "cli commands");
wr("src/cli.ts", c);

// cli test: expected subcommand list
let t = rd("src/cli.test.ts");
t = must(t, `["clawphylax allow", "clawphylax card", "clawphylax deny", "clawphylax export", "clawphylax hosts", "clawphylax outlook", "clawphylax recent", "clawphylax report", "clawphylax rules", "clawphylax scan", "clawphylax status"].sort(),`,
  `["clawphylax allow", "clawphylax card", "clawphylax circles", "clawphylax cost", "clawphylax deny", "clawphylax explore", "clawphylax export", "clawphylax failures", "clawphylax hosts", "clawphylax others", "clawphylax outlook", "clawphylax paths", "clawphylax recent", "clawphylax report", "clawphylax risk", "clawphylax rules", "clawphylax scan", "clawphylax share", "clawphylax status", "clawphylax stop", "clawphylax worked"].sort(),`, "cli test list");
wr("src/cli.test.ts", t);

// ---------------------------------------------------------------- manifest / versions / changelog
const m = JSON.parse(rd("openclaw.plugin.json"));
m.version = "0.3.0";
m.contracts.tools = ["clawphylax_report", "clawphylax_hosts", "clawphylax_scan", "clawphylax_card", "clawphylax_outlook", "clawphylax_failures", "clawphylax_stop_or_continue", "clawphylax_circles", "clawphylax_risk_check", "clawphylax_others", "clawphylax_exploration", "clawphylax_what_worked", "clawphylax_cost", "clawphylax_which_path", "clawphylax_share"];
m.description = "Skill safety and agent self-diagnostics for OpenClaw: verify skills before install, see where installed skills send data, and let the agent ask itself the troubleshooting questions — will this request work, why do I keep failing, should I stop and ask, am I going in circles, could this get the user banned, what has this cost, which path is worth it. Local ledger, no cloud, observe-only by default.";
wr("openclaw.plugin.json", JSON.stringify(m, null, 2) + "\n");
const p = JSON.parse(rd("package.json")); p.version = "0.3.0"; p.description = m.description; wr("package.json", JSON.stringify(p, null, 2) + "\n");
let r = rd("src/report.ts"); r = r.replace('plugin: "clawphylax@0.2.0"', 'plugin: "clawphylax@0.3.0"'); wr("src/report.ts", r);
let ch = rd("CHANGELOG.md");
ch = ch.replace("# Changelog\n", `# Changelog

## 0.3.0 — 2026-09-21

- **Self-diagnostics for agents** (tools, \`/phylax\` subcommands, CLI): \`failures\` (why do I keep failing — error clusters and a trail), \`stop\` (should I stop and ask — a stopping rule on bounds), \`circles\` (am I going in circles), \`explore\` (do I know enough to act), \`risk\` (could this get the user banned or charged — pre-action check), \`others\` (has another session already reached this host), \`worked\` (what worked here — recipe), \`cost\` (what has this cost so far — from session transcripts, no ledger needed).
- **Which path is worth it** (\`clawphylax_which_path\`, \`/phylax paths\`): Beta posterior per path, safe/optimistic value, exploit / explore / fold with a plan; hosts pull their outcomes from the ledger.
- **Data Pact** (\`share\`): the opt-in rules, the six hashed fields, a preview of the exact rows; consent recorded locally. Nothing is uploaded in this version.
- Tool outcomes (ok/error/duration/arg hint) are now recorded per session, which the diagnostics run on.
- Nine new skills phrased as the questions agents ask themselves.
`);
wr("CHANGELOG.md", ch);
console.log("wired 0.3.0");
