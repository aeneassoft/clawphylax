// Wiring between the host hooks, the interceptor, the decision layer and the
// ledger. Kept free of SDK imports so it can be unit-tested without OpenClaw.

import { baselineFor, isUnexpectedNewHost } from "./baseline.js";
import { closeToolCall, currentAttribution, openToolCall } from "./context.js";
import { decide } from "./decide.js";
import { analyzeExecCommand, extractCommand } from "./exec-parse.js";
import { installInterceptor, type Observed } from "./intercept.js";
import { installUndiciSeam } from "./undici-seam.js";
import { attributionKey, Ledger } from "./ledger.js";
import { renderRunFooter } from "./report.js";
import { asksOf, keywordsOf } from "./messaging.js";
import { findSecretShapes } from "./secrets.js";
import type { Attribution, EgressEvent, Flag, PluginConfig } from "./types.js";

export type Logger = { info: (m: string) => void; warn: (m: string) => void; debug?: (m: string) => void };

export type ToolCallEvent = {
  toolName?: string;
  params?: unknown;
  toolCallId?: string;
  runId?: string;
  /** after_tool_call only, read defensively from the host event */
  error?: string;
  ok?: boolean;
  durationMs?: number;
};

export type MsgCtx = { channelId?: string; conversationId?: string; accountId?: string };

export type HookContext = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
};

// OpenClaw can evaluate the plugin entry more than once in a single process
// (CLI registration pass and agent runtime pass). Transport seams are process
// global, so the Core that owns the ledger and the armed flag must be too —
// otherwise a tool call arms one instance while the seams report to another.
const SHARED = Symbol.for("clawphylax.core");

export function sharedCore(cfg: PluginConfig, ledgerFactory: () => Ledger, log: Logger): Core {
  const g = globalThis as any;
  let core: Core | undefined = g[SHARED];
  if (!core) {
    core = new Core(cfg, ledgerFactory(), log);
    g[SHARED] = core;
  } else {
    core.setConfig(cfg);
  }
  return core;
}

/** A short, non-sensitive hint about a tool call's arguments for the outcome log. */
export function argHint(toolName: string, params: unknown): string | undefined {
  if (!params || typeof params !== "object") {
    return undefined;
  }
  const p = params as Record<string, unknown>;
  const url = typeof p.url === "string" ? p.url : undefined;
  if (url) {
    try {
      const u = new URL(url);
      return (u.hostname + u.pathname).slice(0, 120);
    } catch {
      return url.slice(0, 120);
    }
  }
  const cmd = extractCommand(params);
  if (cmd) {
    return cmd.replace(/\s+/g, " ").slice(0, 80);
  }
  const q = typeof p.query === "string" ? p.query : typeof p.path === "string" ? p.path : undefined;
  return q ? toolName + ":" + q.slice(0, 100) : undefined;
}

export class Core {
  readonly ledger: Ledger;
  private cfg: PluginConfig;
  private readonly log: Logger;
  /** run id -> events recorded during that run (for the reply footer) */
  private readonly runEvents = new Map<string, EgressEvent[]>();

  constructor(cfg: PluginConfig, ledger: Ledger, log: Logger) {
    this.cfg = cfg;
    this.ledger = ledger;
    this.log = log;
  }

  setConfig(cfg: PluginConfig): void {
    this.cfg = cfg;
  }

  get config(): PluginConfig {
    return this.cfg;
  }

  /**
   * Recording is off until the process is known to be an agent host (Gateway
   * start or the first tool call). The transport patches are installed early
   * — before provider modules bind their fetch — but stay silent in CLI runs.
   */
  private armed = false;

  arm(): void {
    if (!this.armed) {
      this.armed = true;
      this.log.info(`ClawPhylax armed (mode=${this.cfg.mode}) — ledger ${this.ledger.path}`);
    }
  }

  get isArmed(): boolean {
    return this.armed;
  }

  /** Install all in-process seams once for this process. Safe to call in any process. */
  startInterceptor(): void {
    const seam = {
      decide: (t: { host: string }) => {
        if (!this.armed) {
          return { block: false };
        }
        const attr = currentAttribution();
        const key = attributionKey({ attribution: attr });
        const v = decide({ cfg: this.cfg, ledger: this.ledger, key, host: t.host });
        return { block: v.block, reason: v.reason };
      },
      observe: (o: Observed & { blocked: boolean }) => {
        if (process.env.CLAWPHYLAX_DEBUG) {
          this.log.info(`seen ${o.method} ${o.protocol}://${o.host}${o.path ?? ""} armed=${this.armed} status=${o.status ?? "-"}`);
        }
        if (this.armed) {
          this.onObserved(o);
        }
      },
    };
    installInterceptor(seam);
    installUndiciSeam(seam, this.log);
  }

  private onObserved(o: Observed & { blocked: boolean }): void {
    const attr = currentAttribution();
    const attribution: Attribution = {
      runId: attr.runId,
      sessionKey: attr.sessionKey,
      agentId: attr.agentId,
      toolCallId: attr.toolCallId,
      toolName: attr.toolName,
      skill: attr.skill,
      skillConfidence: attr.skillConfidence,
    };
    const key = attributionKey({ attribution });
    const v = decide({ cfg: this.cfg, ledger: this.ledger, key, host: o.host });
    const flags: Flag[] = [...v.flags];
    if (!attr.toolCallId && v.category !== "model") {
      flags.push("unattributed");
    }
    const ev: EgressEvent = {
      ts: Date.now(),
      source: "inproc",
      protocol: o.protocol,
      method: o.method,
      host: o.host,
      port: o.port,
      path: o.path,
      status: o.status,
      bytesOut: o.bytesOut,
      bytesIn: o.bytesIn,
      durationMs: o.durationMs,
      category: v.category,
      flags,
      blocked: o.blocked,
      attribution,
    };
    this.commit(ev);
  }

  private commit(ev: EgressEvent): void {
    try {
      // Poker gate: before this event lands, ask whether a new host for this
      // origin would be *unexpected* given the origin's settled baseline. The
      // gate stays silent while the origin is learning or volatile.
      const key = attributionKey(ev);
      const baseline = baselineFor(this.ledger, key);
      const seenBefore = this.ledger.hostsFor(key).some((h) => h.host === ev.host);
      if (!seenBefore && isUnexpectedNewHost(baseline) && ev.category !== "local") {
        ev.flags.push("unexpected-host");
      }
      const { isNewHost } = this.ledger.record(ev);
      if (isNewHost && !ev.flags.includes("new-host")) {
        ev.flags.push("new-host");
      }
      if (process.env.CLAWPHYLAX_DEBUG) {
        this.log.info(`event ${ev.source} ${ev.method} ${ev.host}${ev.path ?? ""} key=${key} flags=${ev.flags.join(",")}`);
      }
      if (ev.attribution.runId) {
        const runId = ev.attribution.runId;
        const list = this.runEvents.get(runId);
        if (list) {
          list.push(ev);
        } else {
          this.runEvents.set(runId, [ev]);
          // The buffer lives until the reply is sent (message_sending consumes
          // it) or for ten minutes, whichever comes first. No host hook needed.
          setTimeout(() => this.runEvents.delete(runId), 10 * 60_000).unref?.();
        }
      }
      if (ev.category === "suspicious" || ev.blocked || ev.flags.includes("sensitive-read") || ev.flags.includes("unexpected-host")) {
        this.log.warn(
          `${ev.blocked ? "BLOCKED" : "flagged"} ${ev.method} ${ev.host} from ${attributionKey(ev)} [${ev.flags.join(",")}]`,
        );
      }
    } catch (err: any) {
      this.log.warn(`ledger write failed: ${err?.message ?? err}`);
    }
  }

  /**
   * before_tool_call: open the attribution window; for exec, analyze the
   * command text and record its declared targets. Returns a block decision
   * for enforce mode.
   */
  beforeToolCall(event: ToolCallEvent, ctx: HookContext): { block: boolean; reason?: string } {
    this.arm(); // a tool call is proof that this process runs an agent
    if (ctx.sessionKey) {
      this.lastSessionKey = ctx.sessionKey;
    }
    const toolName = event.toolName ?? "unknown";
    const runId = event.runId ?? ctx.runId;
    const command = toolName === "exec" || toolName === "bash" ? extractCommand(event.params) : undefined;
    const analysis = command ? analyzeExecCommand(command) : undefined;

    const toolCallId = openToolCall({
      toolCallId: event.toolCallId,
      toolName,
      runId,
      sessionKey: ctx.sessionKey,
      agentId: ctx.agentId,
      skill: analysis?.skill,
      skillConfidence: analysis?.skill ? "path" : "none",
    });

    if (!analysis || analysis.targets.length === 0) {
      if (analysis?.sensitiveRead) {
        // Reads credentials but names no network target: still worth a line.
        this.commit({
          ts: Date.now(),
          source: "exec",
          protocol: "exec",
          method: "READ",
          host: "(no network target)",
          category: "local",
          flags: ["sensitive-read"],
          blocked: false,
          command,
          attribution: { runId, sessionKey: ctx.sessionKey, agentId: ctx.agentId, toolCallId, toolName, skill: analysis.skill },
        });
      }
      return { block: false };
    }

    let block = false;
    let reason: string | undefined;
    for (const t of analysis.targets) {
      const attribution: Attribution = { runId, sessionKey: ctx.sessionKey, agentId: ctx.agentId, toolCallId, toolName, skill: analysis.skill };
      const key = attributionKey({ attribution });
      const extra: Flag[] = [];
      if (analysis.upload) {
        extra.push("upload");
      }
      if (analysis.sensitiveRead) {
        extra.push("sensitive-read");
      }
      const v = decide({ cfg: this.cfg, ledger: this.ledger, key, host: t.host, extraFlags: extra });
      if (v.block) {
        block = true;
        reason = `${t.host}: ${v.reason}`;
      }
      this.commit({
        ts: Date.now(),
        source: "exec",
        protocol: t.protocol,
        method: t.method,
        host: t.host,
        port: t.port,
        path: t.path,
        category: v.category,
        flags: v.flags,
        blocked: v.block,
        command,
        attribution,
      });
    }
    return { block, reason };
  }

  /** Session key of the most recent tool call; lets tools default to the current conversation. */
  lastSessionKey: string | undefined;

  afterToolCall(event: ToolCallEvent, ctx: HookContext = {}): void {
    const open = closeToolCall(event.toolCallId);
    const sessionKey = ctx.sessionKey ?? open?.sessionKey;
    if (sessionKey) {
      this.lastSessionKey = sessionKey;
    }
    try {
      const toolName = event.toolName ?? open?.toolName ?? "unknown";
      const ok = event.ok ?? !event.error;
      this.ledger.recordToolOutcome({
        ts: Date.now(),
        runId: event.runId ?? ctx.runId ?? open?.runId,
        sessionKey,
        agentId: ctx.agentId ?? open?.agentId,
        toolCallId: event.toolCallId ?? open?.toolCallId,
        toolName,
        ok,
        errorText: event.error,
        durationMs: event.durationMs ?? (open ? Date.now() - open.startedAt : undefined),
        argHint: argHint(toolName, event.params),
      });
    } catch (err: any) {
      this.log.warn("tool outcome not recorded: " + (err?.message ?? err));
    }
  }

  // ------------------------------------------------------------ messaging
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
      return { cancel: true, cancelReason: `ClawPhylax: the message contains a secret-shaped value (${secrets.map((s) => s.kind).join(", ")}); enforce mode does not send it. Remove the value and send again.` };
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

  /** Footer for the reply of this run, if anything is worth a look. Consumes the run buffer. */
  footerForRun(runId: string | undefined): string | undefined {
    if (!runId) {
      return undefined;
    }
    const evs = this.runEvents.get(runId);
    if (!evs) {
      return undefined;
    }
    this.runEvents.delete(runId);
    return this.cfg.notify === "footer" ? renderRunFooter(evs) : undefined;
  }

}
