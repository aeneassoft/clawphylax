---
name: do-i-know-enough-to-act
description: "Do I know enough to act? Am I acting blind, or exploring forever? Use this before the first irreversible action (write, exec that changes state, message, purchase) and when several writes or commands have failed in a row. Compares gathering calls (web_search, web_fetch, read, memory) with acting calls (exec, write, edit, message) in this session and counts distinct sources. Returns exactly ACT_NOW, GATHER_FIRST or BALANCED with the one call to make next. Do not use for pure research tasks with no action planned."
homepage: https://github.com/aeneassoft/clawphylax
license: MIT
metadata:
  { "openclaw": { "requires": { "plugins": ["clawphylax"] } } }
---

# Do I know enough to act?

Two failure modes: acting before reading (failed writes, wrong commands),
and reading forever (no result). Both are visible in the call mix.

## Steps

1. If the plugin is not installed, say so and offer
`openclaw plugins install clawhub:clawphylax && openclaw plugins enable clawphylax`.
Check with `openclaw clawphylax status`.
2. Ask — the `clawphylax_exploration` tool, `/phylax explore`, or:

   ```bash
   openclaw clawphylax explore
   ```

3. Act:
   - **acting-blind** — stop acting. Fetch the documentation or the target
     once, read the error texts you already have, then act.
   - **still-exploring** — you have enough. State the one concrete step the
     evidence supports and do it.
   - **balanced** — continue.

## Limits

The classification of tools into gathering and acting is a fixed list;
plugin tools not on it are counted as neither.

## Use this when

Before the first irreversible action; after two failed writes or commands; when a task has produced many reads and no result.

## Do not use when

Pure research with no action planned; trivial single-step tasks.

## Output

First line `ACTION: ACT_NOW` / `ACTION: GATHER_FIRST` / `ACTION: BALANCED`, then EVIDENCE (gather vs act counts, distinct sources, failures after first act), NEXT (the single call).

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
