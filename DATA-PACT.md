# The ClawPhylax Data Pact

*Version 1 — the rules under which contributors may, at their choice, pool observed request outcomes so that every contributor's outlook improves with everyone else's observations. Off by default. Nothing leaves your machine in the current version; this document exists so the rules are public before the pool is.*

## What the pool is for

An agent asks, at every failed request, "is it me, the site, or the network?" One machine can answer from its own history. Many machines can answer *before* the first failure: which hosts refuse agents, which rate-limit, which are down right now, which tool works where. That map cannot be built by any single participant, and it is only worth building if the people who feed it are the people who benefit from it.

## Six fields, nothing else

A contributed row is exactly:

| Field | Content | What it is not |
|---|---|---|
| `hostHash` | first 16 hex characters of sha256(hostname) | not the hostname; pooled by hash, joined only when at least 25 contributors share it |
| `method` | GET / POST / … | — |
| `statusClass` | 2xx, 3xx, 4xx, 5xx, 401/403, 429, error | not the status line, not the body |
| `latencyBucket` | <200ms, <1s, <5s, ≥5s | not the timing |
| `tool` | the OpenClaw tool name (web_fetch, exec, browser …) | not the skill name, not the command |
| `day` | UTC date | not a timestamp |

Not in a row, ever: paths, query strings, request or response bodies, headers, cookies, tokens, skill names, session or run ids, agent ids, IP addresses, machine identifiers, user names, timestamps finer than a day. You can see every row before it would leave: `openclaw clawphylax share --preview`.

## What contributors receive

1. **Outlook with context.** "Agents like yours succeed on this host 80 % of the time; you 40 %." The answer to "is it me or the site", from more than one machine.
2. **Early warning.** When a host starts refusing agents, contributors see it before their own attempts fail.
3. **Witness-card matching.** A skill's behavior on your machine compared with what it did elsewhere.
4. **A vote.** Contributors decide, by simple majority of active contributors, whether a future pact version may add a field. Nothing is added to the six fields without a new version and a fresh opt-in; an old consent never covers new fields.

These benefits are free to contributors for as long as the pool exists.

## Rules we bind ourselves to

- **Off by default.** Consent is per machine, recorded locally, revocable with one command (`openclaw clawphylax share off`). Revocation deletes your rows from the pool within 30 days.
- **No raw access.** Raw rows are never sold, never shared per machine, never shown per machine — not to customers, not to partners, not to us in any interface. Only aggregates over at least 25 distinct contributors per host are used or published.
- **Public format.** The row format is this document and the source (`src/share.ts`). A change to the format is a new pact version.
- **No inheritance.** If the operator of the pool changes hands, or these rules change in any way that narrows a guarantee, the pool is deleted and consent starts from zero. Your data cannot be carried into terms you did not accept.
- **Paid use never restricts contributors.** Organisations that do not contribute may pay for fleet views or API access to the aggregates. Nothing they buy reduces what contributors receive, and nothing they buy contains raw rows.
- **Open verification.** Aggregation code will be published with the pool; the numbers in the outlook can be recomputed from the published aggregates.

## Why you should believe this

Because it is checkable, not because we say so: the fields are enumerable in the source, the preview shows the actual rows, the consent record is on your disk, the aggregation threshold is a number you can test by looking for your own host, and the deletion-on-change rule means the only thing we can do with your data is what this document says. The insurance is structural: there is no version of events in which your rows are used under rules you did not opt into, because those rules delete the pool.

## Status

The pool does not exist yet. `openclaw clawphylax share on` records your consent and shows you the rows; nothing is uploaded until a release that includes an upload path, announced in the changelog and requiring the same explicit switch.
