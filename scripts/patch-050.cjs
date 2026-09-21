// 0.5.0 — messaging: send check, sent (hook × wire), compaction brief, task match, reconcile.
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
let L = rd("src/ledger.ts");
L = must(L, `export function defaultLedgerPath(): string {`, `export type OutboundRow = {
  id: number;
  ts: number;
  runId?: string;
  sessionKey?: string;
  channelId?: string;
  conversationId?: string;
  to: string;
  len: number;
  keywords?: string[];
  secretKinds?: string[];
  cancelled: boolean;
  sentTs?: number;
  success?: boolean;
  error?: string;
  messageId?: string;
};

export type InboundRow = { ts: number; sessionKey?: string; channelId?: string; conversationId?: string; from?: string; len: number; keywords?: string[]; asks?: string[] };

export type CompactionRow = { ts: number; sessionKey?: string; phase: "before" | "after"; messageCount?: number; compactedCount?: number; tokenCount?: number };

function rowToOutbound(r: any): OutboundRow {
  return {
    id: r.id,
    ts: r.ts,
    runId: r.run_id ?? undefined,
    sessionKey: r.session_key ?? undefined,
    channelId: r.channel_id ?? undefined,
    conversationId: r.conversation_id ?? undefined,
    to: r.to_target ?? "",
    len: r.content_len ?? 0,
    keywords: r.keywords ? String(r.keywords).split(" ").filter(Boolean) : undefined,
    secretKinds: r.secret_kinds ? String(r.secret_kinds).split(",").filter(Boolean) : undefined,
    cancelled: !!r.cancelled,
    sentTs: r.sent_ts ?? undefined,
    success: r.success === null || r.success === undefined ? undefined : !!r.success,
    error: r.error ?? undefined,
    messageId: r.message_id ?? undefined,
  };
}

export function defaultLedgerPath(): string {`, "ledger types");

L = must(L, `      CREATE TABLE IF NOT EXISTS rules (`, `      CREATE TABLE IF NOT EXISTS inbound (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        session_key TEXT,
        channel_id TEXT,
        conversation_id TEXT,
        from_id TEXT,
        content_len INTEGER NOT NULL DEFAULT 0,
        keywords TEXT,
        asks TEXT
      );
      CREATE INDEX IF NOT EXISTS inbound_session ON inbound(session_key, ts);
      CREATE TABLE IF NOT EXISTS outbound (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        run_id TEXT,
        session_key TEXT,
        channel_id TEXT,
        conversation_id TEXT,
        to_target TEXT NOT NULL,
        content_len INTEGER NOT NULL DEFAULT 0,
        keywords TEXT,
        secret_kinds TEXT,
        cancelled INTEGER NOT NULL DEFAULT 0,
        sent_ts INTEGER,
        success INTEGER,
        error TEXT,
        message_id TEXT
      );
      CREATE INDEX IF NOT EXISTS outbound_session ON outbound(session_key, ts);
      CREATE TABLE IF NOT EXISTS compactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        session_key TEXT,
        phase TEXT NOT NULL,
        message_count INTEGER,
        compacted_count INTEGER,
        token_count INTEGER
      );
      CREATE TABLE IF NOT EXISTS rules (`, "ledger tables");

L = must(L, `  getSetting(key: string): string | undefined {`, `  // ------------------------------------------------------------ messaging

  recordInbound(r: InboundRow): void {
    this.db
      .prepare("INSERT INTO inbound (ts, session_key, channel_id, conversation_id, from_id, content_len, keywords, asks) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(r.ts, r.sessionKey ?? null, r.channelId ?? null, r.conversationId ?? null, r.from ? r.from.slice(0, 120) : null, r.len, r.keywords?.join(" ") ?? null, r.asks?.join(",") ?? null);
  }

  /** The conversation this session is replying in: its latest inbound message. */
  originFor(sessionKey: string): InboundRow | undefined {
    const r = this.db.prepare("SELECT * FROM inbound WHERE session_key = ? ORDER BY ts DESC LIMIT 1").get(sessionKey) as any;
    if (!r) return undefined;
    return { ts: r.ts, sessionKey: r.session_key ?? undefined, channelId: r.channel_id ?? undefined, conversationId: r.conversation_id ?? undefined, from: r.from_id ?? undefined, len: r.content_len ?? 0, keywords: r.keywords ? String(r.keywords).split(" ").filter(Boolean) : [], asks: r.asks ? String(r.asks).split(",").filter(Boolean) : [] };
  }

  recordOutbound(o: Omit<OutboundRow, "id">): number {
    const res = this.db
      .prepare("INSERT INTO outbound (ts, run_id, session_key, channel_id, conversation_id, to_target, content_len, keywords, secret_kinds, cancelled, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(o.ts, o.runId ?? null, o.sessionKey ?? null, o.channelId ?? null, o.conversationId ?? null, o.to.slice(0, 200), o.len, o.keywords?.join(" ") ?? null, o.secretKinds?.join(",") ?? null, o.cancelled ? 1 : 0, o.error ?? null);
    return Number(res.lastInsertRowid);
  }

  /** Completion of a send (message_sent): matched to the latest open outbound with the same target. */
  markSent(s: { ts: number; sessionKey?: string; to: string; success: boolean; error?: string; messageId?: string }): boolean {
    const row = this.db
      .prepare("SELECT id FROM outbound WHERE to_target = ? AND sent_ts IS NULL AND ts >= ? " + (s.sessionKey ? "AND (session_key = ? OR session_key IS NULL) " : "") + "ORDER BY ts DESC LIMIT 1")
      .get(...(s.sessionKey ? [s.to.slice(0, 200), s.ts - 10 * 60_000, s.sessionKey] : [s.to.slice(0, 200), s.ts - 10 * 60_000])) as { id: number } | undefined;
    if (!row) return false;
    this.db.prepare("UPDATE outbound SET sent_ts = ?, success = ?, error = COALESCE(?, error), message_id = ? WHERE id = ?").run(s.ts, s.success ? 1 : 0, s.error ? s.error.slice(0, 300) : null, s.messageId ?? null, row.id);
    return true;
  }

  outbound(id: number): OutboundRow | undefined {
    const r = this.db.prepare("SELECT * FROM outbound WHERE id = ?").get(id) as any;
    return r ? rowToOutbound(r) : undefined;
  }

  outbounds(opts: { sessionKey?: string; sinceTs?: number; limit?: number } = {}): OutboundRow[] {
    const where: string[] = ["ts >= ?"];
    const args: any[] = [opts.sinceTs ?? 0];
    if (opts.sessionKey) {
      where.push("session_key = ?");
      args.push(opts.sessionKey);
    }
    args.push(opts.limit ?? 50);
    return (this.db.prepare(\`SELECT * FROM outbound WHERE \${where.join(" AND ")} ORDER BY ts DESC LIMIT ?\`).all(...args) as any[]).map(rowToOutbound);
  }

  recordCompaction(c: CompactionRow): void {
    this.db.prepare("INSERT INTO compactions (ts, session_key, phase, message_count, compacted_count, token_count) VALUES (?, ?, ?, ?, ?, ?)").run(c.ts, c.sessionKey ?? null, c.phase, c.messageCount ?? null, c.compactedCount ?? null, c.tokenCount ?? null);
  }

  compactions(sessionKey: string, limit = 20): CompactionRow[] {
    return (this.db.prepare("SELECT * FROM compactions WHERE session_key = ? ORDER BY ts DESC LIMIT ?").all(sessionKey, limit) as any[]).map((r) => ({ ts: r.ts, sessionKey: r.session_key ?? undefined, phase: r.phase, messageCount: r.message_count ?? undefined, compactedCount: r.compacted_count ?? undefined, tokenCount: r.token_count ?? undefined }));
  }

  eventsBetween(fromTs: number, toTs: number, limit = 2000): EgressEvent[] {
    return (this.db.prepare("SELECT * FROM events WHERE ts >= ? AND ts <= ? ORDER BY ts LIMIT ?").all(fromTs, toTs, limit) as any[]).map(rowToEvent);
  }

  getSetting(key: string): string | undefined {`, "ledger methods");
wr("src/ledger.ts", L);

// -------------------------------------------------------------------- core
let C = rd("src/core.ts");
C = must(C, `import { renderRunFooter } from "./report.js";`, `import { renderRunFooter } from "./report.js";
import { asksOf, keywordsOf } from "./messaging.js";
import { findSecretShapes } from "./secrets.js";`, "core imports");
C = must(C, `export type HookContext = {`, `export type MsgCtx = { channelId?: string; conversationId?: string; accountId?: string };

export type HookContext = {`, "core msgctx");
C = must(C, `  /** Footer for the reply of this run, if anything is worth a look. Consumes the run buffer. */`, `  // ------------------------------------------------------------ messaging
  // Texts are reduced to keyword fingerprints at the hook; the texts themselves
  // are never written to the ledger.

  messageReceived(ev: { from?: string; content?: string; sessionKey?: string; runId?: string }, ctx: HookContext, m: MsgCtx = {}): void {
    const sessionKey = ev.sessionKey ?? ctx.sessionKey;
    if (sessionKey) {
      this.lastSessionKey = sessionKey;
    }
    try {
      const content = ev.content ?? "";
      this.ledger.recordInbound({ ts: Date.now(), sessionKey, channelId: m.channelId, conversationId: m.conversationId, from: ev.from, len: content.length, keywords: keywordsOf(content), asks: asksOf(content) });
    } catch (err: any) {
      this.log.warn("inbound not recorded: " + (err?.message ?? err));
    }
  }

  /** Records the outbound message; in enforce mode cancels one that carries a secret-shaped value. */
  messageSending(ev: { to?: string; content?: string; runId?: string }, ctx: HookContext, m: MsgCtx = {}): { cancel: boolean; cancelReason?: string } {
    const content = ev.content ?? "";
    const secrets = findSecretShapes(content);
    const cancel = this.cfg.mode === "enforce" && secrets.length > 0;
    try {
      this.ledger.recordOutbound({
        ts: Date.now(),
        runId: ev.runId ?? ctx.runId,
        sessionKey: ctx.sessionKey ?? this.lastSessionKey,
        channelId: m.channelId,
        conversationId: m.conversationId,
        to: ev.to ?? "",
        len: content.length,
        keywords: keywordsOf(content),
        secretKinds: secrets.map((s) => s.kind),
        cancelled: cancel,
        error: cancel ? "cancelled by ClawPhylax enforce: secret-shaped value in outbound message" : undefined,
      });
    } catch (err: any) {
      this.log.warn("outbound not recorded: " + (err?.message ?? err));
    }
    if (cancel) {
      return { cancel: true, cancelReason: \`ClawPhylax: the message contains a secret-shaped value (\${secrets.map((s) => s.kind).join(", ")}); enforce mode does not send it. Remove the value and send again.\` };
    }
    return { cancel: false };
  }

  messageSent(ev: { to?: string; success?: boolean; error?: string; messageId?: string; sessionKey?: string }, ctx: HookContext): void {
    try {
      this.ledger.markSent({ ts: Date.now(), sessionKey: ev.sessionKey ?? ctx.sessionKey ?? this.lastSessionKey, to: ev.to ?? "", success: ev.success !== false, error: ev.error, messageId: ev.messageId });
    } catch (err: any) {
      this.log.warn("sent not recorded: " + (err?.message ?? err));
    }
  }

  compaction(phase: "before" | "after", ev: { messageCount?: number; compactedCount?: number; compactingCount?: number; tokenCount?: number }, ctx: HookContext): void {
    try {
      this.ledger.recordCompaction({ ts: Date.now(), sessionKey: ctx.sessionKey ?? this.lastSessionKey, phase, messageCount: ev.messageCount, compactedCount: ev.compactedCount ?? ev.compactingCount, tokenCount: ev.tokenCount });
    } catch (err: any) {
      this.log.warn("compaction not recorded: " + (err?.message ?? err));
    }
  }

  /** Footer for the reply of this run, if anything is worth a look. Consumes the run buffer. */`, "core methods");
wr("src/core.ts", C);

// ------------------------------------------------------------------- index
let I = rd("src/index.ts");
I = must(I, `import { renderRecord, SCOPE_LOCAL } from "./record.js";`, `import { renderRecord, SCOPE_LOCAL } from "./record.js";
import { compactionBrief, didMessageGoOut, reconcile, renderClaims, sendCheck, taskMatch } from "./messaging.js";`, "index imports");
I = must(I, `function hookCtx(c: unknown): HookContext {`, `function msgCtx(c: unknown): { channelId?: string; conversationId?: string; accountId?: string } {
  const o = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
  return { channelId: str(o.channelId), conversationId: str(o.conversationId), accountId: str(o.accountId) };
}

function hookCtx(c: unknown): HookContext {`, "index msgctx");

I = must(I, `    api.registerTool({
      name: "clawphylax_failures",`, `    api.registerTool({
      name: "clawphylax_send_check",
      description:
        "Is this safe to send? Use this before sending a message to any target other than the conversation you are replying in, before forwarding content, and whenever the text could contain a credential. Checks the target against this session's origin conversation and earlier sends, and scans the text for secret-shaped values (API keys, tokens, private keys) and credential file paths. Returns exactly SEND, CONFIRM_WITH_USER or DO_NOT_SEND with reasons. Do not use for a plain reply in the same conversation with no sensitive content.",
      parameters: Type.Object({ to: Type.String({ description: "Target as the message tool would receive it (chat id, channel, user)." }), content: Type.String(), sessionKey: Type.Optional(Type.String()) }),
      async execute(_id: string, p: { to: string; content: string; sessionKey?: string }) {
        const r = sendCheck(core.ledger, { to: p.to, content: p.content, sessionKey: p?.sessionKey ?? core.lastSessionKey });
        return text(
          renderRecord({
            action: r.verdict,
            evidence: r.reasons.length ? r.reasons.join("; ") : \`same conversation, no secret-shaped values, target seen before\`,
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
            evidence: \`runtime: \${r.send ? (r.send.cancelled ? "cancelled" : r.send.success === undefined ? "no completion yet" : r.send.success ? "success" : \`failed\${r.send.error ? " (" + r.send.error.slice(0, 80) + ")" : ""}\`) : "no send"}; wire: \${r.wire.length ? r.wire.map((w) => \`\${w.method} \${w.host} → \${w.status ?? "no response"}\`).join(", ") : "no channel API request observed"}\`,
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
            evidence: \`\${r.compactedAt ? \`compacted at \${new Date(r.compactedAt).toISOString().slice(11, 19)}\` : "no compaction recorded"}; \${r.hostsContacted.length} hosts, \${r.failedTools.length} failed actions, \${r.silentFailures.length} silent failures, \${r.undelivered.length} unconfirmed sends, \${r.workingRoutes.length} working routes\`,
            doNot: r.mustNotForget.length ? "repeat a blocked host or a failed action unchanged" : undefined,
            next: r.mustNotForget.length ? \`MUST NOT FORGET: \${r.mustNotForget.join(" | ")}\` : r.say,
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
            evidence: r.inbound ? \`request \${r.inbound.len} chars asking to \${r.inbound.asks.join("/") || "(nothing specific)"}; reply \${r.outbound?.len} chars, \${Math.round(r.overlap * 100)}% key-term overlap; \${r.toolCalls} tool calls (\${r.failedCalls} failed) over \${r.seconds} s\${r.hosts.length ? " via " + r.hosts.slice(0, 3).join(", ") : ""}; delivery \${r.outbound?.delivery}\` : r.say,
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
            evidence: \`\${r.claims.length} claims: \${r.claims.length - r.unsupported - r.contradicted} supported, \${r.unsupported} unsupported, \${r.contradicted} contradicted; \${r.unmentionedFailures.length} unmentioned failures\${r.transcript ? "" : "; no transcript"}\`,
            doNot: r.verdict === "CLAIMS_EXCEED_RECORD" ? "repeat a claim marked CONTRADICTED or UNSUPPORTED" : undefined,
            next: r.say,
            scope: SCOPE_LOCAL,
          }) + (r.claims.length ? "\\n\\n" + renderClaims(r) : ""),
          r,
        );
      },
    });
    api.registerTool({
      name: "clawphylax_failures",`, "index tools");

I = must(I, `          if (sub === "tokens") {`, `          if (sub === "send") {
            const [to, ...restText] = arg.split(" :: ");
            if (!to || !restText.length) return { text: "Usage: /phylax send <target> :: <text>" };
            const r = sendCheck(core.ledger, { to, content: restText.join(" :: "), sessionKey: core.lastSessionKey });
            return { text: \`\${r.verdict}: \${r.say}\` };
          }
          if (sub === "sent") {
            const r = didMessageGoOut(core.ledger, { sessionKey: core.lastSessionKey, sendId: arg ? Number(arg) : undefined });
            return { text: \`\${r.verdict}: \${r.say}\` };
          }
          if (sub === "brief") {
            const r = compactionBrief(core.ledger, { sessionKey: core.lastSessionKey });
            return { text: \`\${r.say}\${r.mustNotForget.length ? "\\n\\nMUST NOT FORGET:\\n- " + r.mustNotForget.join("\\n- ") : ""}\` };
          }
          if (sub === "match") {
            const r = taskMatch(core.ledger, { sessionKey: core.lastSessionKey });
            return { text: \`\${r.verdict}: \${r.say}\` };
          }
          if (sub === "reconcile") {
            const r = reconcile(core.ledger, { sessionKey: core.lastSessionKey });
            return { text: \`\${r.verdict}: \${r.say}\${r.claims.length ? "\\n\\n" + renderClaims(r) : ""}\` };
          }
          if (sub === "tokens") {`, "index commands");
I = must(I, `check [toolCallId] |`, `check [toolCallId] | send <to> :: <text> | sent [id] | brief | match | reconcile |`, "index usage");
I = must(I, `after any action whose effect matters, run clawphylax_did_it_work before building on the result.`, `after any action whose effect matters, run clawphylax_did_it_work before building on the result; before sending to a target other than the conversation you are replying in, run clawphylax_send_check; after a send whose delivery matters, run clawphylax_sent before saying it was sent; after a context compaction, run clawphylax_compaction_brief before continuing; before reporting a task as done, run clawphylax_reconcile and clawphylax_task_match.`, "index guidance");

I = must(I, `        const runId = hookCtx(ctx).runId ?? str(e.runId);
        const footer = core.footerForRun(runId);`, `        const runId = hookCtx(ctx).runId ?? str(e.runId);
        const gate = core.messageSending({ to: str(e.to), content: typeof e.content === "string" ? e.content : "", runId }, hookCtx(ctx), msgCtx(ctx));
        if (gate.cancel) {
          return { cancel: true, cancelReason: gate.cancelReason };
        }
        const footer = core.footerForRun(runId);`, "index message_sending");

I = must(I, `    // Append a one-line summary to the reply when the run touched new or`, `    // Messaging and compaction: the two halves of "did that message go out"
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

    // Append a one-line summary to the reply when the run touched new or`, "index hooks");
wr("src/index.ts", I);

// --------------------------------------------------------------------- cli
let K = rd("src/cli.ts");
const firstImport = K.indexOf("import ");
K = K.slice(0, firstImport) + `import { compactionBrief, didMessageGoOut, reconcile, renderClaims, sendCheck, taskMatch } from "./messaging.js";\n` + K.slice(firstImport);
K = must(K, `  root.command("failures")`, `  root.command("send").description("Is this safe to send? Check a target and text before sending").argument("<to>").argument("<text...>").option("--session <key>").option("--json").option("--db <path>").action((to: string, words: string[], o: Record<string, unknown>) =>
    withLedger(o, (l) => { const r = sendCheck(l, { to, content: words.join(" "), sessionKey: o.session as string | undefined }); return J(o, r, \`\${r.verdict}: \${r.say}\`); }));
  root.command("sent").description("Did my message actually go out? Runtime result cross-checked against the channel API on the wire").argument("[sendId]").option("--session <key>").option("--json").option("--db <path>").action((id: string | undefined, o: Record<string, unknown>) =>
    withLedger(o, (l) => { const r = didMessageGoOut(l, { sendId: id ? Number(id) : undefined, sessionKey: o.session as string | undefined }); return J(o, r, \`\${r.verdict}: \${r.say}\`); }));
  root.command("brief").description("What did I lose in compaction? Rebuild what happened before the cut, with a MUST NOT FORGET list").option("--session <key>").option("--window <minutes>", "look-back", "1440").option("--json").option("--db <path>").action((o: Record<string, unknown>) =>
    withLedger(o, (l) => { const r = compactionBrief(l, { sessionKey: o.session as string | undefined, windowMinutes: Number(o.window ?? 1440) }); return J(o, r, \`\${r.say}\${r.mustNotForget.length ? "\\n\\nMUST NOT FORGET:\\n- " + r.mustNotForget.join("\\n- ") : ""}\`); }));
  root.command("match").description("Did I do what was asked? Request vs reply vs the actions in between").option("--session <key>").option("--json").option("--db <path>").action((o: Record<string, unknown>) =>
    withLedger(o, (l) => { const r = taskMatch(l, { sessionKey: o.session as string | undefined }); return J(o, r, \`\${r.verdict}: \${r.say}\`); }));
  root.command("reconcile").description("What do I believe I did vs what the record shows? Transcript claims checked against the ledger").option("--session <key>").option("--transcript <sessionId>").option("--json").option("--db <path>").action((o: Record<string, unknown>) =>
    withLedger(o, (l) => { const r = reconcile(l, { sessionKey: o.session as string | undefined, sessionId: o.transcript as string | undefined }); return J(o, r, \`\${r.verdict}: \${r.say}\${r.claims.length ? "\\n\\n" + renderClaims(r) : ""}\`); }));
  root.command("failures")`, "cli commands");
wr("src/cli.ts", K);

// ---------------------------------------------------------------- versions
for (const f of ["package.json", "openclaw.plugin.json"]) {
  let s = rd(f);
  s = must(s, `"version": "0.4.0"`, `"version": "0.5.0"`, f + " version");
  wr(f, s);
}
let M = rd("openclaw.plugin.json");
M = must(M, `"clawphylax_did_it_work"`, `"clawphylax_did_it_work",
      "clawphylax_send_check",
      "clawphylax_sent",
      "clawphylax_compaction_brief",
      "clawphylax_task_match",
      "clawphylax_reconcile"`, "manifest tools");
wr("openclaw.plugin.json", M);
for (const f of ["src/report.ts", "src/index.ts", "src/cli.ts"]) {
  const s = rd(f);
  if (s.includes("0.4.0")) wr(f, s.split("0.4.0").join("0.5.0"));
}

let CH = rd("CHANGELOG.md");
const headIdx = CH.indexOf("## ");
CH = CH.slice(0, headIdx) + `## 0.5.0 — messaging: the send is the action

Every OpenClaw turn ends in a send. Five questions about it, from the message
hooks and the wire together:

- \`clawphylax_send_check\` / \`/phylax send <to> :: <text>\` — is this safe to send?
  Target vs the conversation this session is replying in and earlier sends;
  secret-shaped values (API keys, tokens, private keys) and credential paths in
  the text. SEND / CONFIRM_WITH_USER / DO_NOT_SEND.
- \`clawphylax_sent\` / \`/phylax sent\` — did my message actually go out? The
  runtime's \`message_sent\` result cross-checked against the request this process
  made to the channel API and its status. DELIVERED / NOT_DELIVERED /
  CLAIMED_ONLY / CANCELLED / PENDING / NO_SEND.
- \`clawphylax_compaction_brief\` / \`/phylax brief\` — what did I lose in
  compaction? \`before_compaction\`/\`after_compaction\` are recorded; the brief
  rebuilds hosts, blocks, failures, silent failures, undelivered sends, working
  routes and the last actions before the cut, with a MUST NOT FORGET list.
- \`clawphylax_task_match\` / \`/phylax match\` — did I do what was asked? Inbound
  request (keyword fingerprint, requested actions) vs the reply that went out vs
  the actions in between. COHERENT / PARTIAL / INCOHERENT / NO_PAIR.
- \`clawphylax_reconcile\` / \`/phylax reconcile\` — what do I believe I did vs what
  the record shows? Success claims in the transcript checked against tool
  outcomes, sends, and POST/PUT status on the wire.

Hooks added: \`message_received\`, \`message_sent\`, \`before_compaction\`,
\`after_compaction\`. \`message_sending\` now records the send (target, length,
keyword fingerprint, secret kinds — never the text) and, in \`enforce\` mode only,
cancels a message carrying a secret-shaped value. Ledger tables \`inbound\`,
\`outbound\`, \`compactions\`. 22 tools, 19 skills.

` + CH.slice(headIdx);
wr("CHANGELOG.md", CH);
console.log("0.5.0 patched");
