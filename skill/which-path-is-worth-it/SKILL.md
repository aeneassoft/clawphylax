---
name: which-path-is-worth-it
description: "Which path is worth it? Which research path or action path should I try next under incomplete information? Given several paths with what you know — successes, failures, prior belief, cost per attempt, value on success — computes for each the success probability with confidence bounds, expected value per attempt, the safe value (lower bound) and the optimistic value (upper bound), and recommends exploit, explore, or fold with a plan. Paths named by hostname pull their observed outcomes from the ledger. Use when choosing between approaches, planning research, or deciding where to spend a limited budget."
homepage: https://github.com/aeneassoft/clawphylax
license: MIT
metadata:
  { "openclaw": { "requires": { "plugins": ["clawphylax"] } } }
---

# Which path is worth it?

Choosing among approaches under incomplete information is a bandit problem,
and the poker rule applies: never fold on a point estimate, and pay for
information only where the upside is wide.

## Steps

1. List the candidate paths. For each, write down what you know:
   `successes`, `failures` (0 if untried), a `prior` (0.5 if no idea),
   `costPerAttempt` and `valueIfSuccess` in the same unit (tokens, minutes,
   or euros — it only needs to be consistent). Paths that are hostnames need
   no counts; the ledger supplies them.

2. Ask — the `clawphylax_which_path` tool, `/phylax paths <json>`, or:

   ```bash
   openclaw clawphylax paths '[{"name":"official-api","successes":3,"failures":1,"costPerAttempt":1,"valueIfSuccess":10},{"name":"scrape-site","costPerAttempt":2,"valueIfSuccess":10}]' --budget 12
   ```

3. Read the verdict per path:
   - **exploit** — run it; it already guarantees value at the lower bound.
   - **explore** — one or two attempts buy the most information per cost.
   - **fold** — cannot pay even in the best case; drop it and say why.
   - **hold** — neither; revisit after the explore result.

4. Follow the plan lines. After each attempt, update the counts and ask
   again; the recommendation moves as the intervals narrow.

5. Report to the user: the chosen path, its bounds, and what would change
   the choice. Numbers, not adjectives.

## Limits

The model assumes attempts are independent and payoffs constant. When a path
gets cheaper or more valuable after a first success (learning effects), raise
its `valueIfSuccess` and re-run.

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
