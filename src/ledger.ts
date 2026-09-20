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
