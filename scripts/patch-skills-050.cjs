// Adds the five 0.5.0 messaging skills to gen-skills.cjs (SET, CONTRACT, SKILLS).
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const f = path.join(root, "scripts/gen-skills.cjs");
let g = fs.readFileSync(f, "utf8");
function must(s, from, to, label) {
  if (!s.includes(from)) throw new Error("anchor not found: " + label);
  return s.replace(from, to);
}

const SET_ROWS = `  ["did-that-actually-work", "Did that actually work?", "the tool's report cross-checked against the wire"],
  ["did-my-message-go-out", "Did my message actually go out?", "runtime send result cross-checked against the channel API on the wire"],
  ["is-this-safe-to-send", "Is this safe to send?", "target vs origin conversation; secret-shaped values in the text"],
  ["did-i-do-what-was-asked", "Did I do what was asked?", "request vs reply vs the actions in between"],
  ["what-did-i-lose-in-compaction", "What did I lose in compaction?", "what happened before the cut, with a MUST NOT FORGET list"],
  ["what-did-i-actually-do", "What did I actually do?", "success claims in the transcript checked against the record"],`;
g = must(g, `  ["did-that-actually-work", "Did that actually work?", "the tool's report cross-checked against the wire"],`, SET_ROWS, "set rows");

const CONTRACT = {
  "did-my-message-go-out": {
    description: "Did my message actually go out? Was it delivered, or did the send only look successful? Use this after any message send whose delivery matters — a notification, a reply the user is waiting for, a forward to another chat — and before telling the user it was sent. Cross-checks the runtime's send result (message_sent success/error) against the wire: the request this process made to the channel API (api.telegram.org, discord.com, slack.com, graph.facebook.com, api.twilio.com, graph.microsoft.com) and its status code. Returns exactly DELIVERED, NOT_DELIVERED, CLAIMED_ONLY, CANCELLED, PENDING or NO_SEND. Do not use to confirm channels that deliver outside this process (WhatsApp Web, Signal, iMessage); for those it tells you the wire cannot confirm and what to do instead.",
    useWhen: "After a send whose delivery matters; before saying \"sent\" to the user; when a channel has been flaky; after a message tool returned ok suspiciously fast.",
    doNot: "Sends you do not need to vouch for; channels without an HTTPS API from this process (the verdict will be CLAIMED_ONLY by design).",
    output: "First line `ACTION: REPORT_AS_SENT` / `ACTION: DO_NOT_REPORT_AS_SENT` / `ACTION: VERIFY_ON_RECEIVING_SIDE` / `ACTION: SEND_FIRST`, then EVIDENCE (runtime result; channel API request and status), DO NOT, NEXT, SCOPE. Never tell the user a message was sent on CLAIMED_ONLY, PENDING, NOT_DELIVERED or CANCELLED.",
  },
  "is-this-safe-to-send": {
    description: "Is this safe to send? Am I sending this to the right chat, and does it contain anything that must not leave? Use this before sending a message to any target other than the conversation you are replying in, before forwarding content between chats or channels, and whenever the text could carry a credential, a token, or the contents of a config file. Checks the target against this session's origin conversation and earlier sends, and scans the text for secret-shaped values (sk-, AKIA, ghp_, xoxb-, JWTs, private key blocks, password=) and credential paths (~/.ssh, .env, .aws/credentials). Returns exactly SEND, CONFIRM_WITH_USER or DO_NOT_SEND with reasons. Do not use for a plain reply in the same conversation with no sensitive content.",
    useWhen: "Before a send to a different chat, user, channel or provider than the one you are replying in; before forwarding; before sending anything copied from a file, a terminal or a tool result.",
    doNot: "A plain reply in the same conversation with no sensitive content; a target the user named explicitly in this conversation (that counts as confirmed — still run the secret scan).",
    output: "First line `ACTION: SEND` / `ACTION: CONFIRM_WITH_USER` / `ACTION: DO_NOT_SEND`, then EVIDENCE (target vs origin, first-time target, secret kinds masked, credential paths), DO NOT, NEXT. On DO_NOT_SEND remove the value and re-check; on CONFIRM tell the user the target and the first line and wait for a yes.",
  },
  "did-i-do-what-was-asked": {
    description: "Did I do what was asked? Does my reply match the request, and did the processing in between make sense? Use this after replying to a message, before marking a task handled, when a heartbeat or cron turn produced many tool calls for a small message, and when the user says 'that's not what I asked'. Compares the inbound request (keyword fingerprint, requested actions: send/fetch/create/change/run) with the reply that went out (keyword fingerprint, delivery) and the actions actually taken between them (tool calls, hosts, failures, seconds). Returns exactly COHERENT, PARTIAL, INCOHERENT or NO_PAIR with reasons. No model is consulted and no texts are stored. Do not use to judge tone or factual correctness — it cannot.",
    useWhen: "After every reply that answers a request; before marking a turn handled; after heartbeat/cron turns with a lot of activity; when the user says the answer missed the point.",
    doNot: "Judging tone or facts; turns with no inbound message (NO_PAIR).",
    output: "First line `ACTION: TURN_HANDLED` / `ACTION: ANSWER_THE_MISSING_PART` / `ACTION: REDO_THE_TURN`, then EVIDENCE (request length and asks, reply length, key-term overlap, tool calls and failures, seconds, hosts, delivery), DO NOT, NEXT, SCOPE.",
  },
  "what-did-i-lose-in-compaction": {
    description: "What did I lose in context compaction that I must not forget? What happened before my context was cut? Use this right after a compaction notice, at the start of a resumed session, when an earlier result seems missing from your context, and before retrying anything a summary says failed. Rebuilds from the local ledger what happened before the compaction: hosts contacted, what is blocked or rate-limited for you, failed actions, silent failures (tool said ok, wire said no), undelivered messages, routes that worked, and the last actions before the cut. Returns a MUST NOT FORGET list. Do not use as a general summary of a short session that was never compacted.",
    useWhen: "After a compaction notice; on resume; when something you remember doing is not in your context; before retrying a host or an action the summary mentions.",
    doNot: "Short sessions with no compaction (it still answers, but says so).",
    output: "First line `ACTION: CARRY_FORWARD` / `ACTION: CONTINUE`, then EVIDENCE (compaction time, hosts, failed actions, silent failures, unconfirmed sends, working routes), DO NOT, NEXT (the MUST NOT FORGET list), SCOPE. Write the MUST NOT FORGET items into your working notes before continuing.",
  },
  "what-did-i-actually-do": {
    description: "What do I believe I did, and what did I actually do? Did the things I told the user really happen? Use this before reporting a task as done, after a long session, and whenever you are about to say 'sent', 'published', 'fixed', 'installed' or 'verified'. Reads your own session transcript for success claims and checks each against the record: tool outcomes, outbound sends and their delivery, POST/PUT status codes on the wire. Lists every claim as SUPPORTED, UNSUPPORTED or CONTRADICTED and names failed actions you never mentioned. Returns exactly RECORD_MATCHES_CLAIMS, CLAIMS_EXCEED_RECORD, RECORD_EXCEEDS_CLAIMS or NO_CLAIMS. Do not use before any action has been taken.",
    useWhen: "Before \"done\"; before any sentence with sent / published / fixed / installed / verified; after long or compacted sessions; when the user doubts a result.",
    doNot: "Before any action has been taken; sessions without a transcript under the OpenClaw state directory.",
    output: "First line `ACTION: REPORT_AS_IS` / `ACTION: CORRECT_WHAT_YOU_SAID` / `ACTION: MENTION_THE_FAILURES`, then EVIDENCE (claims supported / unsupported / contradicted, unmentioned failures), DO NOT, NEXT, SCOPE, then the claim list with time, status, kind, sentence and evidence. Correct any CONTRADICTED claim to the user before doing anything else.",
  },
};

const BODY = {
  "did-my-message-go-out": `# Did my message actually go out?

The message tool returns. The runtime says success. Those are two claims from
the same side. The channel API's answer on the wire is the other side. This
skill compares them for one send.

## Procedure

1. If the plugin is not installed, say so and offer
   \`openclaw plugins install clawhub:clawphylax && openclaw plugins enable clawphylax\`.
2. Right after the send, call the \`clawphylax_sent\` tool (defaults to the
   latest send of this session), or \`/phylax sent\`, or:

   \`\`\`bash
   openclaw clawphylax sent
   \`\`\`

3. Act on the verdict:
   - **DELIVERED** — runtime success and a 2xx from the channel API agree. Say it was sent.
   - **NOT_DELIVERED** — the runtime reported an error, or the channel API answered 4xx/5xx
     behind a "success". Do not say it was sent. Run \`why-did-my-request-fail\` for the host.
   - **CLAIMED_ONLY** — success reported, no channel request seen. Either the channel delivers
     outside this process (WhatsApp Web, Signal, iMessage) or nothing left. Verify on the
     receiving side before you vouch for it.
   - **CANCELLED** — a hook cancelled the send (for example a secret-shaped value in enforce
     mode). Nothing went out.
   - **PENDING** — no completion recorded yet. Re-check in a few seconds.

## Rules

- Never report "sent" on anything but DELIVERED, or after you verified the receiving side.
- One check per send that matters.
`,
  "is-this-safe-to-send": `# Is this safe to send?

Two ways a send goes wrong that no reply-quality check catches: it goes to the
wrong conversation, or it carries something that must not leave (a key, a
token, the contents of .env). This skill checks both before the send.

## Procedure

1. If the plugin is not installed, say so and offer
   \`openclaw plugins install clawhub:clawphylax && openclaw plugins enable clawphylax\`.
2. Before the send, call the \`clawphylax_send_check\` tool with the target and the
   text, or \`/phylax send <target> :: <text>\`, or:

   \`\`\`bash
   openclaw clawphylax send <target> <text>
   \`\`\`

3. Act on the verdict:
   - **SEND** — same conversation, no secret-shaped values, target seen before.
   - **CONFIRM_WITH_USER** — different conversation, first-time target, or credential paths in
     the text. Tell the user the target and the first line; wait for a yes.
   - **DO_NOT_SEND** — a secret-shaped value is in the text. Remove it and re-check. If the
     user explicitly wants it sent, say exactly what and where, and wait for a yes.

## What is checked

- Target vs the conversation this session is replying in (from the inbound message record)
  and vs earlier sends of this session.
- Secret shapes: private key blocks, AWS, OpenAI, Anthropic, GitHub, Slack, Stripe, Google,
  Telegram bot, Twilio, npm tokens, JWTs, Bearer tokens, password= assignments, long
  high-entropy tokens. Values are masked in the output and never stored.
- Credential paths named in the text.

In \`enforce\` mode the plugin also cancels any outbound message that carries a
secret-shaped value, at the \`message_sending\` hook.
`,
  "did-i-do-what-was-asked": `# Did I do what was asked?

A reply can be fluent and still answer a different question, skip the action
that was requested, or come after a burst of activity that had nothing to do
with the message. This skill lines up the three things the plugin saw: the
request that came in, the actions in between, and the reply that went out.

## Procedure

1. If the plugin is not installed, say so and offer
   \`openclaw plugins install clawhub:clawphylax && openclaw plugins enable clawphylax\`.
2. After replying, call the \`clawphylax_task_match\` tool, or \`/phylax match\`, or:

   \`\`\`bash
   openclaw clawphylax match
   \`\`\`

3. Act on the verdict:
   - **COHERENT** — the reply covers the request's key terms, the requested action happened,
     effort matched the message. Mark the turn handled.
   - **PARTIAL** — some key terms or one requested action are missing, or the effort was out
     of proportion. Re-read the request and answer the part you skipped.
   - **INCOHERENT** — the reply shares almost nothing with the request, or the requested
     action never succeeded, or the reply was not delivered. Do not mark the turn handled;
     do the missing action or say plainly that you could not, and reply again.
   - **NO_PAIR** — no inbound message recorded for this session, or no reply after it yet.

## What is compared

- Keyword fingerprints of request and reply (the texts themselves are not stored).
- Requested actions detected in the request (send / fetch / create / change / run) vs the
  tools that succeeded between request and reply, and hosts reached on the wire.
- Request length vs reply length; message size vs number of tool calls; seconds elapsed;
  delivery verdict of the reply.

It cannot judge tone or whether the facts in the reply are right.
`,
  "what-did-i-lose-in-compaction": `# What did I lose in compaction?

When the context is compacted, the summary keeps what the summariser thought
mattered. The ledger kept everything that actually happened: every host, every
tool outcome, every send, every silent failure. This skill rebuilds the part a
summary drops most often — what is blocked for you, what failed, what is not
yet confirmed, and what worked.

## Procedure

1. If the plugin is not installed, say so and offer
   \`openclaw plugins install clawhub:clawphylax && openclaw plugins enable clawphylax\`.
2. Right after a compaction notice (or on resume), call the
   \`clawphylax_compaction_brief\` tool, or \`/phylax brief\`, or:

   \`\`\`bash
   openclaw clawphylax brief
   \`\`\`

3. Write the **MUST NOT FORGET** items into your working notes before continuing:
   - hosts that are blocked, rate-limited or unreachable for you, with the back-off;
   - actions that reported ok while the wire said no (silent failures) — those are not done;
   - messages whose delivery is not confirmed — do not tell the user they were sent;
   - the last failed action before the cut — do not repeat it unchanged;
   - tool/host routes that worked — reuse them.

## Notes

- The plugin records \`before_compaction\` and \`after_compaction\`, so the brief knows where
  the cut was and lists the last actions before it.
- With no compaction on record it still answers from the ledger and says so.
`,
  "what-did-i-actually-do": `# What did I actually do?

What you told the user is in the transcript. What happened is in the ledger:
tool outcomes, sends and their delivery, status codes on the wire. This skill
reads both and lines them up, claim by claim.

## Procedure

1. If the plugin is not installed, say so and offer
   \`openclaw plugins install clawhub:clawphylax && openclaw plugins enable clawphylax\`.
2. Before reporting a task as done, call the \`clawphylax_reconcile\` tool, or
   \`/phylax reconcile\`, or:

   \`\`\`bash
   openclaw clawphylax reconcile
   \`\`\`

3. Act on the verdict:
   - **RECORD_MATCHES_CLAIMS** — every success claim has evidence, nothing contradicted,
     no unmentioned failures. Report as is.
   - **CLAIMS_EXCEED_RECORD** — at least one claim is contradicted by the record (the send
     failed, the POST got a 4xx, the last action before "done" failed) or too many have no
     evidence. Correct what you told the user before doing anything else.
   - **RECORD_EXCEEDS_CLAIMS** — claims hold, but failed actions never appeared in what you
     said. Say what failed.
   - **NO_CLAIMS** — no success claims in the transcript yet.

## How claims are checked

- "sent / delivered / notified" → an outbound send before the sentence and its delivery
  verdict (runtime result × channel API status).
- "published / posted / uploaded / deployed / pushed" → a POST/PUT/PATCH on the wire with
  its status; an exec alone counts as unverified.
- "created / saved / fixed / installed / scheduled" → a successful write/edit/exec/cron.
- "verified / confirmed" → a check, read or fetch after the action.
- "done / completed" → the last action before the sentence did not fail.

Sentences that themselves report a failure are not counted as claims.
`,
};

g = must(g, `const CONTRACT = {`, `const CONTRACT = {\n` + Object.entries(CONTRACT).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v, null, 4).replace(/\n/g, "\n  ")},`).join("\n") + "\n", "contract");
g = must(g, `const SKILLS = {`, `const SKILLS = {\n` + Object.entries(BODY).map(([k, body]) => `  ${JSON.stringify(k)}: { description: ${JSON.stringify(CONTRACT[k].description)}, body: ${JSON.stringify(body)} },`).join("\n") + "\n", "skills");
fs.writeFileSync(f, g);
console.log("gen-skills patched for 0.5.0");
