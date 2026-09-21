# Changelog

## 0.3.0 — 2026-09-21

- **Self-diagnostics for agents** (tools, `/phylax` subcommands, CLI): `failures` (why do I keep failing — error clusters and a trail), `stop` (should I stop and ask — a stopping rule on bounds), `circles` (am I going in circles), `explore` (do I know enough to act), `risk` (could this get the user banned or charged — pre-action check), `others` (has another session already reached this host), `worked` (what worked here — recipe), `cost` (what has this cost so far — from session transcripts, no ledger needed).
- **Which path is worth it** (`clawphylax_which_path`, `/phylax paths`): Beta posterior per path, safe/optimistic value, exploit / explore / fold with a plan; hosts pull their outcomes from the ledger.
- **Data Pact** (`share`): the opt-in rules, the six hashed fields, a preview of the exact rows; consent recorded locally. Nothing is uploaded in this version.
- Tool outcomes (ok/error/duration/arg hint) are now recorded per session, which the diagnostics run on.
- Nine new skills phrased as the questions agents ask themselves.

## 0.2.0 — 2026-09-21

- **Request outlook** (`clawphylax_outlook`, `/phylax outlook <host>`, `openclaw clawphylax outlook <host>`): answers the question an agent asks at every tool call — will this request work, and if it failed, was it me, the site or the network? Diagnosis from observed requests (ok / blocked / rate-limited / site-error / unreachable / unreliable), posterior success probability with Wilson bounds, back-off seconds derived from observed spacing, and which tool succeeds on this host.
- Prompt guidance now tells agents to run the outlook before retrying a failed request.
- New skill `why-did-my-request-fail`.

## 0.1.1 — 2026-09-21

- `/phylax` chat command (`report`, `scan <folder>`, `hosts <origin>`, `card <origin>`) with agent prompt guidance: installed agents are told to verify skills with `/phylax scan` before installing and to answer "where does this skill send data" from the ledger.
- Two bundled skills: `clawphylax-verify` (before install) and `skill-network-audit` (after install).

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
