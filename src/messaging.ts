// Messaging is what an OpenClaw agent does most: every turn ends in a send.
// Four questions about it, answered from two channels the host does not join
// up: the message hooks (what the runtime claims about a send) and the wire
// (what actually left this process for the channel API).
//
//   send check  — is this safe to send? (target vs origin conversation, secrets)
//   sent        — did my message go out? (hook success × wire status)
//   brief       — what did I lose in compaction that I must not forget?
//   reconcile   — what do I believe I did vs what the record shows?

import fs from "node:fs";
import { findTranscripts } from "./cost.js";
import { didItWork } from "./diagnostics.js";
import type { Ledger, OutboundRow, ToolOutcome } from "./ledger.js";
import { outlookFor } from "./outlook.js";
import { findSecretShapes, type SecretHit } from "./secrets.js";
import type { EgressEvent } from "./types.js";

// ------------------------------------------------------------ channel hosts

const CHANNEL_HOSTS: Array<[RegExp, string]> = [
  [/(^|\.)api\.telegram\.org$/i, "telegram"],
  [/(^|\.)discord(app)?\.com$/i, "discord"],
  [/(^|\.)slack\.com$/i, "slack"],
  [/(^|\.)graph\.facebook\.com$/i, "whatsapp-cloud"],
  [/(^|\.)api\.twilio\.com$/i, "twilio"],
  [/(^|\.)graph\.microsoft\.com$/i, "teams"],
  [/(^|\.)chat\.googleapis\.com$/i, "google-chat"],
  [/(^|\.)api\.line\.me$/i, "line"],
  [/(^|\.)matrix\.org$/i, "matrix"],
  [/(^|\.)api\.pushover\.net$/i, "pushover"],
  [/(^|\.)mattermost\./i, "mattermost"],
  [/(^|\.)zulipchat\.com$/i, "zulip"],
  [/(^|\.)api\.sendgrid\.com$/i, "email-sendgrid"],
  [/(^|\.)api\.mailgun\.net$/i, "email-mailgun"],
];

export function channelOfHost(host: string): string | undefined {
  for (const [re, name] of CHANNEL_HOSTS) if (re.test(host)) return name;
  return undefined;
}

/** Channels whose delivery does not go over an HTTPS API this process makes (so the wire cannot confirm them). */
const NON_HTTP_CHANNELS = new Set(["whatsapp", "signal", "imessage", "bluebubbles", "irc", "xmpp", "nostr"]);

// ------------------------------------------------------------- send check

export type SendCheck = {
  verdict: "SEND" | "CONFIRM_WITH_USER" | "DO_NOT_SEND";
  to: string;
  origin?: { channelId?: string; conversationId?: string; from?: string; ts: number };
  crossConversation: boolean;
  firstTimeTarget: boolean;
  secrets: SecretHit[];
  credentialPaths: string[];
  reasons: string[];
  say: string;
};

const CRED_PATH = /(~|\/home\/\w+|[A-Z]:\\Users\\\w+)?[\\/]?(\.ssh[\\/]|\.aws[\\/]credentials|\.env\b|\.netrc\b|\.npmrc\b|id_rsa|id_ed25519|credentials\.json|secrets?\.(json|ya?ml|toml))/g;

export function sendCheck(ledger: Ledger, opts: { sessionKey?: string; to: string; content: string; channelId?: string }): SendCheck {
  const to = (opts.to ?? "").trim();
  const origin = opts.sessionKey ? ledger.originFor(opts.sessionKey) : undefined;
  const secrets = findSecretShapes(opts.content ?? "");
  const credentialPaths = [...new Set([...(opts.content ?? "").matchAll(CRED_PATH)].map((m) => m[0]))].slice(0, 5);
  const norm = (s: string | undefined) => (s ?? "").toLowerCase().replace(/^[a-z-]+:/, "");
  const crossConversation = !!origin?.conversationId && !!to && norm(origin.conversationId) !== norm(to) && !norm(to).endsWith(norm(origin.conversationId)) && !norm(origin.conversationId).endsWith(norm(to));
  const previous = opts.sessionKey ? ledger.outbounds({ sessionKey: opts.sessionKey, limit: 500 }) : [];
  const firstTimeTarget = !!to && !previous.some((o) => norm(o.to) === norm(to)) && !(origin && norm(origin.conversationId) === norm(to));

  const reasons: string[] = [];
  let verdict: SendCheck["verdict"] = "SEND";
  if (secrets.length) {
    verdict = "DO_NOT_SEND";
    reasons.push(`the text contains ${secrets.length} secret-shaped value${secrets.length > 1 ? "s" : ""}: ${secrets.map((s) => `${s.kind} ${s.masked}`).join(", ")}`);
  }
  if (credentialPaths.length) {
    if (verdict === "SEND") verdict = "CONFIRM_WITH_USER";
    reasons.push(`the text names credential files: ${credentialPaths.join(", ")}`);
  }
  if (crossConversation) {
    if (verdict === "SEND") verdict = "CONFIRM_WITH_USER";
    reasons.push(`target ${to} is not the conversation this session is replying in (${origin?.channelId ?? "?"}:${origin?.conversationId})`);
  } else if (firstTimeTarget) {
    if (verdict === "SEND") verdict = "CONFIRM_WITH_USER";
    reasons.push(`first message from this session to ${to}; no earlier send to it on record`);
  }
  if (!origin && opts.sessionKey) {
    reasons.push("origin conversation unknown (no inbound message recorded for this session) — cross-conversation check could not run");
  }
  const say =
    verdict === "DO_NOT_SEND"
      ? `Do not send: ${reasons[0]}. Remove the value, then re-check. If the user asked for it explicitly, say what you are about to send and where, and wait for a yes.`
      : verdict === "CONFIRM_WITH_USER"
        ? `Confirm before sending: ${reasons.filter((r) => !r.startsWith("origin")).join("; ")}. Tell the user the target and the first line, and wait for a yes.`
        : `Send: same conversation, no secret-shaped values, ${previous.length} earlier send${previous.length === 1 ? "" : "s"} to this target on record.`;
  return { verdict, to, origin, crossConversation, firstTimeTarget, secrets, credentialPaths, reasons, say };
}

// ------------------------------------------------------------------ sent

export type SentCheck = {
  verdict: "DELIVERED" | "NOT_DELIVERED" | "CLAIMED_ONLY" | "CANCELLED" | "PENDING" | "NO_SEND";
  send?: OutboundRow;
  wire: Array<{ ts: number; method: string; host: string; status?: number; channel?: string }>;
  say: string;
};

export function didMessageGoOut(ledger: Ledger, opts: { sessionKey?: string; sendId?: number; windowSeconds?: number } = {}): SentCheck {
  const win = (opts.windowSeconds ?? 45) * 1000;
  let send: OutboundRow | undefined;
  if (opts.sendId) send = ledger.outbound(opts.sendId);
  else send = ledger.outbounds({ sessionKey: opts.sessionKey, limit: 1 })[0];
  if (!send) {
    return { verdict: "NO_SEND", wire: [], say: "No outbound message recorded for this session. If you believe you sent one, the send never reached the message pipeline: check the tool result." };
  }
  const evs = ledger.eventsBetween(send.ts - 2000, send.ts + win).filter((e) => (!send!.runId || !e.attribution.runId || e.attribution.runId === send!.runId) && (e.category === "channel" || channelOfHost(e.host)));
  const wire = evs.map((e) => ({ ts: e.ts, method: e.method, host: e.host, status: e.status, channel: channelOfHost(e.host) }));
  const bad = wire.filter((w) => typeof w.status !== "number" || w.status >= 400);
  const good = wire.filter((w) => typeof w.status === "number" && w.status < 400);
  const nonHttp = send.channelId ? NON_HTTP_CHANNELS.has(send.channelId.toLowerCase()) : false;
  const when = new Date(send.ts).toISOString().slice(11, 19);

  if (send.cancelled) {
    return { verdict: "CANCELLED", send, wire, say: `The send to ${send.to} at ${when} was cancelled before delivery${send.error ? ` (${send.error})` : ""}. Nothing went out.` };
  }
  if (send.success === false) {
    return { verdict: "NOT_DELIVERED", send, wire, say: `The runtime reported the send to ${send.to} at ${when} as failed${send.error ? `: ${send.error.slice(0, 160)}` : ""}. Do not tell the user it was sent. ${bad.length ? `The wire agrees (${bad.map((w) => `${w.method} ${w.host} → ${w.status ?? "no response"}`).join(", ")}).` : ""}`.trim() };
  }
  if (bad.length && !good.length) {
    return { verdict: "NOT_DELIVERED", send, wire, say: `The runtime reported the send to ${send.to} at ${when} as ${send.success ? "successful" : "pending"}, but the channel API answered ${bad.map((w) => `${w.method} ${w.host} → ${w.status ?? "no response"}`).join(", ")}. Treat it as not delivered; check the channel's error before retrying.` };
  }
  if (send.success && good.length) {
    return { verdict: "DELIVERED", send, wire, say: `Delivered: runtime success and the channel API (${good.map((w) => `${w.host} ${w.status}`).join(", ")}) agree for the send to ${send.to} at ${when}${send.messageId ? ` (message id ${send.messageId})` : ""}.` };
  }
  if (send.success && !wire.length) {
    return {
      verdict: "CLAIMED_ONLY",
      send,
      wire,
      say: nonHttp
        ? `The runtime reported success for ${send.to} at ${when}; channel "${send.channelId}" does not deliver over an HTTPS API this process makes, so the wire cannot confirm it. If delivery matters, verify on the receiving side (read the chat, ask for a reply).`
        : `The runtime reported success for ${send.to} at ${when}, but no request to a channel API was observed within ${Math.round(win / 1000)} s. Either the channel delivers outside this process or nothing left. Do not report "sent" without verifying on the receiving side.`,
    };
  }
  return { verdict: "PENDING", send, wire, say: `The send to ${send.to} at ${when} has no completion recorded yet${good.length ? ` (the wire already shows ${good[0].host} ${good[0].status})` : ""}. Re-check in a few seconds.` };
}

// ------------------------------------------------------- compaction brief

export type Brief = {
  sessionKey?: string;
  compactedAt?: number;
  compactedCount?: number;
  windowStart: number;
  hostsContacted: Array<{ host: string; n: number; failures: number }>;
  blocked: Array<{ host: string; diagnosis: string; say: string }>;
  failedTools: Array<{ tool: string; hint?: string; error?: string; ts: number }>;
  silentFailures: Array<{ tool: string; host: string; status?: number; ts: number }>;
  undelivered: Array<{ to: string; ts: number; verdict: string }>;
  workingRoutes: Array<{ tool: string; host: string; n: number }>;
  lastActions: Array<{ ts: number; tool: string; ok: boolean; hint?: string }>;
  mustNotForget: string[];
  say: string;
};

export function compactionBrief(ledger: Ledger, opts: { sessionKey?: string; windowMinutes?: number } = {}): Brief {
  const sessionKey = opts.sessionKey ?? ledger.recentSessions(1)[0]?.sessionKey;
  const comps = sessionKey ? ledger.compactions(sessionKey) : [];
  const last = comps.filter((c) => c.phase === "after").sort((a, b) => b.ts - a.ts)[0] ?? comps.sort((a, b) => b.ts - a.ts)[0];
  const windowStart = Date.now() - (opts.windowMinutes ?? 24 * 60) * 60_000;
  const outcomes = ledger.toolOutcomes({ sessionKey, sinceTs: windowStart, limit: 2000 }).sort((a, b) => a.ts - b.ts);
  const events = (sessionKey ? ledger.eventsForSession(sessionKey, windowStart) : ledger.recentEvents(2000).filter((e) => e.ts >= windowStart)).filter((e) => e.source === "inproc" && e.category !== "model" && e.category !== "local");

  const hostMap = new Map<string, { n: number; failures: number }>();
  for (const e of events) {
    const h = hostMap.get(e.host) ?? { n: 0, failures: 0 };
    h.n++;
    if (typeof e.status !== "number" || e.status >= 400) h.failures++;
    hostMap.set(e.host, h);
  }
  const hostsContacted = [...hostMap.entries()].map(([host, v]) => ({ host, ...v })).sort((a, b) => b.n - a.n).slice(0, 15);
  const blocked = hostsContacted
    .map((h) => {
      const o = outlookFor(ledger, h.host, 24 * 60);
      return { host: h.host, diagnosis: o.diagnosis, say: o.recommendation };
    })
    .filter((b) => b.diagnosis === "blocked" || b.diagnosis === "rate-limited" || b.diagnosis === "unreachable");
  const failedTools = outcomes.filter((o) => !o.ok).slice(-10).map((o) => ({ tool: o.toolName, hint: o.argHint, error: o.errorText?.slice(0, 120), ts: o.ts }));
  const silentFailures: Brief["silentFailures"] = [];
  for (const o of outcomes.filter((x) => x.ok && x.toolCallId && !x.toolName.startsWith("clawphylax_")).slice(-40)) {
    const r = didItWork(ledger, { toolCallId: o.toolCallId, sessionKey });
    if (r.verdict === "SILENT_FAILURE") {
      const w = r.observed[0];
      silentFailures.push({ tool: o.toolName, host: w?.host ?? "?", status: w?.status, ts: o.ts });
    }
  }
  const undelivered = ledger
    .outbounds({ sessionKey, sinceTs: windowStart, limit: 50 })
    .map((s) => ({ to: s.to, ts: s.ts, verdict: didMessageGoOut(ledger, { sendId: s.id }).verdict }))
    .filter((s) => s.verdict === "NOT_DELIVERED" || s.verdict === "CANCELLED" || s.verdict === "CLAIMED_ONLY");
  const routeMap = new Map<string, number>();
  for (const e of events) {
    if (typeof e.status === "number" && e.status < 400 && e.attribution.toolName) {
      const k = `${e.attribution.toolName}|${e.host}`;
      routeMap.set(k, (routeMap.get(k) ?? 0) + 1);
    }
  }
  const workingRoutes = [...routeMap.entries()].map(([k, n]) => ({ tool: k.split("|")[0], host: k.split("|")[1], n })).sort((a, b) => b.n - a.n).slice(0, 8);
  const before = last ? outcomes.filter((o) => o.ts <= last.ts) : outcomes;
  const lastActions = before.slice(-8).map((o) => ({ ts: o.ts, tool: o.toolName, ok: o.ok, hint: o.argHint }));

  const mustNotForget: string[] = [];
  for (const b of blocked) mustNotForget.push(`${b.host} is ${b.diagnosis} for you — ${b.say.split(". ")[0]}.`);
  for (const s of silentFailures.slice(0, 3)) mustNotForget.push(`${s.tool} on ${s.host} reported ok but the wire answered ${s.status ?? "nothing"} at ${new Date(s.ts).toISOString().slice(11, 19)} — that result is not done.`);
  for (const u of undelivered.slice(0, 3)) mustNotForget.push(`message to ${u.to} at ${new Date(u.ts).toISOString().slice(11, 19)} is ${u.verdict} — do not tell the user it was sent.`);
  const lastFail = failedTools[failedTools.length - 1];
  if (lastFail) mustNotForget.push(`last failed action before now: ${lastFail.tool}${lastFail.hint ? ` ${lastFail.hint}` : ""} (${lastFail.error ?? "no message"}); do not repeat it unchanged.`);
  for (const r of workingRoutes.slice(0, 2)) mustNotForget.push(`${r.tool} works on ${r.host} (${r.n}× ok) — reuse it instead of trying another tool.`);

  const when = last ? new Date(last.ts).toISOString().slice(11, 19) : undefined;
  const say = last
    ? `Your context was compacted at ${when}${last.compactedCount ? ` (${last.compactedCount} messages folded)` : ""}. The ledger still holds what happened before it: ${hostsContacted.length} hosts, ${outcomes.length} tool calls, ${failedTools.length} failures, ${silentFailures.length} silent failures, ${undelivered.length} unconfirmed sends. ${mustNotForget.length ? `Before you continue, carry these forward: ${mustNotForget.slice(0, 3).join(" ")}` : "Nothing in the record contradicts continuing as planned."}`
    : `No compaction recorded for this session${sessionKey ? "" : " (session unknown)"}. Brief from the ledger anyway: ${hostsContacted.length} hosts, ${outcomes.length} tool calls, ${failedTools.length} failures. ${mustNotForget.length ? `Carry forward: ${mustNotForget.slice(0, 3).join(" ")}` : ""}`.trim();
  return { sessionKey, compactedAt: last?.ts, compactedCount: last?.compactedCount, windowStart, hostsContacted, blocked, failedTools, silentFailures, undelivered, workingRoutes, lastActions, mustNotForget, say };
}

// ------------------------------------------------------------- reconcile

export type Claim = { ts: number; kind: "sent" | "published" | "changed" | "verified" | "done"; text: string; status: "SUPPORTED" | "UNSUPPORTED" | "CONTRADICTED"; evidence?: string };

export type Reconciliation = {
  sessionKey?: string;
  transcript?: string;
  claims: Claim[];
  unsupported: number;
  contradicted: number;
  unmentionedFailures: Array<{ ts: number; tool: string; hint?: string; error?: string }>;
  verdict: "RECORD_MATCHES_CLAIMS" | "CLAIMS_EXCEED_RECORD" | "RECORD_EXCEEDS_CLAIMS" | "NO_CLAIMS";
  say: string;
};

const CLAIM_RE: Array<[Claim["kind"], RegExp]> = [
  ["sent", /\b(?:I(?:'ve| have)? |message |reply |email |notification )?(?:sent|delivered|messaged|notified|forwarded|replied)\b/i],
  ["published", /\b(?:published|posted|uploaded|deployed|pushed|submitted|released)\b/i],
  ["changed", /\b(?:created|saved|written|wrote|updated|edited|fixed|installed|configured|scheduled|deleted|removed)\b/i],
  ["verified", /\b(?:verified|confirmed|double-checked|validated|tested and)\b/i],
  ["done", /\b(?:done|completed|finished|all set|task complete)\b/i],
];
const FAILURE_WORDS = /\b(?:fail|failed|error|could not|couldn't|unable|didn't work|did not work|blocked|refused|timed out)\b/i;

function transcriptTurns(text: string): Array<{ ts: number; role: string; text: string; calls: Array<{ name: string; id?: string }> }> {
  const out: Array<{ ts: number; role: string; text: string; calls: Array<{ name: string; id?: string }> }> = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    let line: any;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    const msg = line?.message && typeof line.message === "object" ? line.message : line;
    const role = typeof msg?.role === "string" ? msg.role : undefined;
    if (!role) continue;
    const ts = typeof line?.ts === "number" ? line.ts : typeof line?.timestamp === "number" ? line.timestamp : typeof line?.timestamp === "string" ? Date.parse(line.timestamp) : typeof line?.ts === "string" ? Date.parse(line.ts) : NaN;
    const content = Array.isArray(msg.content) ? msg.content : typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : [];
    const textParts = content.filter((c: any) => c && (c.type === "text" || typeof c.text === "string")).map((c: any) => String(c.text ?? ""));
    const calls = content.filter((c: any) => c && (c.type === "toolCall" || c.type === "tool_use" || c.type === "tool_call")).map((c: any) => ({ name: String(c.name ?? c.function?.name ?? "tool"), id: c.id ?? c.toolCallId }));
    out.push({ ts: Number.isFinite(ts) ? ts : 0, role, text: textParts.join("\n"), calls });
  }
  return out;
}

export function reconcileText(transcript: string, ledger: Ledger, opts: { sessionKey?: string; lookbackMs?: number } = {}): Reconciliation {
  const lookback = opts.lookbackMs ?? 15 * 60_000;
  const turns = transcriptTurns(transcript).filter((t) => t.role === "assistant");
  const first = turns.find((t) => t.ts > 0)?.ts ?? 0;
  const outcomes = ledger.toolOutcomes({ sessionKey: opts.sessionKey, sinceTs: first ? first - lookback : 0, limit: 5000 });
  const sends = ledger.outbounds({ sessionKey: opts.sessionKey, sinceTs: first ? first - lookback : 0, limit: 500 });
  const events = (opts.sessionKey ? ledger.eventsForSession(opts.sessionKey, first ? first - lookback : 0) : ledger.recentEvents(5000)).filter((e) => e.source === "inproc");

  const claims: Claim[] = [];
  for (const t of turns) {
    if (!t.text.trim() || t.ts === 0) continue;
    // A sentence that reports success; skip sentences that report failure.
    for (const sentence of t.text.split(/(?<=[.!?\n])\s+/)) {
      if (FAILURE_WORDS.test(sentence)) continue;
      const hit = CLAIM_RE.find(([, re]) => re.test(sentence));
      if (!hit) continue;
      const kind = hit[0];
      const from = t.ts - lookback;
      let status: Claim["status"] = "UNSUPPORTED";
      let evidence: string | undefined;
      if (kind === "sent") {
        const s = sends.filter((x) => x.ts >= from && x.ts <= t.ts + 5000).sort((a, b) => b.ts - a.ts)[0];
        if (s) {
          const r = didMessageGoOut(ledger, { sendId: s.id });
          status = r.verdict === "DELIVERED" ? "SUPPORTED" : r.verdict === "NOT_DELIVERED" || r.verdict === "CANCELLED" ? "CONTRADICTED" : "UNSUPPORTED";
          evidence = `send to ${s.to} at ${new Date(s.ts).toISOString().slice(11, 19)}: ${r.verdict}`;
        } else {
          evidence = "no outbound message in the record before this sentence";
        }
      } else if (kind === "published") {
        const w = events.filter((e) => e.ts >= from && e.ts <= t.ts + 5000 && /^(POST|PUT|PATCH)$/i.test(e.method) && e.category !== "model").sort((a, b) => b.ts - a.ts);
        if (w.length) {
          const ok = w.find((e) => typeof e.status === "number" && e.status < 400);
          status = ok ? "SUPPORTED" : "CONTRADICTED";
          evidence = `${w[0].method} ${w[0].host} → ${w[0].status ?? "no response"}`;
        } else {
          const ex = outcomes.filter((o) => o.ts >= from && o.ts <= t.ts + 5000 && /^(exec|bash)$/.test(o.toolName)).sort((a, b) => b.ts - a.ts)[0];
          if (ex) {
            status = ex.ok ? "UNSUPPORTED" : "CONTRADICTED";
            evidence = `${ex.toolName} ${ex.argHint ?? ""} ${ex.ok ? "ok (child process — wire not observed)" : "failed"}`;
          } else evidence = "no POST/PUT and no exec in the record before this sentence";
        }
      } else if (kind === "changed") {
        const a = outcomes.filter((o) => o.ts >= from && o.ts <= t.ts + 5000 && /^(write|edit|apply_patch|exec|bash|cron|plugins|message)$/.test(o.toolName)).sort((x, y) => y.ts - x.ts)[0];
        if (a) {
          status = a.ok ? "SUPPORTED" : "CONTRADICTED";
          evidence = `${a.toolName} ${a.argHint ?? ""} ${a.ok ? "ok" : `failed: ${a.errorText?.slice(0, 80) ?? ""}`}`;
        } else evidence = "no write/edit/exec in the record before this sentence";
      } else if (kind === "verified") {
        const v = outcomes.filter((o) => o.ts >= from && o.ts <= t.ts + 5000 && (o.toolName.startsWith("clawphylax_") || /^(read|web_fetch|browser)$/.test(o.toolName))).sort((x, y) => y.ts - x.ts)[0];
        status = v ? "SUPPORTED" : "UNSUPPORTED";
        evidence = v ? `${v.toolName} at ${new Date(v.ts).toISOString().slice(11, 19)}` : "no check, read or fetch in the record before this sentence";
      } else {
        const lastFail = outcomes.filter((o) => o.ts >= from && o.ts <= t.ts + 5000 && !o.ok).sort((x, y) => y.ts - x.ts)[0];
        const lastOk = outcomes.filter((o) => o.ts >= from && o.ts <= t.ts + 5000 && o.ok && !o.toolName.startsWith("clawphylax_")).sort((x, y) => y.ts - x.ts)[0];
        status = lastFail && (!lastOk || lastFail.ts > lastOk.ts) ? "CONTRADICTED" : lastOk ? "SUPPORTED" : "UNSUPPORTED";
        evidence = lastFail && (!lastOk || lastFail.ts > lastOk.ts) ? `last action before "done" failed: ${lastFail.toolName} ${lastFail.errorText?.slice(0, 80) ?? ""}` : lastOk ? `last action ${lastOk.toolName} ok` : "no action in the record before this sentence";
      }
      claims.push({ ts: t.ts, kind, text: sentence.trim().slice(0, 140), status, evidence });
      if (claims.length >= 40) break;
    }
  }

  // Failures the narrative never mentioned: a failed tool call with no failure word in the next assistant text.
  const unmentionedFailures: Reconciliation["unmentionedFailures"] = [];
  for (const o of outcomes.filter((x) => !x.ok && !x.toolName.startsWith("clawphylax_"))) {
    const next = turns.find((t) => t.ts > o.ts && t.text.trim());
    if (next && !FAILURE_WORDS.test(next.text)) unmentionedFailures.push({ ts: o.ts, tool: o.toolName, hint: o.argHint, error: o.errorText?.slice(0, 100) });
    if (unmentionedFailures.length >= 10) break;
  }

  const unsupported = claims.filter((c) => c.status === "UNSUPPORTED").length;
  const contradicted = claims.filter((c) => c.status === "CONTRADICTED").length;
  let verdict: Reconciliation["verdict"] = "RECORD_MATCHES_CLAIMS";
  if (!claims.length) verdict = "NO_CLAIMS";
  else if (contradicted || unsupported >= Math.max(2, claims.length / 3)) verdict = "CLAIMS_EXCEED_RECORD";
  else if (unmentionedFailures.length) verdict = "RECORD_EXCEEDS_CLAIMS";
  const worst = claims.find((c) => c.status === "CONTRADICTED") ?? claims.find((c) => c.status === "UNSUPPORTED");
  const say =
    verdict === "NO_CLAIMS"
      ? `No success claims found in this session's transcript${turns.length ? ` (${turns.length} assistant turns)` : ""}. Nothing to reconcile yet.`
      : verdict === "CLAIMS_EXCEED_RECORD"
        ? `You believe more happened than the record shows: ${contradicted} claim${contradicted === 1 ? "" : "s"} contradicted, ${unsupported} without evidence, of ${claims.length}. Worst: "${worst?.text}" — ${worst?.evidence}. Correct what you told the user before doing anything else.`
        : verdict === "RECORD_EXCEEDS_CLAIMS"
          ? `Your claims hold (${claims.length - unsupported} of ${claims.length} supported), but ${unmentionedFailures.length} failed action${unmentionedFailures.length === 1 ? "" : "s"} never appeared in what you said, e.g. ${unmentionedFailures[0].tool} ${unmentionedFailures[0].hint ?? ""} (${unmentionedFailures[0].error ?? "no message"}). Say what failed.`
          : `Record matches claims: ${claims.length - unsupported} of ${claims.length} success claims have evidence, no contradictions, no unmentioned failures.`;
  return { sessionKey: opts.sessionKey, claims, unsupported, contradicted, unmentionedFailures, verdict, say };
}

export function reconcile(ledger: Ledger, opts: { sessionKey?: string; sessionId?: string; root?: string } = {}): Reconciliation {
  const files = findTranscripts(opts.root);
  let file: string | undefined;
  if (opts.sessionId) file = files.find((f) => f.includes(opts.sessionId!));
  if (!file) {
    file = files
      .map((f) => ({ f, m: (() => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } })() }))
      .sort((a, b) => b.m - a.m)[0]?.f;
  }
  if (!file) {
    return { sessionKey: opts.sessionKey, claims: [], unsupported: 0, contradicted: 0, unmentionedFailures: [], verdict: "NO_CLAIMS", say: "No session transcript found under the OpenClaw state directory." };
  }
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    /* ignore */
  }
  const r = reconcileText(text, ledger, { sessionKey: opts.sessionKey });
  r.transcript = file;
  return r;
}

export function renderClaims(r: Reconciliation): string {
  return r.claims
    .slice(0, 12)
    .map((c) => `${new Date(c.ts).toISOString().slice(11, 19)} ${c.status.padEnd(12)} [${c.kind}] "${c.text}" — ${c.evidence ?? ""}`)
    .join("\n");
}

export type { ToolOutcome, EgressEvent };

// ---------------------------------------------------- request ↔ reply match
//
// Did the reply that went out correspond to the request that came in, and did
// the processing in between make sense? No model is consulted: the inbound and
// outbound texts are reduced to keyword fingerprints at hook time (the texts
// themselves are not stored), the request's action verbs are compared with the
// actions actually taken, and the effort is compared with the request size.

const STOP = new Set("the and for with that this from have your will you are was were been what when where which who how can could would should about into over under then than there their them they our out not but all any some more most very just also like into onto per via please thank thanks hello okay ok yes no".split(" "));

export function keywordsOf(text: string, max = 24): string[] {
  const counts = new Map<string, number>();
  for (const w of (text ?? "").toLowerCase().replace(/https?:\/\/\S+/g, " url ").match(/[a-zà-ÿ0-9][a-zà-ÿ0-9_-]{3,}/g) ?? []) {
    if (STOP.has(w)) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([w]) => w);
}

const ASKS: Array<[string, RegExp, RegExp]> = [
  // ask name, request verb pattern, tool names / evidence that count as doing it
  ["send", /\b(send|forward|message|notify|email|text|reply to|tell)\b/i, /^(message|sessions_send|conversations_send)$/],
  ["fetch", /\b(fetch|look up|lookup|search|find|check|read|get me|what is|what's|show me|status of)\b/i, /^(web_fetch|web_search|x_search|browser|read|memory_search|sessions_history|session_status|gateway)$/],
  ["create", /\b(create|write|make|draft|generate|add|set up|setup|build|save)\b/i, /^(write|edit|apply_patch|exec|bash|cron|image_generate|create_goal)$/],
  ["change", /\b(update|change|edit|fix|rename|move|delete|remove|install|configure|schedule|cancel)\b/i, /^(edit|write|apply_patch|exec|bash|cron|plugins|update_goal)$/],
  ["run", /\b(run|execute|restart|start|stop|deploy|test)\b/i, /^(exec|bash|process|code_execution)$/],
];

export function asksOf(text: string): string[] {
  return ASKS.filter(([, re]) => re.test(text ?? "")).map(([n]) => n);
}

export type TaskMatch = {
  verdict: "COHERENT" | "PARTIAL" | "INCOHERENT" | "NO_PAIR";
  inbound?: { ts: number; len: number; keywords: string[]; asks: string[] };
  outbound?: { ts: number; len: number; keywords: string[]; to: string; delivery: string };
  overlap: number;
  asksDone: string[];
  asksMissing: string[];
  toolCalls: number;
  failedCalls: number;
  hosts: string[];
  seconds: number;
  reasons: string[];
  say: string;
};

export function taskMatch(ledger: Ledger, opts: { sessionKey?: string } = {}): TaskMatch {
  const sessionKey = opts.sessionKey ?? ledger.recentSessions(1)[0]?.sessionKey;
  const inb = sessionKey ? ledger.originFor(sessionKey) : undefined;
  const out = ledger.outbounds({ sessionKey, limit: 1 })[0];
  const empty = { overlap: 0, asksDone: [], asksMissing: [], toolCalls: 0, failedCalls: 0, hosts: [], seconds: 0, reasons: [] };
  if (!inb || !out || out.ts < inb.ts) {
    return { verdict: "NO_PAIR", ...empty, say: !inb ? "No inbound message recorded for this session, so there is no request to compare the reply with." : "No reply recorded after the last inbound message yet." };
  }
  const inK = inb.keywords ?? [];
  const outK = out.keywords ?? [];
  const inter = inK.filter((k) => outK.includes(k));
  const overlap = inK.length ? inter.length / Math.min(inK.length, 12) : 0;
  const outcomes = ledger.toolOutcomes({ sessionKey, sinceTs: inb.ts, limit: 2000 }).filter((o) => o.ts <= out.ts + 2000 && !o.toolName.startsWith("clawphylax_"));
  const events = ledger.eventsBetween(inb.ts, out.ts + 2000).filter((e) => e.source === "inproc" && e.category !== "model" && e.category !== "channel" && (!e.attribution.sessionKey || e.attribution.sessionKey === sessionKey));
  const asks = inb.asks ?? [];
  const asksDone = asks.filter((a) => {
    const spec = ASKS.find(([n]) => n === a)!;
    return outcomes.some((o) => o.ok && spec[2].test(o.toolName)) || (a === "fetch" && events.some((e) => typeof e.status === "number" && e.status < 400));
  });
  const asksMissing = asks.filter((a) => !asksDone.includes(a));
  const failedCalls = outcomes.filter((o) => !o.ok).length;
  const hosts = [...new Set(events.map((e) => e.host))].slice(0, 8);
  const seconds = Math.round((out.ts - inb.ts) / 1000);
  const delivery = didMessageGoOut(ledger, { sendId: out.id }).verdict;

  const reasons: string[] = [];
  let score = 0; // 0 good … 3 bad
  if (inK.length >= 3 && overlap < 0.15) {
    score += 2;
    reasons.push(`the reply shares ${inter.length} of the request's ${Math.min(inK.length, 12)} key terms`);
  } else if (inK.length >= 3 && overlap < 0.35) {
    score += 1;
    reasons.push(`the reply shares only ${inter.length} of the request's ${Math.min(inK.length, 12)} key terms`);
  }
  if (asksMissing.length) {
    score += asksMissing.length >= asks.length ? 2 : 1;
    reasons.push(`the request asked to ${asksMissing.join(" and ")}, and no such action succeeded in between (${outcomes.length} tool calls, ${failedCalls} failed)`);
  }
  if (out.len < 20 && inb.len > 80) {
    score += 1;
    reasons.push(`a ${inb.len}-character request got a ${out.len}-character reply`);
  }
  if (inb.len < 40 && asks.length === 0 && outcomes.length >= 8) {
    score += 1;
    reasons.push(`a ${inb.len}-character message with no request in it triggered ${outcomes.length} tool calls`);
  }
  if (delivery === "NOT_DELIVERED" || delivery === "CANCELLED") {
    score += 2;
    reasons.push(`the reply was ${delivery}`);
  }
  const verdict: TaskMatch["verdict"] = score >= 3 ? "INCOHERENT" : score >= 1 ? "PARTIAL" : "COHERENT";
  const say =
    verdict === "COHERENT"
      ? `Coherent: the reply covers the request (${inter.length} shared key terms${asks.length ? `, asked to ${asks.join("/")} and did` : ""}), ${outcomes.length} tool calls over ${seconds} s${hosts.length ? ` touching ${hosts.slice(0, 3).join(", ")}` : ""}, delivery ${delivery}.`
      : verdict === "PARTIAL"
        ? `Partly: ${reasons.join("; ")}. Before you move on, re-read the request and answer the part you skipped.`
        : `The reply does not match the request: ${reasons.join("; ")}. Do not consider this turn handled. Re-read the request, do the missing action or say plainly that you could not, and reply again.`;
  return { verdict, inbound: { ts: inb.ts, len: inb.len, keywords: inK, asks }, outbound: { ts: out.ts, len: out.len, keywords: outK, to: out.to, delivery }, overlap, asksDone, asksMissing, toolCalls: outcomes.length, failedCalls, hosts, seconds, reasons, say };
}
