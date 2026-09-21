// One-off patch: tool-outcome recording + session queries (0.3.0 groundwork).
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const rd = (f) => fs.readFileSync(path.join(root, f), "utf8");
const wr = (f, s) => fs.writeFileSync(path.join(root, f), s);
function mustReplace(s, from, to, label) {
  if (!s.includes(from)) throw new Error("anchor not found: " + label);
  return s.replace(from, to);
}

let l = rd("src/ledger.ts");
l = mustReplace(l, `      CREATE TABLE IF NOT EXISTS rules (`, `      CREATE TABLE IF NOT EXISTS tool_outcomes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        run_id TEXT,
        session_key TEXT,
        agent_id TEXT,
        tool_call_id TEXT,
        tool_name TEXT NOT NULL,
        ok INTEGER NOT NULL,
        error_text TEXT,
        duration_ms INTEGER,
        arg_hint TEXT
      );
      CREATE INDEX IF NOT EXISTS outcomes_ts ON tool_outcomes(ts);
      CREATE INDEX IF NOT EXISTS outcomes_session ON tool_outcomes(session_key);
      CREATE TABLE IF NOT EXISTS rules (`, "schema");

l = mustReplace(l, `export type SkillSummary = {`, `export type ToolOutcome = {
  ts: number;
  runId?: string;
  sessionKey?: string;
  agentId?: string;
  toolCallId?: string;
  toolName: string;
  ok: boolean;
  errorText?: string;
  durationMs?: number;
  /** Short, redacted hint about the arguments (host, path or first words of a command). */
  argHint?: string;
};

export type SkillSummary = {`, "types");

l = mustReplace(l, `  eventsForHost(host: string, sinceTs = 0, limit = 500): EgressEvent[] {`, `  recordToolOutcome(o: ToolOutcome): void {
    this.db
      .prepare(
        "INSERT INTO tool_outcomes (ts, run_id, session_key, agent_id, tool_call_id, tool_name, ok, error_text, duration_ms, arg_hint) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        o.ts,
        o.runId ?? null,
        o.sessionKey ?? null,
        o.agentId ?? null,
        o.toolCallId ?? null,
        o.toolName,
        o.ok ? 1 : 0,
        o.errorText ? o.errorText.slice(0, 500) : null,
        o.durationMs ?? null,
        o.argHint ? o.argHint.slice(0, 200) : null,
      );
  }

  toolOutcomes(opts: { sessionKey?: string; sinceTs?: number; limit?: number; onlyFailures?: boolean } = {}): ToolOutcome[] {
    const where: string[] = ["ts >= ?"];
    const args: any[] = [opts.sinceTs ?? 0];
    if (opts.sessionKey) {
      where.push("session_key = ?");
      args.push(opts.sessionKey);
    }
    if (opts.onlyFailures) {
      where.push("ok = 0");
    }
    args.push(opts.limit ?? 500);
    const rows = this.db.prepare("SELECT * FROM tool_outcomes WHERE " + where.join(" AND ") + " ORDER BY ts DESC LIMIT ?").all(...args) as any[];
    return rows.map((r) => ({
      ts: r.ts,
      runId: r.run_id ?? undefined,
      sessionKey: r.session_key ?? undefined,
      agentId: r.agent_id ?? undefined,
      toolCallId: r.tool_call_id ?? undefined,
      toolName: r.tool_name,
      ok: r.ok === 1,
      errorText: r.error_text ?? undefined,
      durationMs: r.duration_ms ?? undefined,
      argHint: r.arg_hint ?? undefined,
    }));
  }

  eventsForSession(sessionKey: string, sinceTs = 0, limit = 1000): EgressEvent[] {
    return (this.db.prepare("SELECT * FROM events WHERE session_key = ? AND ts >= ? ORDER BY ts DESC LIMIT ?").all(sessionKey, sinceTs, limit) as any[]).map(rowToEvent);
  }

  /** Most recently active session keys (from events and tool outcomes). */
  recentSessions(limit = 10): Array<{ sessionKey: string; lastSeen: number }> {
    return this.db
      .prepare(
        "SELECT session_key AS sessionKey, MAX(ts) AS lastSeen FROM (SELECT session_key, ts FROM events WHERE session_key IS NOT NULL UNION ALL SELECT session_key, ts FROM tool_outcomes WHERE session_key IS NOT NULL) GROUP BY session_key ORDER BY lastSeen DESC LIMIT ?",
      )
      .all(limit) as any[];
  }

  /** Events for a host from sessions other than the given one. */
  eventsForHostFromOtherSessions(host: string, excludeSession: string | undefined, sinceTs = 0, limit = 50): EgressEvent[] {
    const rows = excludeSession
      ? this.db.prepare("SELECT * FROM events WHERE host = ? AND ts >= ? AND (session_key IS NULL OR session_key != ?) ORDER BY ts DESC LIMIT ?").all(host, sinceTs, excludeSession, limit)
      : this.db.prepare("SELECT * FROM events WHERE host = ? AND ts >= ? ORDER BY ts DESC LIMIT ?").all(host, sinceTs, limit);
    return (rows as any[]).map(rowToEvent);
  }

  eventsForHost(host: string, sinceTs = 0, limit = 500): EgressEvent[] {`, "ledger methods");
wr("src/ledger.ts", l);

let c = rd("src/core.ts");
c = mustReplace(c, `export type ToolCallEvent = {
  toolName?: string;
  params?: unknown;
  toolCallId?: string;
  runId?: string;
};`, `export type ToolCallEvent = {
  toolName?: string;
  params?: unknown;
  toolCallId?: string;
  runId?: string;
  /** after_tool_call only, read defensively from the host event */
  error?: string;
  ok?: boolean;
  durationMs?: number;
};`, "ToolCallEvent");
c = mustReplace(c, `  afterToolCall(event: ToolCallEvent): void {
    closeToolCall(event.toolCallId);
  }`, `  /** Session key of the most recent tool call; lets tools default to the current conversation. */
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
  }`, "afterToolCall");
c = mustReplace(c, `    this.arm(); // a tool call is proof that this process runs an agent`, `    this.arm(); // a tool call is proof that this process runs an agent
    if (ctx.sessionKey) {
      this.lastSessionKey = ctx.sessionKey;
    }`, "beforeToolCall session");
c = mustReplace(c, `export class Core {`, `/** A short, non-sensitive hint about a tool call's arguments for the outcome log. */
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
    return cmd.replace(/\\s+/g, " ").slice(0, 80);
  }
  const q = typeof p.query === "string" ? p.query : typeof p.path === "string" ? p.path : undefined;
  return q ? toolName + ":" + q.slice(0, 100) : undefined;
}

export class Core {`, "argHint");
wr("src/core.ts", c);

let s = rd("src/index.ts");
s = mustReplace(s, `    toolCallId: str(r.toolCallId) ?? str(r.callId) ?? str(r.id),
    runId: str(r.runId),
  };
}`, `    toolCallId: str(r.toolCallId) ?? str(r.callId) ?? str(r.id),
    runId: str(r.runId),
    error:
      str(r.error) ??
      (r.error && typeof r.error === "object" ? str((r.error as any).message) : undefined) ??
      (typeof r.errorText === "string" ? r.errorText : undefined),
    ok: typeof r.ok === "boolean" ? r.ok : typeof r.success === "boolean" ? r.success : typeof r.isError === "boolean" ? !r.isError : undefined,
    durationMs: typeof r.durationMs === "number" ? r.durationMs : typeof r.duration === "number" ? r.duration : undefined,
  };
}`, "toolEvent");
s = mustReplace(s, `    api.on("after_tool_call", (event: unknown) => {
      try {
        core.afterToolCall(toolEvent(event));`, `    api.on("after_tool_call", (event: unknown, ctx: unknown) => {
      try {
        core.afterToolCall(toolEvent(event), hookCtx(ctx));`, "after_tool_call");
wr("src/index.ts", s);
console.log("patched: ledger, core, index");
