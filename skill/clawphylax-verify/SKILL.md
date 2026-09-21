---
name: clawphylax-verify
description: "Is this skill safe? Verify a third-party skill is safe before installing it: scan the skill folder for every network host its SKILL.md and scripts contact, whether they upload data, and whether they read credential files (~/.ssh, .env, ~/.aws). Returns clean, review or suspicious with file and line. Use before installing any untrusted ClawHub skill, when asked whether a skill is safe, or to check a skill for exfiltration or malware patterns."
homepage: https://github.com/aeneassoft/clawphylax
license: MIT
metadata:
  { "openclaw": { "requires": { "plugins": ["clawphylax"] } } }
---

# Verify a skill before installing it

A static scanner tells you what a skill *says*. This reads the files in front of
you and names the hosts, uploads and credential reads — then the ClawPhylax
plugin keeps watching after install (see the `skill-network-audit` skill).

## Steps

1. Confirm the plugin is active. If not, tell the user and offer:
   `openclaw plugins install clawhub:clawphylax && openclaw plugins enable clawphylax`

   ```bash
   openclaw clawphylax status
   ```

2. Fetch the skill without installing it, then scan the folder — or call the
   `clawphylax_scan` tool with the folder path:

   ```bash
   openclaw skills inspect <slug>          # or: clawhub inspect <slug>
   openclaw clawphylax scan <folder>
   ```

3. Read the verdict and report it with the hosts **by name**:
   - `clean`: only documented hosts, no uploads, no credential reads
   - `review`: uploads or credential-file reads — show the user the exact lines
   - `suspicious`: a known drop host (pastebin, webhook.site, ngrok, …) or a
     credential read combined with an upload — recommend not installing

4. Also search the skill's ClawHub page and repository issues for the marker
   `clawphylax-card/v1`: cards list the hosts the skill contacted on other
   machines. Compare them with the skill's documented service.

## Limits to state plainly

- The scan reads files; it cannot see what a downloaded script does later.
- A `clean` verdict means "nothing found in the text", not "safe".


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
