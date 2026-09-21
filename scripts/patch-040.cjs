// 0.4.0: "did that actually work?" + decision records (ACTION first) + OpenAI-informed descriptions/guidance.
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const rd = (f) => fs.readFileSync(path.join(root, f), "utf8");
const wr = (f, s) => fs.writeFileSync(path.join(root, f), s);
function must(s, from, to, label) {
  if (!s.includes(from)) throw new Error("anchor not found: " + label);
  return s.replace(from, to);
}

// ------------------------------------------------------------------ ledger
let l = rd("src/ledger.ts");
l = must(l, `  eventsForHost(host: string, sinceTs = 0, limit = 500): EgressEvent[] {`, `  eventsForToolCall(toolCallId: string): EgressEvent[] {
    return (this.db.prepare("SELECT * FROM events WHERE tool_call_id = ? ORDER BY ts").all(toolCallId) as any[]).map(rowToEvent);
  }

  eventsForHost(host: string, sinceTs = 0, limit = 500): EgressEvent[] {`, "ledger eventsForToolCall");
wr("src/ledger.ts", l);

// ------------------------------------------------------------- diagnostics
let d = rd("src/diagnostics.ts");
d += `
// ------------------------------------------------------ did that actually work

export type DidItWork = {
  toolCallId?: string;
  tool?: string;
  hint?: string;
  reported: "ok" | "error" | "unknown";
  observed: Array<{ method: string; host: string; path?: string; status?: number; bytesIn?: number; bytesOut?: number }>;
  verdict: "CONFIRMED" | "SILENT_FAILURE" | "UNVERIFIED" | "FAILED" | "NO_CALL";
  mismatch?: string;
  say: string;
};

/**
 * Cross-check what the tool reported against what the wire showed for the
 * same tool call. The class that costs agents most is the silent failure:
 * the tool says ok, the transport says 4xx/5xx/error/empty.
 */
export function didItWork(ledger: Ledger, opts: { toolCallId?: string; sessionKey?: string } = {}): DidItWork {
  let outcome: ToolOutcome | undefined;
  if (opts.toolCallId) {
    outcome = ledger.toolOutcomes({ sessionKey: opts.sessionKey, limit: 200 }).find((o) => o.toolCallId === opts.toolCallId);
  } else {
    // Skip our own diagnostic tools: the agent wants the last *action*.
    outcome = ledger.toolOutcomes({ sessionKey: resolveSessionKey(ledger, opts.sessionKey), limit: 50 }).find((o) => !o.toolName.startsWith("clawphylax_"));
  }
  if (!outcome) {
    return { reported: "unknown", observed: [], verdict: "NO_CALL", say: "No tool call recorded yet in this session." };
  }
  const events = outcome.toolCallId ? ledger.eventsForToolCall(outcome.toolCallId) : [];
  const observed = events
    .filter((e) => e.source === "inproc")
    .map((e) => ({ method: e.method, host: e.host, path: e.path, status: e.status, bytesIn: e.bytesIn, bytesOut: e.bytesOut }));
  const reported: DidItWork["reported"] = outcome.ok ? "ok" : "error";
  const bad = observed.filter((o) => typeof o.status !== "number" || o.status >= 400);
  const emptyOk = observed.filter((o) => typeof o.status === "number" && o.status < 400 && o.method === "GET" && o.bytesIn === 0);
  const writes = observed.filter((o) => o.method !== "GET" && o.method !== "HEAD");
  const execTargets = outcome.toolName === "exec" || outcome.toolName === "bash" ? analyzeExecCommand(outcome.argHint ?? "").targets : [];

  let verdict: DidItWork["verdict"];
  let mismatch: string | undefined;
  if (reported === "error") {
    verdict = "FAILED";
  } else if (bad.length) {
    verdict = "SILENT_FAILURE";
    const b = bad[0];
    mismatch = \`\${outcome.toolName} reported ok, but \${b.method} \${b.host}\${b.path ?? ""} returned \${typeof b.status === "number" ? b.status : "no response"}\${bad.length > 1 ? \` (+\${bad.length - 1} more)\` : ""}\`;
  } else if (emptyOk.length) {
    verdict = "SILENT_FAILURE";
    mismatch = \`\${outcome.toolName} reported ok, but GET \${emptyOk[0].host}\${emptyOk[0].path ?? ""} returned \${emptyOk[0].status} with an empty body\`;
  } else if (observed.length) {
    verdict = "CONFIRMED";
  } else if (execTargets.length) {
    verdict = "UNVERIFIED";
    mismatch = \`exec reported ok; its network target \${execTargets.map((t) => t.host).join(", ")} ran in a child process, which this ledger cannot observe\`;
  } else {
    verdict = outcome.ok ? "UNVERIFIED" : "FAILED";
  }
  const tool = outcome.toolName;
  const say =
    verdict === "CONFIRMED"
      ? \`Confirmed: \${tool} reported ok and the wire agrees — \${observed.length} request(s), all \${observed.map((o) => o.status).join("/")}\${writes.length ? \`, \${writes.length} write(s) acknowledged\` : ""}. Build on it.\`
      : verdict === "SILENT_FAILURE"
        ? \`Silent failure: \${mismatch}. Do not build on this result; treat the action as not done. Run the outlook for that host before retrying.\`
        : verdict === "UNVERIFIED"
          ? \`Unverified: \${mismatch ?? \`\${tool} reported ok but made no observable request\`}. If the effect matters, verify it directly (fetch the resource, list the file, read the reply) before building on it.\`
          : verdict === "FAILED"
            ? \`Failed: \${tool} reported an error\${outcome.errorText ? \` — \${outcome.errorText.slice(0, 140)}\` : ""}. Nothing to build on.\`
            : "No tool call recorded.";
  return { toolCallId: outcome.toolCallId, tool, hint: outcome.argHint, reported, observed, verdict, mismatch, say };
}
`;
wr("src/diagnostics.ts", d);

// ------------------------------------------------------------------ index.ts
let s = rd("src/index.ts");
s = must(s, `import { circlesCheck, explorationCheck, failureReport, othersSolved, riskCheck, stopOrContinue, whatWorked } from "./diagnostics.js";`,
  `import { circlesCheck, didItWork, explorationCheck, failureReport, othersSolved, riskCheck, stopOrContinue, whatWorked } from "./diagnostics.js";
import { renderRecord, SCOPE_LOCAL } from "./record.js";`, "imports");

// Decision-record renderers (ACTION first) for the tools the model acts on.
s = must(s, `    // ---- Self-diagnostics: the questions an agent asks itself while troubleshooting.
    const text = (t: string, details: unknown) => ({ content: [{ type: "text", text: t }], details });`,
`    // ---- Self-diagnostics: the questions an agent asks itself while troubleshooting.
    const text = (t: string, details: unknown) => ({ content: [{ type: "text", text: t }], details });
    const pct = (x: number) => \`\${Math.round(x * 100)}%\`;
    const outlookRecord = (o: ReturnType<typeof outlookFor>) =>
      renderRecord({
        action: ({ ok: "RETRY_AFTER_FIXING_REQUEST", blocked: "STOP", "rate-limited": "BACKOFF", "site-error": "BACKOFF", unreachable: "BACKOFF", unreliable: "SWITCH_TOOL", "no-history": "TRY_ONCE" } as Record<string, string>)[o.diagnosis],
        evidence: \`\${o.host}: \${o.successes}/\${o.n} succeeded\${o.windowMinutes ? \` in \${o.windowMinutes} min\` : " all-time"}; recent statuses \${o.recentStatuses.join(" ")}\${o.byTool.length > 1 ? \`; by tool \${o.byTool.map((t) => \`\${t.tool} \${t.successes}/\${t.n}\`).join(", ")}\` : ""}\`,
        doNot: o.diagnosis === "blocked" ? \`retry \${o.host} with the same tool or credentials\` : o.diagnosis === "rate-limited" ? \`send parallel or immediate requests to \${o.host}\` : o.diagnosis === "site-error" || o.diagnosis === "unreachable" ? "reword the request; the host, not the request, is failing" : o.diagnosis === "unreliable" ? \`keep using the failing tool on \${o.host}\` : undefined,
        next: o.recommendation + (o.backoffSeconds ? \` Wait \${o.backoffSeconds}s first.\` : "") + (o.bestTool ? \` Prefer \${o.bestTool}.\` : ""),
        confidence: o.n ? \`P(next attempt succeeds) ≈ \${pct(o.pNext)}, 95% bounds \${pct(o.pLower)}–\${pct(o.pUpper)}, \${o.confidence}\` : "none yet",
        scope: \`\${o.host}, \${SCOPE_LOCAL}\`,
      });
    const stopRecord = (r: ReturnType<typeof stopOrContinue>) =>
      renderRecord({
        action: r.verdict.toUpperCase().replace(/-/g, "_"),
        evidence: \`\${r.successes}/\${r.attempts} tool calls succeeded across \${r.distinctApproaches} approach(es) in \${r.minutesElapsed} min; last success \${r.lastSuccessAgoAttempts === null ? "never" : r.lastSuccessAgoAttempts + " attempt(s) ago"}\${r.blockedHosts.length ? \`; refusing hosts: \${r.blockedHosts.join(", ")}\` : ""}\`,
        doNot: r.verdict === "stop-and-ask" ? "continue silently or retry the same approach" : r.verdict === "change-approach" ? "repeat the same tool and route" : undefined,
        next: r.say,
        confidence: r.attempts ? \`success-rate upper bound \${pct(r.successUpper)}\` : "none yet",
        scope: SCOPE_LOCAL,
      });`, "record helpers");

// Replace tool bodies: outlook + stop + didit
s = must(s, `        const o = outlookFor(core.ledger, params.host, params.windowMinutes ?? 60);
        return { content: [{ type: "text", text: renderOutlook(o) }], details: o };`,
  `        const o = outlookFor(core.ledger, params.host, params.windowMinutes ?? 60);
        return { content: [{ type: "text", text: outlookRecord(o) + "\\n" + renderOutlook(o) }], details: o };`, "outlook tool");
s = must(s, `        const r = stopOrContinue(core.ledger, { sessionKey: p?.sessionKey ?? core.lastSessionKey, windowMinutes: p?.windowMinutes });
        return text(\`\${r.verdict.toUpperCase()}: \${r.say}\`, r);`,
  `        const r = stopOrContinue(core.ledger, { sessionKey: p?.sessionKey ?? core.lastSessionKey, windowMinutes: p?.windowMinutes });
        return text(stopRecord(r), r);`, "stop tool");
// The outlook tool is registered before the record helpers are defined? Ensure helpers are defined before use: they are consts inside register(); registration bodies run later, so order is fine.

s = must(s, `    api.registerTool({
      name: "clawphylax_failures",`, `    api.registerTool({
      name: "clawphylax_did_it_work",
      description:
        "Did that actually work? Use this after any tool call whose effect matters — an exec, a write, a POST, a message, a fetch — before building on its result. Cross-checks what the tool reported (ok/error) against what the wire showed for that same tool call: status codes, empty bodies, unsent uploads. Returns exactly one of CONFIRMED, SILENT_FAILURE, UNVERIFIED, FAILED, with the mismatch named. Do not use for reads you will not act on.",
      parameters: Type.Object({ toolCallId: Type.Optional(Type.String({ description: "Defaults to the last non-diagnostic tool call in this session." })), sessionKey: Type.Optional(Type.String()) }),
      async execute(_id: string, p: { toolCallId?: string; sessionKey?: string }) {
        const r = didItWork(core.ledger, { toolCallId: p?.toolCallId, sessionKey: p?.sessionKey ?? core.lastSessionKey });
        return text(
          renderRecord({
            action: r.verdict === "CONFIRMED" ? "BUILD_ON_IT" : r.verdict === "SILENT_FAILURE" ? "TREAT_AS_NOT_DONE" : r.verdict === "UNVERIFIED" ? "VERIFY_DIRECTLY" : r.verdict === "FAILED" ? "FIX_THEN_RETRY" : "NONE",
            evidence: \`\${r.tool ?? "no tool"} reported \${r.reported}\${r.hint ? \` (\${r.hint.slice(0, 80)})\` : ""}; wire: \${r.observed.length ? r.observed.map((o) => \`\${o.method} \${o.host} → \${o.status ?? "no response"}\${typeof o.bytesIn === "number" ? \` \${o.bytesIn}B\` : ""}\`).join(", ") : "no observable request"}\`,
            doNot: r.verdict === "SILENT_FAILURE" ? "proceed as if the action succeeded" : r.verdict === "UNVERIFIED" ? "assume the effect happened" : undefined,
            next: r.say,
            scope: SCOPE_LOCAL,
          }),
          r,
        );
      },
    });
    api.registerTool({
      name: "clawphylax_failures",`, "didit tool");

// /phylax subcommand + usage + guidance (OpenAI-informed)
s = must(s, `          if (sub === "failures") {`, `          if (sub === "check" || sub === "didit") {
            const r = didItWork(core.ledger, { toolCallId: arg || undefined, sessionKey: ctx?.sessionKey ?? core.lastSessionKey });
            return { text: \`\${r.verdict}: \${r.say}\` };
          }
          if (sub === "failures") {`, "phylax check");
s = must(s, `| outlook <host> | failures |`, `| outlook <host> | check [toolCallId] | failures |`, "usage");
s = s.replace(/agentPromptGuidance: \[\n\s+"[^"]*",\n\s+\],/, `agentPromptGuidance: [
        "Before installing any third-party skill, run clawphylax_scan on it; before retrying a failed request, run clawphylax_outlook on the host; when a task repeats, stalls, or produces no new evidence, run clawphylax_stop_or_continue; after any action whose effect matters, run clawphylax_did_it_work before building on the result. Before any action that could expose data, incur cost, change external state, or risk an account restriction, run clawphylax_risk_check; follow the returned ACTION and do not repeat an approach it prohibits.",
      ],`);
if (!s.includes("clawphylax_did_it_work before building")) throw new Error("guidance not replaced");
wr("src/index.ts", s);

// -------------------------------------------------------------------- cli.ts
let c = rd("src/cli.ts");
c = must(c, `import { circlesCheck, explorationCheck, failureReport, othersSolved, riskCheck, stopOrContinue, whatWorked } from "./diagnostics.js";`,
  `import { circlesCheck, didItWork, explorationCheck, failureReport, othersSolved, riskCheck, stopOrContinue, whatWorked } from "./diagnostics.js";`, "cli import");
c = must(c, `  root.command("failures")`, `  root.command("check").description("Did that actually work? Cross-check the last tool call's report against the wire").argument("[toolCallId]").option("--session <key>").option("--json").option("--db <path>").action((id: string | undefined, o: Record<string, unknown>) =>
    withLedger(o, (l) => { const r = didItWork(l, { toolCallId: id, sessionKey: o.session as string | undefined }); return J(o, r, \`\${r.verdict}: \${r.say}\`); }));
  root.command("failures")`, "cli check");
wr("src/cli.ts", c);
let t = rd("src/cli.test.ts");
t = must(t, `"clawphylax card", "clawphylax circles"`, `"clawphylax card", "clawphylax check", "clawphylax circles"`, "cli test");
wr("src/cli.test.ts", t);

// ------------------------------------------------------- report.ts footer: silent failures
let r = rd("src/report.ts");
r = must(r, `export function renderRunFooter(events: EgressEvent[]): string | undefined {
  const external = events.filter((e) => e.category !== "model" && e.category !== "local" && e.category !== "channel");
  if (!external.length) {
    return undefined;
  }`, `export function renderRunFooter(events: EgressEvent[]): string | undefined {
  const silent = events.filter((e) => e.source === "inproc" && e.attribution.toolCallId && (typeof e.status !== "number" || e.status >= 400));
  const external = events.filter((e) => e.category !== "model" && e.category !== "local" && e.category !== "channel");
  if (!external.length && !silent.length) {
    return undefined;
  }
  if (!external.length) {
    const f = silent[0];
    return \`🛡 ClawPhylax: STOP CONDITION — \${f.attribution.toolName ?? "a tool"} made \${f.method} \${f.host} which returned \${typeof f.status === "number" ? f.status : "no response"}. Do not build on that result; run /phylax check.\`;
  }`, "footer silent");
wr("src/report.ts", r);

// ------------------------------------------------------------ versions/changelog
const m = JSON.parse(rd("openclaw.plugin.json"));
m.version = "0.4.0";
if (!m.contracts.tools.includes("clawphylax_did_it_work")) m.contracts.tools.push("clawphylax_did_it_work");
wr("openclaw.plugin.json", JSON.stringify(m, null, 2) + "\n");
const p = JSON.parse(rd("package.json")); p.version = "0.4.0"; wr("package.json", JSON.stringify(p, null, 2) + "\n");
let rp = rd("src/report.ts"); rp = rp.replace('plugin: "clawphylax@0.3.1"', 'plugin: "clawphylax@0.4.0"'); wr("src/report.ts", rp);
let ch = rd("CHANGELOG.md");
ch = ch.replace("# Changelog\n", `# Changelog

## 0.4.0 — 2026-09-21

- **Did that actually work?** (\`clawphylax_did_it_work\`, \`/phylax check\`, \`openclaw clawphylax check\`): cross-checks what a tool reported against what the wire showed for the same tool call — CONFIRMED / SILENT_FAILURE / UNVERIFIED / FAILED, with the mismatch named. The reply footer now raises a STOP CONDITION on silent failures. New skill \`did-that-actually-work\`.
- **Decision records.** Outlook, stop rule and did-it-work answer ACTION-first (ACTION / EVIDENCE / DO NOT / NEXT / CONFIDENCE / SCOPE), the shape a model acts on rather than summarises.
- **Descriptions and guidance rewritten** after consulting OpenAI's gpt-5.6 on how OpenAI-driven agents select and follow tools: trigger first, tool names and status codes, an exact action contract, negative routing; the prompt guidance now requires following the returned ACTION. (See OPENAI_ANTWORT_ANNOTIERT.md in the workspace.)
- Provenance sentence in every skill's "For agents" section: shared authorship is not a safety guarantee; review each skill independently.
`);
wr("CHANGELOG.md", ch);
console.log("0.4.0 patched");
