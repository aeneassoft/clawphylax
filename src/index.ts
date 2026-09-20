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
  };
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
      description: "ClawPhylax: report outbound activity, scan a skill folder, list hosts for an origin, or render a witness card.",
      acceptsArgs: true,
      requireAuth: true,
      agentPromptGuidance: [
        "Before installing any third-party skill, verify it first: run /phylax scan <folder> (or the clawphylax_scan tool) and report the hosts, uploads and credential-file reads it names. When asked where a skill sends data or why an unknown host was contacted, run /phylax hosts skill:<name> (or the clawphylax_hosts tool) and answer from the ledger.",
      ],
      handler: async (ctx: any) => {
        try {
          const args = String(ctx?.args ?? "").trim();
          const [sub, ...rest] = args.split(/s+/).filter(Boolean);
          const arg = rest.join(" ");
          if (!sub || sub === "report") {
            return { text: renderSummary(core.ledger, sinceMs(arg)) };
          }
          if (sub === "hosts" && arg) {
            return { text: renderHosts(core.ledger, arg) };
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
            return { text: lines.join("
") };
          }
          return { text: "Usage: /phylax [report [24h]] | scan <folder> | hosts <origin> | card <origin>" };
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

    api.on("after_tool_call", (event: unknown) => {
      try {
        core.afterToolCall(toolEvent(event));
      } catch {
        /* never throw from an observer */
      }
    });

    // Append a one-line summary to the reply when the run touched new or
    // suspicious hosts. If the event shape is not what we expect, do nothing.
    api.on("message_sending", (event: unknown, ctx: unknown) => {
      try {
        const e = (event && typeof event === "object" ? event : {}) as Record<string, unknown>;
        const runId = hookCtx(ctx).runId ?? str(e.runId);
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
