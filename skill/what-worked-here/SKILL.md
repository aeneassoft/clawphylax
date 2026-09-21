---
name: what-worked-here
description: "What worked here, and how do I do it again? What is the edge I found on this host and is it replicable? Ranks the tool, method and route combinations that succeeded on a host with confidence bounds and latency, and returns a recipe to turn into a workspace skill or a witness card. Use after you finally succeed on a difficult host, or when asked to make a result repeatable."
homepage: https://github.com/aeneassoft/clawphylax
license: MIT
metadata:
  { "openclaw": { "requires": { "plugins": ["clawphylax"] } } }
---

# What worked here?

An edge that is not written down is lost by the next session. Turn the
winning route into something the next agent can run.

## Steps

1. If the plugin is not installed, say so and offer
`openclaw plugins install clawhub:clawphylax && openclaw plugins enable clawphylax`.
Check with `openclaw clawphylax status`.
2. Ask — the `clawphylax_what_worked` tool, `/phylax worked <host>`, or:

   ```bash
   openclaw clawphylax worked api.example.com
   ```

3. Read the recipe: the tool, method and route with the highest lower bound
   is the one to keep. Ignore combinations with n < 3.
4. Make it repeatable: with the user's approval, write a workspace skill
   (use `skill-creator`) that states the tool, the route, and the known
   limits — and offer a witness card:

   ```bash
   openclaw clawphylax card tool:<tool>
   ```

## Limits

Routes are grouped by the first two path segments; deeper differences are
not distinguished. Sequences across several calls are not recorded.

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
