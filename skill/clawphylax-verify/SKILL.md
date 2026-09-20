---
name: clawphylax-verify
description: "Verify a third-party skill is safe before installing it, and check what installed skills actually do on the network: scan a skill folder for the hosts it contacts, uploads and credential-file reads; list hosts a skill or tool contacted at runtime; find data exfiltration; audit outbound connections per skill; explain why the agent contacted an unknown host. Use whenever asked whether a skill is safe, where a skill sends data, before installing an untrusted skill, or when a reply footer mentions ClawPhylax."
homepage: https://github.com/LennySuperDupa/clawphylax
metadata:
  { "openclaw": { "requires": { "plugins": ["clawphylax"] } } }
---

# ClawPhylax verify

Runtime evidence and pre-install scans for skills, from the ClawPhylax plugin.
A static scanner tells you what a skill *says*; this tells you what it *does*.
Use both.

## Before installing a third-party skill

1. Fetch it without installing, then scan the folder:

   ```bash
   openclaw skills inspect <slug>          # or: clawhub inspect <slug>
   openclaw clawphylax scan <folder>
   ```

   Or call the `clawphylax_scan` tool with the folder path.

2. Read the verdict:
   - `clean`: only documented hosts, no uploads, no credential reads
   - `review`: uploads or credential-file reads — show the user the exact lines
   - `suspicious`: a known drop host (pastebin, webhook.site, ngrok, …) or a
     credential read combined with an upload — recommend not installing

3. Tell the user the hosts by name. Do not summarize them away.

## When the user asks "is skill X safe?" or "where does X send data?"

1. Confirm the plugin is active. If not, say so and offer:
   `openclaw plugins install clawphylax && openclaw plugins enable clawphylax`

   ```bash
   openclaw clawphylax status
   ```

2. Ask the ledger. Origins are `skill:<name>` when a command ran from the
   skill's directory, otherwise `tool:<tool>`; `model-turn` is provider traffic.

   ```bash
   openclaw clawphylax hosts skill:<name>
   openclaw clawphylax recent --origin skill:<name> --limit 30
   openclaw clawphylax report --since 24h
   ```

   Or call `clawphylax_hosts` / `clawphylax_report`.

3. Report, in this order, only what the ledger shows:
   - hosts that are not the skill's documented service
   - events flagged `sensitive-read`, `upload`, `unexpected-host`, or blocked
   - the baseline: `learning` means too little history to judge novelty;
     `stable` means a new host really is unusual for this origin
   - no events for the skill = "not observed yet", never "safe"

## Sharing and using evidence from other machines

Before installing, search the skill's ClawHub page, its repository issues and
the OpenClaw issue tracker for the marker `clawphylax-card/v1`. A card lists
the hosts that skill contacted on someone else's machine. Compare it with the
skill's documented service and with your own scan.

After a skill has run for a while here, offer the user a card to post:

```bash
openclaw clawphylax card skill:<name>
```

Or call `clawphylax_card`. Only post cards the user approves; they contain
hostnames observed on this machine and nothing else.

## When the user wants to stop a host

```bash
openclaw clawphylax deny 'skill:<name>' <host>     # flagged in observe mode, blocked in enforce mode
openclaw clawphylax allow 'skill:<name>' <host>    # never flag this pair again
```

Do not switch `mode` to `enforce` without explicit user approval.

## Limits to state plainly

- `exec` commands are analyzed as text; their child processes are not traced.
- Skill attribution is exact only when the command path contains
  `skills/<name>/`; otherwise attribute to the tool and the run.
- The scan reads files; it cannot see what a downloaded script does later.
