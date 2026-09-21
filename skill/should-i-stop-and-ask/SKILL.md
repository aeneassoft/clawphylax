---
name: should-i-stop-and-ask
description: "Should I stop and ask the user? Is this task actually possible with what I have? A stopping rule from this session's attempts: success rate with confidence bounds across distinct approaches, attempts since the last success, and hosts that are refusing you. Returns continue, change-approach, or stop-and-ask with reasons. Use when a task drags on, before yet another retry, or when you suspect the task cannot be done under the current conditions."
homepage: https://github.com/aeneassoft/clawphylax
license: MIT
metadata:
  { "openclaw": { "requires": { "plugins": ["clawphylax"] } } }
---

# Should I stop and ask?

Continuing is a decision, not a default. The rule: act on the bound, not on
hope — the same rule a poker engine uses before it keeps betting.

## Steps

1. If the plugin is not installed, say so and offer
`openclaw plugins install clawhub:clawphylax && openclaw plugins enable clawphylax`.
Check with `openclaw clawphylax status`.
2. Ask the rule — the `clawphylax_stop_or_continue` tool, `/phylax stop`, or:

   ```bash
   openclaw clawphylax stop
   ```

3. Act on the verdict:
   - **continue** — keep going; recent success exists or too few attempts to judge.
   - **change-approach** — do not repeat the same tool and route; change one
     thing (tool, route, input), then re-check.
   - **stop-and-ask** — stop. Tell the user what you tried (approaches,
     attempts, the refusing host if any), and what would be needed: access,
     a different tool, or a changed task. This is a good outcome, not a failure.

4. Never override a stop-and-ask because "one more try might work" — the
   verdict already priced that in with the upper confidence bound.

## Limits

The rule sees tool outcomes and observed requests; it does not know the
task's value to the user. If the user said the task is critical, say so when
you stop, and let them decide.

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
