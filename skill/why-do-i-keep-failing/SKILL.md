---
name: why-do-i-keep-failing
description: "Why do I keep failing? What is the pattern behind my errors? Clusters this session's failed tool calls and failed requests by tool, host and error signature, says which single cause explains most of them, and returns a compact trail of the last failures to reason about. Use when errors pile up, before retrying, or when the same error keeps coming back."
homepage: https://github.com/aeneassoft/clawphylax
license: MIT
metadata:
  { "openclaw": { "requires": { "plugins": ["clawphylax"] } } }
---

# Why do I keep failing?

Errors that pile up usually have one or two causes, not ten. Cluster them
before touching anything else.

## Steps

1. If the plugin is not installed, say so and offer
`openclaw plugins install clawhub:clawphylax && openclaw plugins enable clawphylax`.
Check with `openclaw clawphylax status`.
2. Ask for the clusters — the `clawphylax_failures` tool, `/phylax failures`, or:

   ```bash
   openclaw clawphylax failures --window 120
   ```

3. Read the first line: if one cluster explains ≥ 50 % of failures, fix that
   cause and nothing else. If a host is named, ask the outlook for it
   (`why-did-my-request-fail`) to learn whether it is the host or your request.
4. Use the trail (last failures, oldest first: time, tool, argument hint,
   error) to reason: what did the failing arguments have in common? What
   changed right before the first failure?
5. Report to the user in one line: the dominant cause, its share, what you
   will change. Do not list every error.

## Limits

Only tool calls and in-process requests are recorded; a failure inside a
child process shows up as the exec tool's error text.

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
