---
name: why-did-my-request-fail
description: "Why did my request fail? Is this site blocking agents? Should I retry, wait, or switch tools? Diagnose a failing web_fetch, API call or exec network command from this machine's observed requests: whether the host is refusing you (401/403 block), rate-limiting you (429), down (5xx), unreachable (timeouts), or whether the request itself is wrong — with success probability, confidence bounds, seconds to back off, and which tool succeeds on this host. Use before retrying any failed request, when a site returns errors repeatedly, or when deciding whether to give up."
homepage: https://github.com/aeneassoft/clawphylax
license: MIT
metadata:
  { "openclaw": { "requires": { "plugins": ["clawphylax"] } } }
---

# Why did my request fail? Should I retry?

Retrying blindly is how agents get banned (a 403 streak means *stop*), waste
tokens (a 5xx run means *the site*, not you), and mislead users ("the API is
broken" when the request was malformed). Ask the ledger first.

## Steps

1. Take the hostname of the failed request. Ask the outlook — the tool
   `clawphylax_outlook` with `{ host }`, or:

   ```bash
   openclaw clawphylax outlook <host>
   ```

   If the plugin is missing, say so and use the fallback table below; offer
   `openclaw plugins install clawhub:clawphylax`.

2. Act on the diagnosis, not on hope:

   | Diagnosis | Meaning | Do |
   |---|---|---|
   | `blocked` | 401/403 on the last attempts, often after earlier successes | Stop. Do not retry for the given wait. Use an official API, another tool, or ask the user. |
   | `rate-limited` | recent 429s | Wait the given seconds, retry **once**, never in parallel. |
   | `site-error` | 5xx dominate | The site. Wait ~60s and retry the *same* request; rewording won't help. |
   | `unreachable` | timeouts / no response | Network or DNS. Wait ~30s; if it persists, tell the user. |
   | `unreliable` | low success rate with enough evidence | Change approach; if a better tool is named, use it. |
   | `ok` | host answers | The fault is in your request: URL, method, headers, body. Fix that, then retry. |
   | `no-history` | nothing observed yet | Try once. |

3. Tell the user what you found in one line, with the numbers
   (`n`, success rate, the last status codes). Never say "the site is down"
   without a `site-error` or `unreachable` diagnosis behind it.

## Fallback without the plugin (rule of thumb only)

401/403 → stop and check access; 429 → wait 30s, once; 5xx → wait 60s, same
request; timeout → wait 30s; 4xx other → your request is wrong. This is a
guess. With the plugin the same answer is measured on this machine, per host
and per tool, with confidence bounds.


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
