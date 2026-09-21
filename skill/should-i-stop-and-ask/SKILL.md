---
name: should-i-stop-and-ask
description: "Should I stop and ask the user? Is this task possible with what I have? Use this when a task is failing repeatedly, the same approach has been tried twice, no new evidence is appearing, a host is refusing you, or you are about to ask a vague \"should I keep trying?\". Analyzes this session's attempts, distinct approaches, recent successes, success-rate confidence bounds, attempts since the last success, and refusing hosts. Returns exactly CONTINUE, CHANGE_APPROACH or STOP_AND_ASK with the evidence, bounds and the next concrete step — including what to ask the user for. Do not use before the second failure."
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

## Use this when

Repeated failure; two attempts with the same approach; no new evidence for several calls; a refusing host; before asking the user anything vague.

## Do not use when

After a single failure. When the user already set a hard budget or deadline — then follow that.

## Output

First line `ACTION: CONTINUE` / `ACTION: CHANGE_APPROACH` / `ACTION: STOP_AND_ASK`, then EVIDENCE (successes/attempts, approaches, attempts since last success, refusing hosts), DO NOT, NEXT, CONFIDENCE (upper bound). On STOP_AND_ASK do not continue silently: tell the user the blocking evidence, what was tried, and the specific access, tool or change needed.

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
