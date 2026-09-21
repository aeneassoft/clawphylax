// ClawPhylax — OpenClaw plugin entry.
//
// Hook contracts are experimental in OpenClaw; every event is read
// defensively so a field rename in the host degrades to "less attribution",
// never to a crash in the Gateway process.

import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { baselineFor } from "./baseline.js";
import { classifyHost } from "./classify.js";
import { CLI_DESCRIPTOR, registerCli, sinceMs } from "./cli.js";
import { scanSkillFolder } from "./install-scan.js";
import { costReport } from "./cost.js";
import { renderTokenUse, tokenUse } from "./tokens.js";
import { circlesCheck, didItWork, explorationCheck, failureReport, othersSolved, riskCheck, stopOrContinue, whatWorked } from "./diagnostics.js";
import { renderRecord, SCOPE_LOCAL } from "./record.js";
import { compactionBrief, didMessageGoOut, reconcile, renderClaims, sendCheck, taskMatch } from "./messaging.js";
import { outlookFor, renderOutlook } from "./outlook.js";
import { renderPaths, whichPath, type PathInput } from "./paths.js";
import { getConsent, PACT_TEXT, previewRows, setConsent } from "./share.js";
import { renderCard, renderHosts, renderSummary } from "./report.js";
import { sharedCore, type HookContext, type ToolCallEvent } from "./core.js";
import { attributionKey, Ledger } from "./ledger.js";
import { resolveConfig } from "./types.js";

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function toolEvent(e: unknown): ToolCallEvent {
  const r = (e && typeof e === "object" ? e : {}) as Record<string, unknown>;
  return {
    toolName: str(r.toolName) ?? str(r.name),
    params: r.params ?? r.args ?? r.input,
    toolCallId: str(r.toolCallId) ?? str(r.callId) ?? str(r.id),
    runId: str(r.runId),
    error:
      str(r.error) ??
      (r.error && typeof r.error === "object" ? str((r.error as any).message) : undefined) ??
      (typeof r.errorText === "string" ? r.errorText : undefined),
    ok: typeof r.ok === "boolean" ? r.ok : typeof r.success === "boolean" ? r.success : typeof r.isError === "boolean" ? !r.isError : undefined,
    durationMs: typeof r.durationMs === "number" ? r.durationMs : typeof r.duration === "number" ? r.duration : undefined,
  };
}

function msgCtx(c: unknown): { channelId?: string; conversationId?: string; accountId?: string } {
  const o = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
  return { channelId: str(o.channelId), conversationId: str(o.conversationId), accountId: str(o.accountId) };
}

function hookCtx(c: unknown): HookContext {
  const r = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
  return {
    agentId: str(r.agentId),
    sessionKey: str(r.sessionKey),
    sessionId: str(r.sessionId),
    runId: str(r.runId),
  };
}

export default definePluginEntry({
  id: "clawphylax",
  name: "ClawPhylax",
  description:
    "See where your skills send data: every outbound connection attributed to the tool call that caused it.",
  register(api: any) {
    const log = api.logger ?? { info: console.log, warn: console.warn };
    const cfg = resolveConfig(api.pluginConfig);
    const core = sharedCore(cfg, () => new Ledger(), log);

    // Agent-callable tools: the agent can read its own egress ledger. This is
    // how "is skill X safe?" becomes answerable from inside a conversation.
    api.registerTool({
      name: "clawphylax_report",
      description:
        "Outbound network activity recorded by ClawPhylax, grouped by origin (skill or tool), with flagged events. Use to check where a skill sends data or whether anything contacted a suspicious or unexpected host.",
      parameters: Type.Object({
        since: Type.Optional(Type.String({ description: "Window like 24h, 7d, 30m. Default: all time." })),
        origin: Type.Optional(Type.String({ description: "Filter to one origin, e.g. skill:notes-sync or tool:exec." })),
      }),
      async execute(_id: string, params: { since?: string; origin?: string }) {
        const since = sinceMs(params?.since);
        const summaries = core.ledger.summaries(since).filter((s) => !params?.origin || s.key === params.origin);
        const details = {
          ledger: core.ledger.path,
          mode: core.config.mode,
          origins: summaries.map((s) => ({ ...s, baseline: baselineFor(core.ledger, s.key) })),
          flagged: core.ledger.flagged(since, 20).filter((e) => !params?.origin || attributionKey(e) === params.origin),
        };
        return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
      },
    });
    api.registerTool({
      name: "clawphylax_hosts",
      description: "Hosts contacted by one origin (skill:<name> or tool:<name>) with first/last seen and counts, plus the origin's destination baseline.",
      parameters: Type.Object({
        origin: Type.String({ description: "Origin key, e.g. skill:notes-sync" }),
      }),
      async execute(_id: string, params: { origin: string }) {
        const details = { origin: params.origin, baseline: baselineFor(core.ledger, params.origin), hosts: core.ledger.hostsFor(params.origin) };
        return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
      },
    });

    api.registerTool({
      name: "clawphylax_card",
      description:
        "Witness card for one origin (skill:<name> or tool:<name>): hosts contacted on this machine, counts, flags and baseline, as markdown with the marker clawphylax-card/v1. Share it in a ClawHub review or issue so other agents can check a skill's real behavior before installing. Search for that marker to find cards others published.",
      parameters: Type.Object({
        origin: Type.String({ description: "Origin key, e.g. skill:notes-sync" }),
        format: Type.Optional(Type.String({ description: "md (default) or json" })),
      }),
      async execute(_id: string, params: { origin: string; format?: string }) {
        const text = renderCard(core.ledger, params.origin, params.format === "json" ? "json" : "md");
        return { content: [{ type: "text", text }], details: { origin: params.origin } };
      },
    });
    api.registerTool({
      name: "clawphylax_outlook",
      description:
        "Will a request to this host work? Why did my last request fail — me, the site, or the network? Should I retry, wait, or switch tools? Answers from this machine's observed requests: success probability with confidence bounds, diagnosis (ok / blocked / rate-limited / site-error / unreachable / unreliable), back-off seconds, and which tool succeeds on this host. Call it before retrying a failed web_fetch, exec network command or API call.",
      parameters: Type.Object({
        host: Type.String({ description: "Hostname, e.g. api.example.com" }),
        windowMinutes: Type.Optional(Type.Number({ description: "Look-back window in minutes (default 60; falls back to all-time when empty)." })),
      }),
      async execute(_id: string, params: { host: string; windowMinutes?: number }) {
        const o = outlookFor(core.ledger, params.host, params.windowMinutes ?? 60);
        return { content: [{ type: "text", text: outlookRecord(o) + "\n" + renderOutlook(o) }], details: o };
      },
    });

    // ---- Self-diagnostics: the questions an agent asks itself while troubleshooting.
    const text = (t: string, details: unknown) => ({ content: [{ type: "text", text: t }], details });
    const pct = (x: number) => `${Math.round(x * 100)}%`;
    const outlookRecord = (o: ReturnType<typeof outlookFor>) =>
      renderRecord({
        action: ({ ok: "RETRY_AFTER_FIXING_REQUEST", blocked: "STOP", "rate-limited": "BACKOFF", "site-error": "BACKOFF", unreachable: "BACKOFF", unreliable: "SWITCH_TOOL", "no-history": "TRY_ONCE" } as Record<string, string>)[o.diagnosis],
        evidence: `${o.host}: ${o.successes}/${o.n} succeeded${o.windowMinutes ? ` in ${o.windowMinutes} min` : " all-time"}; recent statuses ${o.recentStatuses.join(" ")}${o.byTool.length > 1 ? `; by tool ${o.byTool.map((t) => `${t.tool} ${t.successes}/${t.n}`).join(", ")}` : ""}`,
        doNot: o.diagnosis === "blocked" ? `retry ${o.host} with the same tool or credentials` : o.diagnosis === "rate-limited" ? `send parallel or immediate requests to ${o.host}` : o.diagnosis === "site-error" || o.diagnosis === "unreachable" ? "reword the request; the host, not the request, is failing" : o.diagnosis === "unreliable" ? `keep using the failing tool on ${o.host}` : undefined,
        next: o.recommendation + (o.backoffSeconds ? ` Wait ${o.backoffSeconds}s first.` : "") + (o.bestTool ? ` Prefer ${o.bestTool}.` : ""),
        confidence: o.n ? `P(next attempt succeeds) ≈ ${pct(o.pNext)}, 95% bounds ${pct(o.pLower)}–${pct(o.pUpper)}, ${o.confidence}` : "none yet",
        scope: `${o.host}, ${SCOPE_LOCAL}`,
      });
    const stopRecord = (r: ReturnType<typeof stopOrContinue>) =>
      renderRecord({
        action: r.verdict.toUpperCase().replace(/-/g, "_"),
        evidence: `${r.successes}/${r.attempts} tool calls succeeded across ${r.distinctApproaches} approach(es) in ${r.minutesElapsed} min; last success ${r.lastSuccessAgoAttempts === null ? "never" : r.lastSuccessAgoAttempts + " attempt(s) ago"}${r.blockedHosts.length ? `; refusing hosts: ${r.blockedHosts.join(", ")}` : ""}`,
        doNot: r.verdict === "stop-and-ask" ? "continue silently or retry the same approach" : r.verdict === "change-approach" ? "repeat the same tool and route" : undefined,
        next: r.say,
        confidence: r.attempts ? `success-rate upper bound ${pct(r.successUpper)}` : "none yet",
        scope: SCOPE_LOCAL,
      });
    api.registerTool({
      name: "clawphylax_did_it_work",
      description:
        "Did that actually work? Use this after any tool call whose effect matters — an exec, a write, a POST, a message, a fetch — before building on its result. Cross-checks what the tool reported (ok/error) against what the wire showed for that same tool call: status codes, empty bodies, unsent uploads. Returns exactly one of CONFIRMED, SILENT_FAILURE, UNVERIFIED, FAILED, with the mismatch named. Do not use for reads you will not act on.",
      parameters: Type.Object({ toolCallId: Type.Optional(Type.String({ description: "Defaults to the last non-diagnostic tool call in this session." })), sessionKey: Type.Optional(Type.String()) }),
      async execute(_id: string, p: { toolCallId?: string; sessionKey?: string }) {
        const r = didItWork(core.ledger, { toolCallId: p?.toolCallId, sessionKey: p?.sessionKey ?? core.lastSessionKey });
        return text(
          renderRecord({
            action: r.verdict === "CONFIRMED" ? "BUILD_ON_IT" : r.verdict === "SILENT_FAILURE" ? "TREAT_AS_NOT_DONE" : r.verdict === "UNVERIFIED" ? "VERIFY_DIRECTLY" : r.verdict === "FAILED" ? "FIX_THEN_RETRY" : "NONE",
            evidence: `${r.tool ?? "no tool"} reported ${r.reported}${r.hint ? ` (${r.hint.slice(0, 80)})` : ""}; wire: ${r.observed.length ? r.observed.map((o) => `${o.method} ${o.host} → ${o.status ?? "no response"}${typeof o.bytesIn === "number" ? ` ${o.bytesIn}B` : ""}`).join(", ") : "no observable request"}`,
            doNot: r.verdict === "SILENT_FAILURE" ? "proceed as if the action succeeded" : r.verdict === "UNVERIFIED" ? "assume the effect happened" : undefined,
            next: r.say,
            scope: SCOPE_LOCAL,
          }),
          r,
        );
      },
    });
    api.registerTool({
      name: "clawphylax_send_check",
      description:
        "Is this safe to send? Use this before sending a message to any target other than the conversation you are replying in, before forwarding content, and whenever the text could contain a credential. Checks the target against this session's origin conversation and earlier sends, and scans the text for secret-shaped values (API keys, tokens, private keys) and credential file paths. Returns exactly SEND, CONFIRM_WITH_USER or DO_NOT_SEND with reasons. Do not use for a plain reply in the same conversation with no sensitive content.",
      parameters: Type.Object({ to: Type.String({ description: "Target as the message tool would receive it (chat id, channel, user)." }), content: Type.String(), sessionKey: Type.Optional(Type.String()) }),
      async execute(_id: string, p: { to: string; content: string; sessionKey?: string }) {
        const r = sendCheck(core.ledger, { to: p.to, content: p.content, sessionKey: p?.sessionKey ?? core.lastSessionKey });
        return text(
          renderRecord({
            action: r.verdict,
            evidence: r.reasons.length ? r.reasons.join("; ") : `same conversation, no secret-shaped values, target seen before`,
            doNot: r.verdict === "DO_NOT_SEND" ? "send the text as it is" : r.verdict === "CONFIRM_WITH_USER" ? "send before the user has confirmed target and content" : undefined,
            next: r.say,
            scope: "this session's record on this machine; a target the user named explicitly in this conversation counts as confirmed",
          }),
          r,
        );
      },
    });
    api.registerTool({
      name: "clawphylax_sent",
      description:
        "Did my message actually go out? Use this after any message send whose delivery matters — a notification, a reply the user is waiting for, a forward — and before telling the user it was sent. Cross-checks the runtime's send result (message_sent success/error) against the wire: the request this process made to the channel API (Telegram, Discord, Slack, WhatsApp Cloud, Twilio, Teams…) and its status code. Returns exactly DELIVERED, NOT_DELIVERED, CLAIMED_ONLY, CANCELLED, PENDING or NO_SEND. Do not use for channels that deliver outside this process (WhatsApp Web, Signal, iMessage) except to learn that the wire cannot confirm them.",
      parameters: Type.Object({ sendId: Type.Optional(Type.Number({ description: "Outbound record id; defaults to the latest send of this session." })), sessionKey: Type.Optional(Type.String()) }),
      async execute(_id: string, p: { sendId?: number; sessionKey?: string }) {
        const r = didMessageGoOut(core.ledger, { sendId: p?.sendId, sessionKey: p?.sessionKey ?? core.lastSessionKey });
        return text(
          renderRecord({
            action: r.verdict === "DELIVERED" ? "REPORT_AS_SENT" : r.verdict === "CLAIMED_ONLY" || r.verdict === "PENDING" ? "VERIFY_ON_RECEIVING_SIDE" : r.verdict === "NO_SEND" ? "SEND_FIRST" : "DO_NOT_REPORT_AS_SENT",
            evidence: `runtime: ${r.send ? (r.send.cancelled ? "cancelled" : r.send.success === undefined ? "no completion yet" : r.send.success ? "success" : `failed${r.send.error ? " (" + r.send.error.slice(0, 80) + ")" : ""}`) : "no send"}; wire: ${r.wire.length ? r.wire.map((w) => `${w.method} ${w.host} → ${w.status ?? "no response"}`).join(", ") : "no channel API request observed"}`,
            doNot: r.verdict === "DELIVERED" ? undefined : "tell the user the message was sent",
            next: r.say,
            scope: SCOPE_LOCAL,
          }),
          r,
        );
      },
    });
    api.registerTool({
      name: "clawphylax_compaction_brief",
      description:
        "What did I lose in context compaction that I must not forget? Use this right after a compaction notice, at the start of a resumed session, and whenever you suspect an earlier result is missing from your context. Rebuilds from the local ledger what happened before the compaction: hosts contacted, what is blocked or rate-limited for you, failed actions, silent failures, undelivered messages, routes that worked, and the last actions before the cut. Returns a MUST NOT FORGET list. Do not use as a general summary of a short session that was never compacted.",
      parameters: Type.Object({ sessionKey: Type.Optional(Type.String()), windowMinutes: Type.Optional(Type.Number()) }),
      async execute(_id: string, p: { sessionKey?: string; windowMinutes?: number }) {
        const r = compactionBrief(core.ledger, { sessionKey: p?.sessionKey ?? core.lastSessionKey, windowMinutes: p?.windowMinutes });
        return text(
          renderRecord({
            action: r.mustNotForget.length ? "CARRY_FORWARD" : "CONTINUE",
            evidence: `${r.compactedAt ? `compacted at ${new Date(r.compactedAt).toISOString().slice(11, 19)}` : "no compaction recorded"}; ${r.hostsContacted.length} hosts, ${r.failedTools.length} failed actions, ${r.silentFailures.length} silent failures, ${r.undelivered.length} unconfirmed sends, ${r.workingRoutes.length} working routes`,
            doNot: r.mustNotForget.length ? "repeat a blocked host or a failed action unchanged" : undefined,
            next: r.mustNotForget.length ? `MUST NOT FORGET: ${r.mustNotForget.join(" | ")}` : r.say,
            scope: SCOPE_LOCAL,
          }),
          r,
        );
      },
    });
    api.registerTool({
      name: "clawphylax_task_match",
      description:
        "Did I do what was asked? Does my reply match the request, and did the processing in between make sense? Use this after replying to a message, before marking a task handled, and when a heartbeat or cron turn produced a lot of activity for a small message. Compares the inbound request (keyword fingerprint, requested actions) with the reply that went out (keyword fingerprint, delivery) and the actions actually taken between them (tool calls, hosts, failures, seconds). Returns exactly COHERENT, PARTIAL, INCOHERENT or NO_PAIR with reasons. No model is consulted; texts are not stored.",
      parameters: Type.Object({ sessionKey: Type.Optional(Type.String()) }),
      async execute(_id: string, p: { sessionKey?: string }) {
        const r = taskMatch(core.ledger, { sessionKey: p?.sessionKey ?? core.lastSessionKey });
        return text(
          renderRecord({
            action: r.verdict === "COHERENT" ? "TURN_HANDLED" : r.verdict === "PARTIAL" ? "ANSWER_THE_MISSING_PART" : r.verdict === "INCOHERENT" ? "REDO_THE_TURN" : "NONE",
            evidence: r.inbound ? `request ${r.inbound.len} chars asking to ${r.inbound.asks.join("/") || "(nothing specific)"}; reply ${r.outbound?.len} chars, ${Math.round(r.overlap * 100)}% key-term overlap; ${r.toolCalls} tool calls (${r.failedCalls} failed) over ${r.seconds} s${r.hosts.length ? " via " + r.hosts.slice(0, 3).join(", ") : ""}; delivery ${r.outbound?.delivery}` : r.say,
            doNot: r.verdict === "INCOHERENT" ? "mark this turn as handled" : undefined,
            next: r.say,
            scope: "keyword-level comparison on this machine; it cannot judge tone or correctness of facts",
          }),
          r,
        );
      },
    });
    api.registerTool({
      name: "clawphylax_reconcile",
      description:
        "What do I believe I did, and what did I actually do? Use this before reporting a task as done, after a long session, and whenever you are about to say 'sent', 'published', 'fixed' or 'verified'. Reads your own transcript for success claims and checks each against the record: tool outcomes, outbound sends and their delivery, POST/PUT status codes on the wire. Lists claims as SUPPORTED, UNSUPPORTED or CONTRADICTED and names failed actions you never mentioned. Returns exactly RECORD_MATCHES_CLAIMS, CLAIMS_EXCEED_RECORD, RECORD_EXCEEDS_CLAIMS or NO_CLAIMS. Do not use before any action has been taken.",
      parameters: Type.Object({ sessionKey: Type.Optional(Type.String()), sessionId: Type.Optional(Type.String({ description: "Transcript session id; defaults to the most recently modified transcript." })) }),
      async execute(_id: string, p: { sessionKey?: string; sessionId?: string }) {
        const r = reconcile(core.ledger, { sessionKey: p?.sessionKey ?? core.lastSessionKey, sessionId: p?.sessionId });
        return text(
          renderRecord({
            action: r.verdict === "RECORD_MATCHES_CLAIMS" ? "REPORT_AS_IS" : r.verdict === "CLAIMS_EXCEED_RECORD" ? "CORRECT_WHAT_YOU_SAID" : r.verdict === "RECORD_EXCEEDS_CLAIMS" ? "MENTION_THE_FAILURES" : "NONE",
            evidence: `${r.claims.length} claims: ${r.claims.length - r.unsupported - r.contradicted} supported, ${r.unsupported} unsupported, ${r.contradicted} contradicted; ${r.unmentionedFailures.length} unmentioned failures${r.transcript ? "" : "; no transcript"}`,
            doNot: r.verdict === "CLAIMS_EXCEED_RECORD" ? "repeat a claim marked CONTRADICTED or UNSUPPORTED" : undefined,
            next: r.say,
            scope: SCOPE_LOCAL,
          }) + (r.claims.length ? "\n\n" + renderClaims(r) : ""),
          r,
        );
      },
    });
    api.registerTool({
      name: "clawphylax_failures",
      description: "Why do I keep failing? Clusters this session's failed tool calls and failed requests by tool, host and error signature, says which single cause explains most of them, and returns a compact trail of the last failures for you to reason about. Use when errors pile up and you are about to retry.",
      parameters: Type.Object({ sessionKey: Type.Optional(Type.String()), windowMinutes: Type.Optional(Type.Number()) }),
      async execute(_id: string, p: { sessionKey?: string; windowMinutes?: number }) {
        const r = failureReport(core.ledger, { sessionKey: p?.sessionKey ?? core.lastSessionKey, windowMinutes: p?.windowMinutes });
        return text(`${r.nextQuestion}\n\nfailures: ${r.failures} of ${r.attempts} tool calls · clusters: ${r.clusters.slice(0, 5).map((c) => `${c.tool}${c.host ? "@" + c.host : ""} "${c.signature}" ×${c.count}`).join(" | ")}\ntrail: ${r.trail.map((t) => `${t.t} ${t.tool} ${t.hint ?? ""} → ${t.error ?? "?"}`).join(" ; ")}`, r);
      },
    });
    api.registerTool({
      name: "clawphylax_stop_or_continue",
      description: "Should I stop and ask the user, change approach, or continue? A stopping rule from this session's attempts: success rate with confidence bounds across distinct approaches, attempts since the last success, and hosts that are refusing you. Use when a task is dragging on or before yet another retry.",
      parameters: Type.Object({ sessionKey: Type.Optional(Type.String()), windowMinutes: Type.Optional(Type.Number()) }),
      async execute(_id: string, p: { sessionKey?: string; windowMinutes?: number }) {
        const r = stopOrContinue(core.ledger, { sessionKey: p?.sessionKey ?? core.lastSessionKey, windowMinutes: p?.windowMinutes });
        return text(stopRecord(r), r);
      },
    });
    api.registerTool({
      name: "clawphylax_circles",
      description: "Am I going in circles? Measures repetition in this session's recent tool calls (same call repeated, identical failures, falling success rate) and tells you whether you are on track, repeating yourself, or stuck. Use when you notice you have done something before.",
      parameters: Type.Object({ sessionKey: Type.Optional(Type.String()) }),
      async execute(_id: string, p: { sessionKey?: string }) {
        const r = circlesCheck(core.ledger, { sessionKey: p?.sessionKey ?? core.lastSessionKey });
        return text(`${r.verdict.toUpperCase()}: ${r.say}`, r);
      },
    });
    api.registerTool({
      name: "clawphylax_risk_check",
      description: "Could this action get the user banned, charged, or exposed? Check a host or a shell command BEFORE running it: known drop hosts, hosts currently refusing or rate-limiting you, credential reads combined with uploads, per-call billed APIs, purchase or billing paths. Returns ok / caution / stop with reasons.",
      parameters: Type.Object({ host: Type.Optional(Type.String()), path: Type.Optional(Type.String()), method: Type.Optional(Type.String()), command: Type.Optional(Type.String()) }),
      async execute(_id: string, p: { host?: string; path?: string; method?: string; command?: string }) {
        const r = riskCheck(core.ledger, core.config, p ?? {});
        return text(`${r.verdict.toUpperCase()}: ${r.say}`, r);
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
        return text(`${r.verdict.toUpperCase()}: ${r.say}`, r);
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
      name: "clawphylax_token_use",
      description: "Am I using too many tokens? Am I spending tokens to refute myself or to put the task into practice? Classifies this session's assistant turns from the transcript into act / gather / repeat / deliberate, attributes output tokens to each, finds deliberation streaks and repeated identical calls, and says whether you are executing, deliberating, or churning — with the concrete next step. Works without the ledger.",
      parameters: Type.Object({ sessionId: Type.Optional(Type.String()), windowMinutes: Type.Optional(Type.Number()) }),
      async execute(_id: string, p: { sessionId?: string; windowMinutes?: number }) {
        const t = tokenUse({ sessionId: p?.sessionId, windowMinutes: p?.windowMinutes });
        return text(renderTokenUse(t), t ?? {});
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
          return text(`Sharing consent: ${c.on ? "ON (recorded " + c.since + ")" : "OFF"}. Nothing leaves this machine in this version.`, c);
        }
        const c = getConsent(core.ledger);
        const rows = previewRows(core.ledger, 10);
        return text(`consent: ${c.on ? "on since " + c.since : "off"} · nothing leaves this machine in this version.\nrows that would be shared (last ${rows.length}): ${JSON.stringify(rows)}`, { consent: c, rows });
      },
    });
    api.registerTool({
      name: "clawphylax_scan",
      description:
        "Scan a skill folder BEFORE installing or trusting it: lists every network host its SKILL.md and scripts name, whether they upload data, and whether they read credential files (~/.ssh, .env, ~/.aws). Returns clean / review / suspicious. Use after `openclaw skills inspect` or on any local skill directory.",
      parameters: Type.Object({
        path: Type.String({ description: "Absolute or workspace-relative path to the skill folder." }),
      }),
      async execute(_id: string, params: { path: string }) {
        const root = path.resolve(params.path);
        const result = scanSkillFolder(root, (h) => classifyHost(h, core.config) === "suspicious");
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
      },
    });

    // Best-effort install gate: when the host stages a skill install, scan it.
    // The event shape is experimental; anything unexpected degrades to no-op.
    api.on("before_install", (event: unknown) => {
      try {
        const e = (event && typeof event === "object" ? event : {}) as Record<string, unknown>;
        const dir = [e.stagedDir, e.path, e.dir, e.sourceDir, e.targetDir].find((v) => typeof v === "string" && fs.existsSync(v as string)) as string | undefined;
        if (!dir) {
          return undefined;
        }
        const r = scanSkillFolder(dir, (h) => classifyHost(h, core.config) === "suspicious");
        if (r.verdict !== "clean") {
          log.warn(`install scan ${r.verdict}: ${r.hosts.join(", ") || "no hosts"} (${r.findings.length} findings in ${dir})`);
        }
        if (r.verdict === "suspicious" && core.config.mode === "enforce") {
          return { block: true, blockReason: `ClawPhylax: staged files contact ${r.hosts.join(", ")} with upload or credential-read patterns` };
        }
      } catch {
        /* never break installs */
      }
      return undefined;
    });

    // Chat command with prompt guidance: once the plugin is installed, every
    // agent prompt carries a short hint to verify skills before installing them.
    // Guidance text stays about the command itself, as the SDK docs ask.
    api.registerCommand({
      name: "phylax",
      description: "ClawPhylax: report outbound activity, diagnose a failing host (outlook), scan a skill folder, list hosts for an origin, or render a witness card.",
      acceptsArgs: true,
      requireAuth: true,
      agentPromptGuidance: [
        "Before installing any third-party skill, run clawphylax_scan on it; before retrying a failed request, run clawphylax_outlook on the host; when a task repeats, stalls, or produces no new evidence, run clawphylax_stop_or_continue; after any action whose effect matters, run clawphylax_did_it_work before building on the result; before sending to a target other than the conversation you are replying in, run clawphylax_send_check; after a send whose delivery matters, run clawphylax_sent before saying it was sent; after a context compaction, run clawphylax_compaction_brief before continuing; before reporting a task as done, run clawphylax_reconcile and clawphylax_task_match. Before any action that could expose data, incur cost, change external state, or risk an account restriction, run clawphylax_risk_check; follow the returned ACTION and do not repeat an approach it prohibits.",
      ],
      handler: async (ctx: any) => {
        try {
          if (ctx?.sessionKey) {
            core.lastSessionKey = ctx.sessionKey;
          }
          const args = String(ctx?.args ?? "").trim();
          const [sub, ...rest] = args.split(/\s+/).filter(Boolean);
          const arg = rest.join(" ");
          if (!sub || sub === "report") {
            const c = core.ledger.counts();
            if (!sub && c.events === 0 && core.ledger.toolOutcomes({ limit: 1 }).length === 0) {
              return {
                text: [
                  "ClawPhylax is armed and the ledger is empty — recording starts with the next tool call.",
                  "Ask it after any action: /phylax check (did that actually work) · /phylax sent (did my message go out) · /phylax send <to> :: <text> (is this safe to send)",
                  "While troubleshooting: /phylax outlook <host> · failures · stop · circles · explore · risk <host> · paths <json>",
                  "After a long session: /phylax brief (what did I lose in compaction) · match (did I do what was asked) · reconcile (what did I actually do) · tokens · cost",
                  "Skills: /phylax scan <folder> before install · /phylax report for where installed skills send data.",
                ].join("\n"),
              };
            }
            return { text: renderSummary(core.ledger, sinceMs(arg)) };
          }
          if (sub === "hosts" && arg) {
            return { text: renderHosts(core.ledger, arg) };
          }
          if (sub === "outlook" && arg) {
            return { text: renderOutlook(outlookFor(core.ledger, arg, 60)) };
          }
          if (sub === "check" || sub === "didit") {
            const r = didItWork(core.ledger, { toolCallId: arg || undefined, sessionKey: ctx?.sessionKey ?? core.lastSessionKey });
            return { text: `${r.verdict}: ${r.say}` };
          }
          if (sub === "failures") {
            const r = failureReport(core.ledger, { sessionKey: ctx?.sessionKey ?? core.lastSessionKey });
            return { text: `${r.nextQuestion}\n${r.clusters.slice(0, 5).map((c) => `- ${c.tool}${c.host ? "@" + c.host : ""} "${c.signature}" ×${c.count}`).join("\n")}` };
          }
          if (sub === "stop") {
            const r = stopOrContinue(core.ledger, { sessionKey: ctx?.sessionKey ?? core.lastSessionKey });
            return { text: `${r.verdict.toUpperCase()}: ${r.say}` };
          }
          if (sub === "circles") {
            const r = circlesCheck(core.ledger, { sessionKey: ctx?.sessionKey ?? core.lastSessionKey });
            return { text: `${r.verdict.toUpperCase()}: ${r.say}` };
          }
          if (sub === "risk" && arg) {
            const r = riskCheck(core.ledger, core.config, /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(arg) ? { host: arg } : { command: arg });
            return { text: `${r.verdict.toUpperCase()}: ${r.say}` };
          }
          if (sub === "others" && arg) {
            return { text: othersSolved(core.ledger, arg, { excludeSession: ctx?.sessionKey ?? core.lastSessionKey }).say };
          }
          if (sub === "explore") {
            const r = explorationCheck(core.ledger, { sessionKey: ctx?.sessionKey ?? core.lastSessionKey });
            return { text: `${r.verdict.toUpperCase()}: ${r.say}` };
          }
          if (sub === "worked" && arg) {
            return { text: whatWorked(core.ledger, arg).markdown };
          }
          if (sub === "send") {
            const [to, ...restText] = arg.split(" :: ");
            if (!to || !restText.length) return { text: "Usage: /phylax send <target> :: <text>" };
            const r = sendCheck(core.ledger, { to, content: restText.join(" :: "), sessionKey: core.lastSessionKey });
            return { text: `${r.verdict}: ${r.say}` };
          }
          if (sub === "sent") {
            const r = didMessageGoOut(core.ledger, { sessionKey: core.lastSessionKey, sendId: arg ? Number(arg) : undefined });
            return { text: `${r.verdict}: ${r.say}` };
          }
          if (sub === "brief") {
            const r = compactionBrief(core.ledger, { sessionKey: core.lastSessionKey });
            return { text: `${r.say}${r.mustNotForget.length ? "\n\nMUST NOT FORGET:\n- " + r.mustNotForget.join("\n- ") : ""}` };
          }
          if (sub === "match") {
            const r = taskMatch(core.ledger, { sessionKey: core.lastSessionKey });
            return { text: `${r.verdict}: ${r.say}` };
          }
          if (sub === "reconcile") {
            const r = reconcile(core.ledger, { sessionKey: core.lastSessionKey });
            return { text: `${r.verdict}: ${r.say}${r.claims.length ? "\n\n" + renderClaims(r) : ""}` };
          }
          if (sub === "tokens") {
            return { text: renderTokenUse(tokenUse({ windowMinutes: arg ? Number(arg) : undefined })) };
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
              return { text: `Sharing consent: ${c.on ? "ON" : "OFF"}. Nothing leaves this machine in this version. /phylax share pact shows the rules.` };
            }
            const c = getConsent(core.ledger);
            return { text: `Sharing consent: ${c.on ? "on since " + c.since : "off"} · nothing leaves this machine in this version.\nRows that would be shared: ${JSON.stringify(previewRows(core.ledger, 5))}\n/phylax share pact | on | off` };
          }
          if (sub === "card" && arg) {
            return { text: renderCard(core.ledger, arg, "md") };
          }
          if (sub === "scan" && arg) {
            const r = scanSkillFolder(path.resolve(arg), (h) => classifyHost(h, core.config) === "suspicious");
            const lines = [`${r.verdict.toUpperCase()} — ${r.filesScanned} files, hosts: ${r.hosts.join(", ") || "none"}`];
            for (const f of r.findings.slice(0, 20)) {
              lines.push(`${f.file}:${f.line}  ${f.host ? `${f.method} ${f.host}` : "(no host)"}${f.upload ? " [upload]" : ""}${f.sensitiveRead ? " [sensitive-read]" : ""}`);
            }
            return { text: lines.join("\n") };
          }
          return { text: "Usage: /phylax [report [24h]] | outlook <host> | check [toolCallId] | send <to> :: <text> | sent [id] | brief | match | reconcile | failures | stop | circles | explore | risk <host|command> | others <host> | worked <host> | cost [minutes] | tokens [minutes] | paths <json> | scan <folder> | hosts <origin> | card <origin> | share [pact|on|off]" };
        } catch (err: any) {
          return { text: `ClawPhylax error: ${err?.message ?? err}` };
        }
      },
    });

    // CLI works without a running Gateway; register it first.
    api.registerCli(
      async ({ program }: { program: any }) => {
        registerCli(program);
      },
      { descriptors: [CLI_DESCRIPTOR] },
    );

    // Patch the transport seams now, before provider modules bind their fetch.
    // Recording stays off until this process proves to be an agent host:
    // Gateway start, or the first tool call (embedded `openclaw agent --local`).
    // CLI invocations load this entry too and must never record their own traffic.
    try {
      core.startInterceptor();
    } catch (err: any) {
      log.warn(`interceptor not installed: ${err?.message ?? err}`);
    }
    api.on("gateway_start", () => core.arm());
    api.on(
      "before_tool_call",
      () => {
        core.arm();
        return undefined;
      },
      { priority: 1000 },
    );

    api.on("before_tool_call", (event: unknown, ctx: unknown) => {
      try {
        const d = core.beforeToolCall(toolEvent(event), hookCtx(ctx));
        if (d.block) {
          return { block: true, blockReason: `ClawPhylax: ${d.reason}` };
        }
      } catch (err: any) {
        log.warn(`before_tool_call: ${err?.message ?? err}`);
      }
      return undefined;
    });

    api.on("after_tool_call", (event: unknown, ctx: unknown) => {
      try {
        core.afterToolCall(toolEvent(event), hookCtx(ctx));
      } catch {
        /* never throw from an observer */
      }
    });

    // Messaging and compaction: the two halves of "did that message go out"
    // and "what did I lose". Every field is read defensively.
    api.on("message_received", (event: unknown, ctx: unknown) => {
      try {
        const e = (event && typeof event === "object" ? event : {}) as Record<string, unknown>;
        core.messageReceived({ from: str(e.from), content: typeof e.content === "string" ? e.content : "", sessionKey: str(e.sessionKey), runId: str(e.runId) }, hookCtx(ctx), msgCtx(ctx));
      } catch {
        /* observer */
      }
    });
    api.on("message_sent", (event: unknown, ctx: unknown) => {
      try {
        const e = (event && typeof event === "object" ? event : {}) as Record<string, unknown>;
        core.messageSent({ to: str(e.to), success: typeof e.success === "boolean" ? e.success : undefined, error: str(e.error), messageId: str(e.messageId), sessionKey: str(e.sessionKey) }, hookCtx(ctx));
      } catch {
        /* observer */
      }
    });
    api.on("before_compaction", (event: unknown, ctx: unknown) => {
      try {
        const e = (event && typeof event === "object" ? event : {}) as Record<string, unknown>;
        core.compaction("before", { messageCount: Number(e.messageCount) || undefined, compactingCount: Number(e.compactingCount) || undefined, tokenCount: Number(e.tokenCount) || undefined }, hookCtx(ctx));
      } catch {
        /* observer */
      }
    });
    api.on("after_compaction", (event: unknown, ctx: unknown) => {
      try {
        const e = (event && typeof event === "object" ? event : {}) as Record<string, unknown>;
        core.compaction("after", { messageCount: Number(e.messageCount) || undefined, compactedCount: Number(e.compactedCount) || undefined, tokenCount: Number(e.tokenCount) || undefined }, hookCtx(ctx));
      } catch {
        /* observer */
      }
    });

    // The operator's heartbeat gets one line, only when something earned it.
    api.on("heartbeat_prompt_contribution", (_event: unknown, ctx: unknown) => {
      try {
        const t = core.heartbeatContribution(hookCtx(ctx).sessionKey ?? core.lastSessionKey);
        return t ? { appendContext: t } : undefined;
      } catch {
        return undefined;
      }
    });

    // Append a one-line summary to the reply when the run touched new or
    // suspicious hosts. If the event shape is not what we expect, do nothing.
    api.on("message_sending", (event: unknown, ctx: unknown) => {
      try {
        const e = (event && typeof event === "object" ? event : {}) as Record<string, unknown>;
        const runId = hookCtx(ctx).runId ?? str(e.runId);
        const gate = core.messageSending({ to: str(e.to), content: typeof e.content === "string" ? e.content : "", runId }, hookCtx(ctx), msgCtx(ctx));
        if (gate.cancel) {
          return { cancel: true, cancelReason: gate.cancelReason };
        }
        const footer = core.footerForRun(runId);
        if (!footer) {
          return undefined;
        }
        if (typeof e.content === "string") {
          return { content: `${e.content}\n\n${footer}` };
        }
      } catch {
        /* ignore */
      }
      return undefined;
    });

    if (typeof api.registerSecurityAuditCollector === "function") {
      try {
        api.registerSecurityAuditCollector(async () => {
          const flagged = core.ledger.flagged(Date.now() - 7 * 86_400_000, 20);
          return flagged.map((e) => ({
            id: `clawphylax.${e.category}.${e.host}`,
            severity: e.blocked || e.flags.includes("sensitive-read") ? "critical" : "warn",
            title: `Outbound to ${e.host} from ${e.attribution.skill ?? e.attribution.toolName ?? "model-turn"}`,
            detail: `${e.method} ${e.host}${e.path ?? ""} (${e.category}) flags=${e.flags.join(",")}`,
          }));
        });
      } catch {
        /* optional surface */
      }
    }

    log.debug?.(`ClawPhylax registered — ledger ${core.ledger.path}`);
  },
});
