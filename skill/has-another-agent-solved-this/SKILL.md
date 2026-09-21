---
name: has-another-agent-solved-this
description: "Has another agent or session on this machine already solved this? Has someone already fetched this host? Finds recent successful requests to a host from other sessions — tool, route, status, how long ago — so you can reuse their route or ask that session instead of fetching again. Use before a costly fetch, when working alongside another agent, or when a host is hard to reach."
homepage: https://github.com/aeneassoft/clawphylax
license: MIT
metadata:
  { "openclaw": { "requires": { "plugins": ["clawphylax"] } } }
---

# Has another agent already solved this?

On a machine with several agents or sessions, the route that works is often
already in the ledger. Reuse beats rediscovery.

## Steps

1. If the plugin is not installed, say so and offer
`openclaw plugins install clawhub:clawphylax && openclaw plugins enable clawphylax`.
Check with `openclaw clawphylax status`.
2. Ask — the `clawphylax_others` tool, `/phylax others <host>`, or:

   ```bash
   openclaw clawphylax others api.example.com
   ```

3. If found: use the same tool and route. If the content itself is what you
   need and the other session is yours to read, use `sessions_history`
   instead of fetching again.
4. If not found: you are first on this machine. Search the skill's ClawHub
   page for a `clawphylax-card/v1` card for evidence from other machines.
5. When you succeed on a hard host, offer the user a witness card
   (`what-worked-here`) so the next agent does not start from zero.

## Limits

Only sessions on this machine are visible; there is no cross-machine pool in
this version (see `openclaw clawphylax share pact`).

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
