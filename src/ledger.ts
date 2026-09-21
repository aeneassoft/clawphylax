// Local SQLite ledger. Uses node:sqlite (Node 22.5+/24), so there is no
// native dependency to install into the Gateway's managed plugin project.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EgressEvent, Flag } from "./types.js";

export type HostRow = {
  key: string;
  host: string;
  first_seen: number;
  last_seen: number;
  count: number;
};

export type ToolOutcome = {
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

export type SkillSummary = {
  key: string;
  hosts: number;
  calls: number;
  bytes_out: number;
  suspicious: number;
  blocked: number;
  last_seen: number;
};

export function defaultLedgerPath(): string {
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".openclaw");
  return path.join(stateDir, "clawphylax", "ledger.sqlite");
}

/** Attribution key shown in reports: skill if known, otherwise the tool. */
export function attributionKey(e: Pick<EgressEvent, "attribution">): string {
  const a = e.attribution;
  if (a.skill) {
    return `skill:${a.skill}`;
  }
  if (a.toolName) {
    return `tool:${a.toolName}`;
  }
  return "model-turn";
}

export class Ledger {
  readonly db: DatabaseSync;
  readonly path: string;

  constructor(dbPath: string = defaultLedgerPath()) {
    this.path = dbPath;
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        source TEXT NOT NULL,
        protocol TEXT NOT NULL,
        method TEXT NOT NULL,
        host TEXT NOT NULL,
        port INTEGER,
        path TEXT,
        status INTEGER,
        bytes_out INTEGER,
        bytes_in INTEGER,
        duration_ms INTEGER,
        category TEXT NOT NULL,
        flags TEXT NOT NULL,
        blocked INTEGER NOT NULL DEFAULT 0,
        command TEXT,
        run_id TEXT,
        session_key TEXT,
        agent_id TEXT,
        tool_call_id TEXT,
        tool_name TEXT,
        skill TEXT,
        attribution_key TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
      CREATE INDEX IF NOT EXISTS events_key ON events(attribution_key);
      CREATE INDEX IF NOT EXISTS events_run ON events(run_id);
      CREATE TABLE IF NOT EXISTS hosts (
        key TEXT NOT NULL,
        host TEXT NOT NULL,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (key, host)
      );
      CREATE TABLE IF NOT EXISTS tool_outcomes (
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
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL,
        host TEXT NOT NULL,
        decision TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  /** Records the event. Returns true when this host is new for the attribution key. */
  record(e: EgressEvent): { isNewHost: boolean; id: number } {
    const key = attributionKey(e);
    const seen = this.db
      .prepare("SELECT count FROM hosts WHERE key = ? AND host = ?")
      .get(key, e.host) as { count: number } | undefined;
    const isNewHost = !seen;
    const flags: Flag[] = isNewHost && !e.flags.includes("new-host") ? [...e.flags, "new-host"] : e.flags;

    const res = this.db
      .prepare(
        `INSERT INTO events (ts, source, protocol, method, host, port, path, status, bytes_out, bytes_in,
          duration_ms, category, flags, blocked, command, run_id, session_key, agent_id, tool_call_id,
          tool_name, skill, attribution_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.ts,
        e.source,
        e.protocol,
        e.method,
        e.host,
        e.port ?? null,
        e.path ?? null,
        e.status ?? null,
        e.bytesOut ?? null,
        e.bytesIn ?? null,
        e.durationMs ?? null,
        e.category,
        flags.join(","),
        e.blocked ? 1 : 0,
        e.command ? e.command.slice(0, 2000) : null,
        e.attribution.runId ?? null,
        e.attribution.sessionKey ?? null,
        e.attribution.agentId ?? null,
        e.attribution.toolCallId ?? null,
        e.attribution.toolName ?? null,
        e.attribution.skill ?? null,
        key,
      );

    this.db
      .prepare(
        `INSERT INTO hosts (key, host, first_seen, last_seen, count) VALUES (?, ?, ?, ?, 1)
         ON CONFLICT(key, host) DO UPDATE SET last_seen = excluded.last_seen, count = count + 1`,
      )
      .run(key, e.host, e.ts, e.ts);

    return { isNewHost, id: Number(res.lastInsertRowid) };
  }

  summaries(sinceTs = 0): SkillSummary[] {
    return this.db
      .prepare(
        `SELECT attribution_key AS key,
                COUNT(DISTINCT host) AS hosts,
                COUNT(*) AS calls,
                COALESCE(SUM(bytes_out), 0) AS bytes_out,
                SUM(CASE WHEN category = 'suspicious' THEN 1 ELSE 0 END) AS suspicious,
                SUM(blocked) AS blocked,
                MAX(ts) AS last_seen
         FROM events WHERE ts >= ? GROUP BY attribution_key ORDER BY suspicious DESC, calls DESC`,
      )
      .all(sinceTs) as SkillSummary[];
  }

  hostsFor(key: string): HostRow[] {
    return this.db
      .prepare("SELECT * FROM hosts WHERE key = ? ORDER BY last_seen DESC")
      .all(key) as HostRow[];
  }

  eventsForRun(runId: string): EgressEvent[] {
    return (this.db.prepare("SELECT * FROM events WHERE run_id = ? ORDER BY ts").all(runId) as any[]).map(
      rowToEvent,
    );
  }

  recordToolOutcome(o: ToolOutcome): void {
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

  eventsForHost(host: string, sinceTs = 0, limit = 500): EgressEvent[] {
    return (
      this.db
        .prepare("SELECT * FROM events WHERE host = ? AND ts >= ? ORDER BY ts DESC LIMIT ?")
        .all(host, sinceTs, limit) as any[]
    ).map(rowToEvent);
  }

  recentEvents(limit = 50, key?: string): EgressEvent[] {
    const rows = key
      ? this.db.prepare("SELECT * FROM events WHERE attribution_key = ? ORDER BY ts DESC LIMIT ?").all(key, limit)
      : this.db.prepare("SELECT * FROM events ORDER BY ts DESC LIMIT ?").all(limit);
    return (rows as any[]).map(rowToEvent);
  }

  flagged(sinceTs = 0, limit = 100): EgressEvent[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM events WHERE ts >= ? AND (category = 'suspicious' OR flags LIKE '%sensitive-read%' OR flags LIKE '%unexpected-host%' OR blocked = 1)
           ORDER BY ts DESC LIMIT ?`,
        )
        .all(sinceTs, limit) as any[]
    ).map(rowToEvent);
  }

  addRule(scope: string, host: string, decision: "allow" | "deny"): void {
    this.db
      .prepare("INSERT INTO rules (scope, host, decision, created_at) VALUES (?, ?, ?, ?)")
      .run(scope, host, decision, Date.now());
  }

  rules(): Array<{ id: number; scope: string; host: string; decision: string; created_at: number }> {
    return this.db.prepare("SELECT * FROM rules ORDER BY id").all() as any[];
  }

  ruleFor(scope: string, host: string): "allow" | "deny" | undefined {
    const rows = this.db
      .prepare("SELECT decision FROM rules WHERE (scope = ? OR scope = '*') AND (host = ? OR ? LIKE '%.' || host) ORDER BY id DESC")
      .all(scope, host, host) as Array<{ decision: string }>;
    const d = rows[0]?.decision;
    return d === "allow" || d === "deny" ? d : undefined;
  }

  getSetting(key: string): string | undefined {
    const r = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return r?.value;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(key, value, Date.now());
  }

  counts(): { events: number; hosts: number; keys: number } {
    const e = this.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number };
    const h = this.db.prepare("SELECT COUNT(*) AS n FROM hosts").get() as { n: number };
    const k = this.db.prepare("SELECT COUNT(DISTINCT attribution_key) AS n FROM events").get() as { n: number };
    return { events: e.n, hosts: h.n, keys: k.n };
  }

  close(): void {
    this.db.close();
  }
}

function rowToEvent(r: any): EgressEvent {
  return {
    ts: r.ts,
    source: r.source,
    protocol: r.protocol,
    method: r.method,
    host: r.host,
    port: r.port ?? undefined,
    path: r.path ?? undefined,
    status: r.status ?? undefined,
    bytesOut: r.bytes_out ?? undefined,
    bytesIn: r.bytes_in ?? undefined,
    durationMs: r.duration_ms ?? undefined,
    category: r.category,
    flags: (r.flags ? String(r.flags).split(",").filter(Boolean) : []) as Flag[],
    blocked: r.blocked === 1,
    command: r.command ?? undefined,
    attribution: {
      runId: r.run_id ?? undefined,
      sessionKey: r.session_key ?? undefined,
      agentId: r.agent_id ?? undefined,
      toolCallId: r.tool_call_id ?? undefined,
      toolName: r.tool_name ?? undefined,
      skill: r.skill ?? undefined,
    },
  };
}
