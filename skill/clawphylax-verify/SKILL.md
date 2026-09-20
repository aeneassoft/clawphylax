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
