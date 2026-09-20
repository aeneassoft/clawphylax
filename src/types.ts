// Shared record shapes for the ledger, the interceptor and the report.

export type Source = "inproc" | "exec";

export type Category =
  | "model" // LLM provider endpoints
  | "channel" // messaging platforms the Gateway talks to
  | "local" // loopback / private ranges
  | "suspicious" // built-in or configured denylist
  | "external"; // everything else

export type Flag =
  | "new-host" // first time this attribution key contacted this host
  | "sensitive-read" // exec command reads credential-like files
  | "upload" // exec command sends a body / uploads a file
  | "raw-ip" // target is a bare IP address
  | "unexpected-host" // new host for an origin whose destination baseline is statistically settled
  | "unattributed"; // no open tool call at the time of the request

export type Attribution = {
  runId?: string;
  sessionKey?: string;
  agentId?: string;
  toolCallId?: string;
  toolName?: string;
  skill?: string;
  /** How the skill was inferred: exact path match, or none. */
  skillConfidence?: "path" | "none";
};

export type EgressEvent = {
  ts: number;
  source: Source;
  protocol: string;
  method: string;
  host: string;
  port?: number;
  path?: string;
  status?: number;
  bytesOut?: number;
  bytesIn?: number;
  durationMs?: number;
  category: Category;
  flags: Flag[];
  blocked: boolean;
  command?: string;
  attribution: Attribution;
};

export type PluginConfig = {
  mode: "observe" | "enforce";
  notify: "footer" | "off";
  denylist: string[];
  allowlist: string[];
};

export const DEFAULT_CONFIG: PluginConfig = {
  mode: "observe",
  notify: "footer",
  denylist: [],
  allowlist: [],
};

export function resolveConfig(raw: unknown): PluginConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return {
    mode: r.mode === "enforce" ? "enforce" : "observe",
    notify: r.notify === "off" ? "off" : "footer",
    denylist: list(r.denylist),
    allowlist: list(r.allowlist),
  };
}
