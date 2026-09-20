# Changelog

## 0.1.0 — 2026-09-21

First release.

- Pre-install scan of skill folders (`clawphylax_scan`, `openclaw clawphylax scan`): hosts, upload intent, credential-file reads; verdict clean / review / suspicious. Best-effort `before_install` gate.
- Runtime attribution of every in-process request to the open tool call, across three seams: `node:http`/`https`, `globalThis.fetch`, and OpenClaw's bundled `undici` (Agent-level patch; covers explicit dispatchers and `EnvHttpProxyAgent`).
- `exec` command analysis before execution: hosts, uploads, credential reads, skill inference from `skills/<name>/` paths.
- Destination baseline per origin (Dirichlet + Wilson bound); `unexpected-host` fires only for stable origins.
- Local SQLite ledger via `node:sqlite`; built-in suspicious-host list; allow/deny rules.
- Agent tools: `clawphylax_report`, `clawphylax_hosts`, `clawphylax_scan`, `clawphylax_card`.
- Witness cards (`clawphylax-card/v1`) for sharing observed behavior in reviews and issues.
- CLI: `report | hosts | recent | scan | card | allow | deny | rules | export | status`.
- Reply footer when a run touched new or suspicious hosts; `mode: "enforce"` blocks denylisted targets.
- Bundled `clawphylax-verify` skill so agents find and use the evidence at the verify-before-install step.
- Recording is armed only in agent processes (Gateway start or first tool call); CLI runs never write to the ledger.
