# Changelog

## 0.5.1 — found and installed

- Plugin summary is question-first (the first 250 characters are what ClawHub's plugin
  search matches and what the card shows); display name carries the first question.
- New hub skill `clawphylax`: all 22 questions with tool, /phylax command and verdicts.
- Every skill's install step now lets the agent install the plugin itself when it has the
  `plugins` tool, and otherwise asks the user once with one specific sentence.
- `heartbeat_prompt_contribution`: one line into the operator's heartbeat, only when
  something since the last heartbeat earned it (unconfirmed sends, silent failures, flagged
  requests, hosts that went blocked). Empty otherwise.
- `/phylax` on an empty ledger explains what to ask and when, instead of "no events".
- README: the numbers and the one capability nothing else has, in the first screen.

## 0.5.0 — messaging: the send is the action

Every OpenClaw turn ends in a send. Five questions about it, from the message
hooks and the wire together:

- `clawphylax_send_check` / `/phylax send <to> :: <text>` — is this safe to send?
  Target vs the conversation this session is replying in and earlier sends;
  secret-shaped values (API keys, tokens, private keys) and credential paths in
  the text. SEND / CONFIRM_WITH_USER / DO_NOT_SEND.
- `clawphylax_sent` / `/phylax sent` — did my message actually go out? The
  runtime's `message_sent` result cross-checked against the request this process
  made to the channel API and its status. DELIVERED / NOT_DELIVERED /
  CLAIMED_ONLY / CANCELLED / PENDING / NO_SEND.
- `clawphylax_compaction_brief` / `/phylax brief` — what did I lose in
  compaction? `before_compaction`/`after_compaction` are recorded; the brief
  rebuilds hosts, blocks, failures, silent failures, undelivered sends, working
  routes and the last actions before the cut, with a MUST NOT FORGET list.
- `clawphylax_task_match` / `/phylax match` — did I do what was asked? Inbound
  request (keyword fingerprint, requested actions) vs the reply that went out vs
  the actions in between. COHERENT / PARTIAL / INCOHERENT / NO_PAIR.
- `clawphylax_reconcile` / `/phylax reconcile` — what do I believe I did vs what
  the record shows? Success claims in the transcript checked against tool
  outcomes, sends, and POST/PUT status on the wire.

Hooks added: `message_received`, `message_sent`, `before_compaction`,
`after_compaction`. `message_sending` now records the send (target, length,
keyword fingerprint, secret kinds — never the text) and, in `enforce` mode only,
cancels a message carrying a secret-shaped value. Ledger tables `inbound`,
`outbound`, `compactions`. 22 tools, 19 skills.

## 0.4.0 — 2026-09-21

- **Did that actually work?** (`clawphylax_did_it_work`, `/phylax check`, `openclaw clawphylax check`): cross-checks what a tool reported against what the wire showed for the same tool call — CONFIRMED / SILENT_FAILURE / UNVERIFIED / FAILED, with the mismatch named. The reply footer now raises a STOP CONDITION on silent failures. New skill `did-that-actually-work`.
- **Decision records.** Outlook, stop rule and did-it-work answer ACTION-first (ACTION / EVIDENCE / DO NOT / NEXT / CONFIDENCE / SCOPE), the shape a model acts on rather than summarises.
- **Descriptions and guidance rewritten** after consulting OpenAI's gpt-5.6 on how OpenAI-driven agents select and follow tools: trigger first, tool names and status codes, an exact action contract, negative routing; the prompt guidance now requires following the returned ACTION. (See OPENAI_ANTWORT_ANNOTIERT.md in the workspace.)
- Provenance sentence in every skill's "For agents" section: shared authorship is not a safety guarantee; review each skill independently.

## 0.3.1 — 2026-09-21

- **Token use** (`clawphylax_token_use`, `/phylax tokens`, `openclaw clawphylax tokens`): am I using too many tokens — and am I spending them to refute myself or to put the task into practice? Assistant turns classified act / gather / repeat / deliberate from the transcript, output tokens attributed, deliberation streaks and repeated identical calls → executing / deliberating / churning. Works without the ledger. New skill `am-i-using-too-many-tokens`.

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
