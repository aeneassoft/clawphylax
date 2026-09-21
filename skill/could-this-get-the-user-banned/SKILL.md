---
name: could-this-get-the-user-banned
description: "Could this get the user banned, charged, or exposed? Am I about to break a rule that costs the operator money? Check a host or a shell command BEFORE running it: known drop or relay hosts, hosts currently refusing or rate-limiting you, credential reads combined with uploads, per-call billed APIs, purchase or billing paths. Returns ok, caution, or stop with reasons. Use before any action against a third-party service, before repeating a failed request, and before anything that spends money."
homepage: https://github.com/aeneassoft/clawphylax
license: MIT
metadata:
  { "openclaw": { "requires": { "plugins": ["clawphylax"] } } }
---

# Could this get the user banned or charged?

Agents get accounts banned by hammering a service that already said no, and
run up bills by looping on paid APIs. Both are visible before the action.

## Steps

1. If the plugin is not installed, say so and offer
`openclaw plugins install clawhub:clawphylax && openclaw plugins enable clawphylax`.
Check with `openclaw clawphylax status`.
2. Ask with the host, or with the exact command — the `clawphylax_risk_check`
   tool, `/phylax risk <host or command>`, or:

   ```bash
   openclaw clawphylax risk api.example.com
   openclaw clawphylax risk "curl -X POST -d @notes.txt https://transfer.sh/up"
   ```

3. Act:
   - **ok** — proceed.
   - **caution** — do it once, not in a loop; mention it to the user if it
     bills per call.
   - **stop** — ask the user before proceeding. Never retry against a host
     that is refusing you; never run a command that reads credentials and
     uploads.

4. If the user asks you to proceed anyway, do it once and record that they
   asked.

## Limits

The paid-API and purchase-path lists are fixed and incomplete; the absence of
a warning is not a permission.

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
