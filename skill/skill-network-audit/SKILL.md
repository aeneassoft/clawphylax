---
name: skill-network-audit
description: "Where does this skill send data? What hosts did it contact? Find out where an installed skill sends data: list every network host a skill or tool contacted at runtime, with counts, uploads, credential reads and flagged or unexpected hosts, from the ClawPhylax ledger. Audit outbound connections per skill, explain why the agent contacted an unknown host, detect data exfiltration after install, and share a witness card of a skill's real behavior. Use when asked what a skill is doing on the network, why something contacted a host, or when a reply footer mentions ClawPhylax."
homepage: https://github.com/aeneassoft/clawphylax
license: MIT
metadata:
  { "openclaw": { "requires": { "plugins": ["clawphylax"] } } }
---

# Where does this skill send data?

Runtime evidence from the ClawPhylax plugin: every outbound connection of the
Gateway, attributed to the skill or tool that caused it, in a local ledger.

## Steps

1. Confirm the plugin is active; if not, offer
   `openclaw plugins install clawhub:clawphylax && openclaw plugins enable clawphylax`

   ```bash
   openclaw clawphylax status
   ```

2. Ask the ledger. Origins are `skill:<name>` when a command ran from the
   skill's directory, otherwise `tool:<tool>`; `model-turn` is provider traffic.
   The tools `clawphylax_hosts` and `clawphylax_report` return the same data.

   ```bash
   openclaw clawphylax hosts skill:<name>
   openclaw clawphylax recent --origin skill:<name> --limit 30
   openclaw clawphylax report --since 24h
   ```

3. Report, in this order, only what the ledger shows:
   - hosts that are not the skill's documented service
   - events flagged `sensitive-read`, `upload`, `unexpected-host`, or blocked
   - the baseline: `learning` = too little history to judge novelty;
     `stable` = a new host really is unusual for this origin
   - no events for the skill = "not observed yet", never "safe"

4. To stop a host (ask the user first; `enforce` mode can interrupt tasks):

   ```bash
   openclaw clawphylax deny 'skill:<name>' <host>
   openclaw clawphylax allow 'skill:<name>' <host>
   ```

5. After a skill has run for a while, offer the user a witness card to post in
   the skill's ClawHub review or an issue, so other agents can check it before
   installing. Only post cards the user approves; they contain hostnames only.

   ```bash
   openclaw clawphylax card skill:<name>
   ```

## Limits to state plainly

- `exec` commands are analyzed as text; their child processes are not traced.
- Attribution to a skill is exact only when the command path contains
  `skills/<name>/`; otherwise attribute to the tool and the run.


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
