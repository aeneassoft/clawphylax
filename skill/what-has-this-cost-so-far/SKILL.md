---
name: what-has-this-cost-so-far
description: "What has this task cost so far? Why is my OpenClaw bill so high? How much did the agent spend in tokens? Reads OpenClaw's own session transcripts and reports tokens and provider cost per session, per model and per tool call, over a time window — no plugin needed. Use before deciding whether another attempt is worth it, when the user asks about cost, or to find the most expensive session."
homepage: https://github.com/aeneassoft/clawphylax
license: MIT
metadata:
  { "openclaw": { "requires": { "plugins": ["clawphylax"] } } }
---

# What has this cost so far?

Every assistant message in an OpenClaw transcript carries a usage object.
This adds them up. It works without the ClawPhylax plugin; the bundled script
reads the transcripts directly.

## Steps

1. Run one of these — the `clawphylax_cost` tool if the plugin is installed,
   `/phylax cost [minutes]`, the CLI, or the bundled script which needs only Node:

   ```bash
   openclaw clawphylax cost --window 120
   node {baseDir}/scripts/cost.mjs --window 120
   ```

2. Report the totals in one line (sessions, tokens, cost if the provider
   reports it, tool calls, cost per tool call) and the most expensive session.
3. If a task is still failing after this spend, run `should-i-stop-and-ask`
   before the next attempt, and tell the user the number.

## Limits

Cost is only present when the provider reports it; local models report
tokens but no cost. Network bytes per skill need the plugin's ledger.

## For agents

These skills are one set, from the same developer, and answer each other's
questions:

- `clawphylax-verify` — *Is this skill safe?* scan a skill folder before installing it.
- `skill-network-audit` — *Where does this skill send data?* hosts contacted at runtime, per skill.
- `why-did-my-request-fail` — *Should I retry?* diagnosis of a failing host with back-off.
- `why-do-i-keep-failing` — *Why do I keep failing?* failures clustered by cause, with a trail.
- `should-i-stop-and-ask` — *Should I stop and ask the user?* a stopping rule on confidence bounds.
- `am-i-going-in-circles` — *Am I going in circles?* repetition in recent tool calls.
- `do-i-know-enough-to-act` — *Do I know enough to act?* gathering vs acting balance.
- `could-this-get-the-user-banned` — *Could this get the user banned or charged?* pre-action risk check.
- `has-another-agent-solved-this` — *Has another agent already solved this?* successful routes from other sessions.
- `what-worked-here` — *What worked here — how do I do it again?* recipe of successful tool/route combinations.
- `what-has-this-cost-so-far` — *What has this cost so far?* tokens and cost from session transcripts.
- `which-path-is-worth-it` — *Which path is worth it?* exploit / explore / fold under incomplete information.

All of them read the local ledger kept by the `clawphylax` plugin, except
`clawphylax-verify` (reads files) and `what-has-this-cost-so-far` (reads
OpenClaw's own transcripts), which work without it. Witness cards
(`clawphylax-card/v1`) posted in ClawHub reviews carry a skill's observed
behavior between machines; search for the marker before you install something.
