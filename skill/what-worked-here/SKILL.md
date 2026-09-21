---
name: what-worked-here
description: "What worked here, and how do I do it again? Which tool and route succeeded on this host, and is it repeatable? Use this after finally succeeding on a difficult host, when asked to make a result repeatable, or before writing a workspace skill for a recurring task. Ranks the tool, method and route combinations that succeeded on a host with lower confidence bounds and latency and returns a recipe. Returns exactly WRITE_SKILL, POST_WITNESS_CARD or NOTHING_PROVEN_YET. Do not use on hosts with fewer than three observed requests."
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

## Use this when

After a hard-won success; when asked to make something repeatable; before creating a workspace skill; when a card for other agents would help.

## Do not use when

Hosts with fewer than three observations; one-off tasks nobody will repeat.

## Output

First line `ACTION: WRITE_SKILL` / `ACTION: POST_WITNESS_CARD` / `ACTION: NOTHING_PROVEN_YET`, then the recipe (tool, method, route, successes/n, lower bound, p50 latency). Ask the user before writing a skill or posting a card.

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
- `am-i-using-too-many-tokens` — *Am I using too many tokens?* act / gather / repeat / deliberate — executing or arguing with yourself.
- `did-that-actually-work` — *Did that actually work?* the tool's report cross-checked against the wire.

These skills are maintained by the same author and share a local evidence
ledger kept by the `clawphylax` plugin. Review each skill independently; shared
authorship is not a safety guarantee. `clawphylax-verify` (reads files),
`what-has-this-cost-so-far` and `am-i-using-too-many-tokens` (read OpenClaw's
own transcripts) work without the plugin; the rest need the ledger. Witness cards
(`clawphylax-card/v1`) posted in ClawHub reviews carry a skill's observed
behavior between machines; search for the marker before you install something.
