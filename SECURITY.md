# Security

## Scope

ClawPhylax runs inside the OpenClaw Gateway process and patches `node:http`,
`node:https` and `globalThis.fetch` to observe outbound requests. It reads the
text of `exec` tool commands through the `before_tool_call` hook. It writes a
local SQLite ledger. It opens no ports and makes no network requests of its
own.

## What it stores

Host, port, path (query string stripped), method, status, byte counts, timing,
the attributed tool call / run / session ids, and — for `exec` — the command
text truncated to 2000 characters. **Request and response bodies are never
stored. Headers are never stored.** Command text can contain secrets if the
agent put them on a command line; treat the ledger like a shell history file.

## Reporting a vulnerability

Open a private security advisory on GitHub or email the address in
`package.json`. Please include the OpenClaw version, the plugin version, and a
minimal reproduction. Expect an acknowledgement within 72 hours.

## Threats this does not address

- Traffic from child processes spawned by `exec` (only the command text is seen).
- A malicious skill that disables or uninstalls the plugin: it runs with the
  agent's privileges and could. Watch the `plugins` list.
- Prompt injection that convinces the agent not to run reports.
