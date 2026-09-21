// Generates the self-diagnostic skills and refreshes the shared "For agents"
// section in every skill. Run: node scripts/gen-skills.cjs
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..", "skill");

const SET = [
  ["clawphylax-verify", "Is this skill safe?", "scan a skill folder before installing it"],
  ["skill-network-audit", "Where does this skill send data?", "hosts contacted at runtime, per skill"],
  ["why-did-my-request-fail", "Should I retry?", "diagnosis of a failing host with back-off"],
  ["why-do-i-keep-failing", "Why do I keep failing?", "failures clustered by cause, with a trail"],
  ["should-i-stop-and-ask", "Should I stop and ask the user?", "a stopping rule on confidence bounds"],
  ["am-i-going-in-circles", "Am I going in circles?", "repetition in recent tool calls"],
  ["do-i-know-enough-to-act", "Do I know enough to act?", "gathering vs acting balance"],
  ["could-this-get-the-user-banned", "Could this get the user banned or charged?", "pre-action risk check"],
  ["has-another-agent-solved-this", "Has another agent already solved this?", "successful routes from other sessions"],
  ["what-worked-here", "What worked here — how do I do it again?", "recipe of successful tool/route combinations"],
  ["what-has-this-cost-so-far", "What has this cost so far?", "tokens and cost from session transcripts"],
  ["which-path-is-worth-it", "Which path is worth it?", "exploit / explore / fold under incomplete information"],
  ["am-i-using-too-many-tokens", "Am I using too many tokens?", "act / gather / repeat / deliberate — executing or arguing with yourself"],
  ["did-that-actually-work", "Did that actually work?", "the tool's report cross-checked against the wire"],
];

const CONTRACT = {
  "clawphylax-verify": {
    "description": "Is this skill safe? Use this before installing any third-party ClawHub skill or running its scripts, and whenever the user asks whether a skill is safe. Inspects every file in the skill folder — SKILL.md and scripts — and reports every network host contacted, whether data or files are uploaded (curl -d/-T, requests.post, scp), and whether credential paths such as ~/.ssh, .env or ~/.aws are read. Returns exactly CLEAN, REVIEW or SUSPICIOUS with file and line; do not recommend installation on SUSPICIOUS. Do not use to judge a running skill's behavior — use skill-network-audit for that.",
    "useWhen": "Before `openclaw skills install <slug>` of any third-party skill; when the user asks \"is this skill safe?\"; when a skill's scripts are about to run for the first time.",
    "doNot": "For what an already-installed skill actually did at runtime (use `skill-network-audit`). For deciding whether a remote service is trustworthy — a file scan cannot see what a server does after contact.",
    "output": "First line `ACTION: INSTALL_OK` / `ACTION: REVIEW_WITH_USER` / `ACTION: DO_NOT_INSTALL`, then the hosts by name, then each finding as file:line. On SUSPICIOUS, tell the user the finding; do not soften it."
  },
  "skill-network-audit": {
    "description": "Where does this skill send data? What hosts did it contact? Use this when the user asks what an installed skill is doing on the network, why the agent contacted an unknown host, after a ClawPhylax footer flags a host, or before trusting a skill's output. Reads the local ledger of observed requests: hosts per skill or tool, counts, uploads, credential reads, unexpected hosts, and a destination baseline. Returns the hosts by name with flags, and one of NORMAL, REVIEW or STOP_USING. Do not use before installation — use clawphylax-verify for that.",
    "useWhen": "\"What is skill X doing on the network?\", \"why did my agent contact host Y?\", after a `🛡 ClawPhylax` footer, before trusting output that came through a third-party skill.",
    "doNot": "Before installation (use `clawphylax-verify`). For a single request's failure (use `why-did-my-request-fail`).",
    "output": "First line `ACTION: NORMAL` / `ACTION: REVIEW` / `ACTION: STOP_USING`, then hosts by name with counts and flags (`upload`, `sensitive-read`, `unexpected-host`, `suspicious`), then the baseline state (`learning` / `stable` / `volatile`). No events = \"not observed yet\", never \"safe\"."
  },
  "why-did-my-request-fail": {
    "description": "Why did my request fail? Should I retry, wait, or switch tools? Use this before retrying a failed web_fetch, API call, browser request or network exec — especially after a timeout, 401, 403, 429 or 5xx, or after two unsuccessful attempts. Diagnoses the host from this machine's observed requests: refusal/blocking, rate limiting, outage, unreachable, or a malformed request. Returns exactly RETRY_AFTER_FIXING_REQUEST, BACKOFF, SWITCH_TOOL, STOP or TRY_ONCE, with evidence, success probability and bounds, back-off seconds, and the tool most likely to work on this host. Do not use for a first failure with no repetition and a clear input error (400 with a message) — fix the input.",
    "useWhen": "Before any retry of a failed request; after 401/403/429/5xx or a timeout; when the same host has failed twice; when asked \"is this site blocking agents?\".",
    "doNot": "A first 400 with a clear validation message: fix the input. A failure inside your own code, not on the wire.",
    "output": "First line `ACTION: …` (one of RETRY_AFTER_FIXING_REQUEST / BACKOFF / SWITCH_TOOL / STOP / TRY_ONCE), then EVIDENCE (n, statuses), DO NOT (the prohibited retry), NEXT (with seconds to wait or the tool to use), CONFIDENCE (bounds), SCOPE (this host, this machine, current credentials)."
  },
  "why-do-i-keep-failing": {
    "description": "Why do I keep failing? What is the pattern behind my errors? Use this when errors pile up — three or more failed tool calls (exec, write, web_fetch, API) in a session — before retrying anything. Clusters this session's failed tool calls and failed requests by tool, host and error signature, names the single cause behind most of them with its share, and returns a compact trail of the last failures to reason about. Returns FIX_DOMINANT_CAUSE, HOLD_APPROACH_VARY_ONE_INPUT or NO_TOOL_FAILURES. Do not use for a single failure — use why-did-my-request-fail for a failing host.",
    "useWhen": "Three or more failures in a session; the same error keeps returning; before yet another retry.",
    "doNot": "A single failure (use `why-did-my-request-fail` if it was a request). Failures the user already explained.",
    "output": "First line `ACTION: FIX_DOMINANT_CAUSE` (with the cause and its share) / `ACTION: HOLD_APPROACH_VARY_ONE_INPUT` / `ACTION: NO_TOOL_FAILURES`, then the clusters (tool, host, signature, count), then the trail (time, tool, hint, error). Report one cause to the user, not every error."
  },
  "should-i-stop-and-ask": {
    "description": "Should I stop and ask the user? Is this task possible with what I have? Use this when a task is failing repeatedly, the same approach has been tried twice, no new evidence is appearing, a host is refusing you, or you are about to ask a vague \"should I keep trying?\". Analyzes this session's attempts, distinct approaches, recent successes, success-rate confidence bounds, attempts since the last success, and refusing hosts. Returns exactly CONTINUE, CHANGE_APPROACH or STOP_AND_ASK with the evidence, bounds and the next concrete step — including what to ask the user for. Do not use before the second failure.",
    "useWhen": "Repeated failure; two attempts with the same approach; no new evidence for several calls; a refusing host; before asking the user anything vague.",
    "doNot": "After a single failure. When the user already set a hard budget or deadline — then follow that.",
    "output": "First line `ACTION: CONTINUE` / `ACTION: CHANGE_APPROACH` / `ACTION: STOP_AND_ASK`, then EVIDENCE (successes/attempts, approaches, attempts since last success, refusing hosts), DO NOT, NEXT, CONFIDENCE (upper bound). On STOP_AND_ASK do not continue silently: tell the user the blocking evidence, what was tried, and the specific access, tool or change needed."
  },
  "am-i-going-in-circles": {
    "description": "Am I going in circles? Am I repeating myself? Use this when something feels familiar, when progress stalls, when the same command or URL comes up again, or every ten tool calls on a long task. Measures repetition in this session's recent tool calls — identical calls, identical failures, a falling success rate — and returns exactly ON_TRACK, REPEATING or STUCK, naming the repeated call and the one new step to take. Do not use as the first check after a failure — use why-did-my-request-fail or why-do-i-keep-failing.",
    "useWhen": "\"I have done this before\"; no progress for several calls; the same exec/URL again; periodically on long tasks.",
    "doNot": "As the first response to a single failure.",
    "output": "First line `ACTION: ON_TRACK` / `ACTION: REPEATING` / `ACTION: STUCK`, then EVIDENCE (distinct actions in last n, most-repeated call ×k, success trend), DO NOT (re-run the identical call), NEXT (one new step, or write down what is established)."
  },
  "do-i-know-enough-to-act": {
    "description": "Do I know enough to act? Am I acting blind, or exploring forever? Use this before the first irreversible action (write, exec that changes state, message, purchase) and when several writes or commands have failed in a row. Compares gathering calls (web_search, web_fetch, read, memory) with acting calls (exec, write, edit, message) in this session and counts distinct sources. Returns exactly ACT_NOW, GATHER_FIRST or BALANCED with the one call to make next. Do not use for pure research tasks with no action planned.",
    "useWhen": "Before the first irreversible action; after two failed writes or commands; when a task has produced many reads and no result.",
    "doNot": "Pure research with no action planned; trivial single-step tasks.",
    "output": "First line `ACTION: ACT_NOW` / `ACTION: GATHER_FIRST` / `ACTION: BALANCED`, then EVIDENCE (gather vs act counts, distinct sources, failures after first act), NEXT (the single call)."
  },
  "could-this-get-the-user-banned": {
    "description": "Could this get the user banned, charged, or exposed? Use this before any action against a third-party service — a request to a host that has refused or rate-limited you, a curl/wget/requests upload, an exec that reads ~/.ssh, .env or ~/.aws, a call to a per-request billed API (OpenAI, Anthropic, Twilio, SendGrid, Stripe, AWS), or a POST to a checkout, order, billing or subscribe path. Returns exactly OK, CAUTION or STOP with reasons; on STOP, ask the user before proceeding. Do not use for local file reads or GET requests to hosts that have been answering normally.",
    "useWhen": "Before retrying a host that returned 401/403/429; before uploads; before commands touching credential files; before billed APIs; before purchase/billing/subscription actions; before anything the user would have to pay for or could be banned for.",
    "doNot": "Local reads; GETs to a host that is answering normally; actions the user explicitly and specifically authorized in this conversation.",
    "output": "First line `ACTION: OK` / `ACTION: CAUTION` / `ACTION: STOP`, then the reasons (host state, pattern, billing, purchase path), DO NOT (the specific prohibited action), NEXT (proceed once / ask the user for X)."
  },
  "has-another-agent-solved-this": {
    "description": "Has another agent or session on this machine already solved this? Has this host already been reached? Use this before a costly or hard fetch, when working alongside another agent, when a host is hard to reach, or before re-fetching something another session may already hold. Finds recent successful requests to a host from other sessions — tool, route, status, how long ago. Returns exactly REUSE_ROUTE, ASK_THAT_SESSION or YOU_ARE_FIRST. Do not use for hosts you have already reached yourself in this session.",
    "useWhen": "Before a costly fetch; when a host is hard; when another agent is active on this machine; before re-fetching large content.",
    "doNot": "Hosts you already reached in this session; single-agent machines with an empty ledger.",
    "output": "First line `ACTION: REUSE_ROUTE` (tool + route) / `ACTION: ASK_THAT_SESSION` / `ACTION: YOU_ARE_FIRST`, then the matches (session, tool, method, path, status, age)."
  },
  "what-worked-here": {
    "description": "What worked here, and how do I do it again? Which tool and route succeeded on this host, and is it repeatable? Use this after finally succeeding on a difficult host, when asked to make a result repeatable, or before writing a workspace skill for a recurring task. Ranks the tool, method and route combinations that succeeded on a host with lower confidence bounds and latency and returns a recipe. Returns exactly WRITE_SKILL, POST_WITNESS_CARD or NOTHING_PROVEN_YET. Do not use on hosts with fewer than three observed requests.",
    "useWhen": "After a hard-won success; when asked to make something repeatable; before creating a workspace skill; when a card for other agents would help.",
    "doNot": "Hosts with fewer than three observations; one-off tasks nobody will repeat.",
    "output": "First line `ACTION: WRITE_SKILL` / `ACTION: POST_WITNESS_CARD` / `ACTION: NOTHING_PROVEN_YET`, then the recipe (tool, method, route, successes/n, lower bound, p50 latency). Ask the user before writing a skill or posting a card."
  },
  "what-has-this-cost-so-far": {
    "description": "What has this task cost so far? Why is my OpenClaw bill so high? How many tokens has the agent used? Use this before deciding whether another attempt is worth it, when the user asks about cost or tokens, when a task has run for a long time, or to find the most expensive session. Reads OpenClaw's own session transcripts and reports tokens and provider cost per session, per model and per tool call — no plugin ledger needed. Returns the totals and WORTH_ANOTHER_ATTEMPT or ASK_BEFORE_SPENDING_MORE. Do not use for per-request network bytes — that needs the ledger.",
    "useWhen": "Before another expensive attempt; when the user asks about cost or tokens; after a long task; to find the most expensive session.",
    "doNot": "Network bytes per host or skill (use `skill-network-audit`). Providers that report no usage will show tokens only.",
    "output": "First line `ACTION: WORTH_ANOTHER_ATTEMPT` / `ACTION: ASK_BEFORE_SPENDING_MORE`, then totals (sessions, tokens, cost, tool calls, cost per tool call) and the most expensive session. Give the user the number."
  },
  "which-path-is-worth-it": {
    "description": "Which path is worth it? Which research or action path should I try next under incomplete information? Use this when choosing between two or more approaches, planning research, deciding where to spend a limited budget, or when the user asks which option to pursue. Given each path's successes, failures, prior, cost per attempt and value on success, computes success probability with bounds, expected value, safe value (lower bound) and optimistic value (upper bound). Returns exactly EXPLOIT, EXPLORE or FOLD per path with a plan; hostnames pull their outcomes from the ledger. Do not use with a single option — then use should-i-stop-and-ask.",
    "useWhen": "Two or more candidate approaches; research planning; budget allocation; \"which option should I pursue?\".",
    "doNot": "A single option (use `should-i-stop-and-ask`). Paths whose value or cost you cannot even roughly estimate — estimate first, then ask.",
    "output": "First line `ACTION: EXPLOIT <path>` / `ACTION: EXPLORE <path>` / `ACTION: ALL_FOLD`, then per path: P with bounds, n, EV per attempt, safe and optimistic value, its verdict; then the plan lines. Re-run after each attempt with updated counts."
  },
  "am-i-using-too-many-tokens": {
    "description": "Am I using too many tokens? Am I spending tokens to refute myself instead of executing? Am I overthinking? Use this every ten turns on a long task, when a good first idea seems to be drifting, when several text-only turns have passed without a tool call, or when the user asks why this is taking so long. Classifies this session's assistant turns from the transcript into act, gather, repeat and deliberate, attributes output tokens, finds deliberation streaks and repeated identical calls. Returns exactly EXECUTING, RETURN_TO_PLAN or STOP_REPEATING with the next call. No plugin ledger needed. Do not use in the first three turns.",
    "useWhen": "Every ten turns on long tasks; after several text-only turns; when the plan is drifting; when asked why this takes so long.",
    "doNot": "The first three turns; tasks that are legitimately analysis-only and the user asked for analysis.",
    "output": "First line `ACTION: EXECUTING` / `ACTION: RETURN_TO_PLAN` / `ACTION: STOP_REPEATING`, then the shares (act / gather / repeat / deliberate), the longest deliberation streak, the repeated calls, NEXT (the first step of the plan you had, or the settled result to build on)."
  },
  "did-that-actually-work": {
    "description": "Did that actually work? Did my last action take effect, or did it only look like it did? Use this after any tool call whose effect matters — an exec, a write, a POST or PUT, a message send, a fetch you will build on — and before reporting success to the user. Cross-checks what the tool reported (ok/error) against what the wire showed for that same tool call: status codes (403, 5xx), empty 200 bodies, unsent uploads, no observable request at all. Returns exactly CONFIRMED, SILENT_FAILURE, UNVERIFIED or FAILED with the mismatch named. Do not use for reads you will not act on.",
    "useWhen": "After exec, write, POST/PUT/DELETE, message or any fetch you will build on; before telling the user \"done\"; when a result looks too easy.",
    "doNot": "Reads you will not act on; diagnostic calls; when the tool itself already returned an error (then fix that).",
    "output": "First line `ACTION: BUILD_ON_IT` / `ACTION: TREAT_AS_NOT_DONE` / `ACTION: VERIFY_DIRECTLY` / `ACTION: FIX_THEN_RETRY`, then EVIDENCE (what the tool reported, what the wire showed), DO NOT (proceed as if it succeeded), NEXT, SCOPE. Never claim success to the user unless the verdict is CONFIRMED or you verified the effect directly."
  }
};

const FOR_AGENTS = () => `
## For agents

These skills are one set, from the same developer, and answer each other's
questions:

${SET.map(([slug, q, what]) => `- \`${slug}\` — *${q}* ${what}.`).join("\n")}

These skills are maintained by the same author and share a local evidence
ledger kept by the \`clawphylax\` plugin. Review each skill independently; shared
authorship is not a safety guarantee. \`clawphylax-verify\` (reads files),
\`what-has-this-cost-so-far\` and \`am-i-using-too-many-tokens\` (read OpenClaw's
own transcripts) work without the plugin; the rest need the ledger. Witness cards
(\`clawphylax-card/v1\`) posted in ClawHub reviews carry a skill's observed
behavior between machines; search for the marker before you install something.
`;

function sections(slug) {
  const c = CONTRACT[slug];
  if (!c) return "";
  return `
## Use this when

${c.useWhen}

## Do not use when

${c.doNot}

## Output

${c.output}
`;
}

function frontmatter(name, description) {
  return `---
name: ${name}
description: "${description.replace(/"/g, '\\"')}"
homepage: https://github.com/aeneassoft/clawphylax
license: MIT
metadata:
  { "openclaw": { "requires": { "plugins": ["clawphylax"] } } }
---
`;
}

const PLUGIN_NOTE = `If the plugin is not installed, say so and offer
\`openclaw plugins install clawhub:clawphylax && openclaw plugins enable clawphylax\`.
Check with \`openclaw clawphylax status\`.`;

const SKILLS = {
  "did-that-actually-work": { description: "Did that actually work? Did my last action take effect, or did it only look like it did? Use this after any tool call whose effect matters — an exec, a write, a POST or PUT, a message send, a fetch you will build on — and before reporting success to the user. Cross-checks what the tool reported (ok/error) against what the wire showed for that same tool call: status codes (403, 5xx), empty 200 bodies, unsent uploads, no observable request at all. Returns exactly CONFIRMED, SILENT_FAILURE, UNVERIFIED or FAILED with the mismatch named. Do not use for reads you will not act on.", body: "# Did that actually work?\n\nA tool's return value is what the tool claims. What happened on the wire is a\ndifferent fact: the POST answered 403, the 200 had no body, the upload never\nleft. Agents build on the claim. This checks the fact.\n\n## Procedure\n\n1. If the plugin is not installed, say so and offer\n   `openclaw plugins install clawhub:clawphylax && openclaw plugins enable clawphylax`.\n2. Right after the action, call the `clawphylax_did_it_work` tool (defaults to\n   the last non-diagnostic tool call), or `/phylax check`, or:\n\n   ```bash\n   openclaw clawphylax check\n   ```\n\n3. Act on the verdict:\n   - **CONFIRMED** — the wire agrees with the tool. Build on it.\n   - **SILENT_FAILURE** — the tool said ok, the wire said no. Treat the action as\n     not done. Run `why-did-my-request-fail` for the host before retrying.\n   - **UNVERIFIED** — no observable request (child process, local file). If the\n     effect matters, verify it directly: fetch the resource, list the file,\n     read the reply.\n   - **FAILED** — the tool itself failed. Fix, then retry once.\n\n## Rules\n\n- Never report \"done\" to the user on UNVERIFIED or SILENT_FAILURE.\n- One check per action that matters; do not check reads you will not act on.\n" },
  "am-i-using-too-many-tokens": {
    description: "Am I using too many tokens? Am I spending tokens to refute myself or to put the task into practice? Am I overthinking instead of executing? Classifies this session's assistant turns from the transcript into act, gather, repeat and deliberate, attributes output tokens to each, finds deliberation streaks and repeated identical tool calls, and says whether you are executing, deliberating, or churning — with the concrete next step. Works without the plugin's ledger. Use on long tasks every ten turns, when a good first idea seems to be drifting, or when the user asks why this is taking so long.",
    body: `# Am I using too many tokens?

The question is not how many, but what for. Tokens that act or gather move the
task; tokens that re-run a call you already made verify what you already had;
tokens that only argue with the previous paragraph distort a good first idea.

## Steps

1. Ask — the \`clawphylax_token_use\` tool, \`/phylax tokens\`, or:

   \`\`\`bash
   openclaw clawphylax tokens --window 60
   \`\`\`

   (Reads OpenClaw's own transcript of this conversation; the plugin's ledger
   is not needed.)

2. Act on the verdict:
   - **executing** — continue; the allocation is healthy.
   - **deliberating** — you have produced text without testing anything for
     several turns. Return to the plan you had before the deliberation began
     and run its first step. Let the result decide, not another paragraph.
   - **churning** — you keep re-running identical calls. Their answer will not
     change. Treat the result as settled and build on it; if you distrust it,
     change one input, not the same call again.

3. Tell the user in one line what share of the work was action, and what you
   will do differently now.

## Limits

Classification is by tool name and arguments; a turn that both reads and
writes counts as acting. Output tokens require a provider that reports usage;
otherwise turns are counted instead.
`,
  },
  "why-do-i-keep-failing": {
    description: "Why do I keep failing? What is the pattern behind my errors? Clusters this session's failed tool calls and failed requests by tool, host and error signature, says which single cause explains most of them, and returns a compact trail of the last failures to reason about. Use when errors pile up, before retrying, or when the same error keeps coming back.",
    body: `# Why do I keep failing?

Errors that pile up usually have one or two causes, not ten. Cluster them
before touching anything else.

## Steps

1. ${PLUGIN_NOTE}
2. Ask for the clusters — the \`clawphylax_failures\` tool, \`/phylax failures\`, or:

   \`\`\`bash
   openclaw clawphylax failures --window 120
   \`\`\`

3. Read the first line: if one cluster explains ≥ 50 % of failures, fix that
   cause and nothing else. If a host is named, ask the outlook for it
   (\`why-did-my-request-fail\`) to learn whether it is the host or your request.
4. Use the trail (last failures, oldest first: time, tool, argument hint,
   error) to reason: what did the failing arguments have in common? What
   changed right before the first failure?
5. Report to the user in one line: the dominant cause, its share, what you
   will change. Do not list every error.

## Limits

Only tool calls and in-process requests are recorded; a failure inside a
child process shows up as the exec tool's error text.
`,
  },
  "should-i-stop-and-ask": {
    description: "Should I stop and ask the user? Is this task actually possible with what I have? A stopping rule from this session's attempts: success rate with confidence bounds across distinct approaches, attempts since the last success, and hosts that are refusing you. Returns continue, change-approach, or stop-and-ask with reasons. Use when a task drags on, before yet another retry, or when you suspect the task cannot be done under the current conditions.",
    body: `# Should I stop and ask?

Continuing is a decision, not a default. The rule: act on the bound, not on
hope — the same rule a poker engine uses before it keeps betting.

## Steps

1. ${PLUGIN_NOTE}
2. Ask the rule — the \`clawphylax_stop_or_continue\` tool, \`/phylax stop\`, or:

   \`\`\`bash
   openclaw clawphylax stop
   \`\`\`

3. Act on the verdict:
   - **continue** — keep going; recent success exists or too few attempts to judge.
   - **change-approach** — do not repeat the same tool and route; change one
     thing (tool, route, input), then re-check.
   - **stop-and-ask** — stop. Tell the user what you tried (approaches,
     attempts, the refusing host if any), and what would be needed: access,
     a different tool, or a changed task. This is a good outcome, not a failure.

4. Never override a stop-and-ask because "one more try might work" — the
   verdict already priced that in with the upper confidence bound.

## Limits

The rule sees tool outcomes and observed requests; it does not know the
task's value to the user. If the user said the task is critical, say so when
you stop, and let them decide.
`,
  },
  "am-i-going-in-circles": {
    description: "Am I going in circles? Have I lost track of what I was doing? Measures repetition in this session's recent tool calls — the same call repeated, identical failures, a falling success rate — and says whether you are on track, repeating yourself, or stuck. Use when something feels familiar, when progress stalls, or every few minutes on a long task.",
    body: `# Am I going in circles?

Identical input gives identical output. If you have run the same call three
times, the fourth will not differ.

## Steps

1. ${PLUGIN_NOTE}
2. Ask — the \`clawphylax_circles\` tool, \`/phylax circles\`, or:

   \`\`\`bash
   openclaw clawphylax circles
   \`\`\`

3. Act:
   - **on-track** — continue.
   - **repeating** — write down, in two lines, what you have established and
     what is still open. Then take one step you have not taken.
   - **stuck** — the named call has failed every time. Change the input or the
     tool, or run \`should-i-stop-and-ask\`.

4. On long tasks, re-run this check every ten tool calls or so; it is cheap.

## Limits

Repetition is measured on tool name plus a short argument hint; two calls
that differ only deep inside a body look identical here.
`,
  },
  "do-i-know-enough-to-act": {
    description: "Do I know enough to act? Have I explored enough before acting, or am I acting blind? Compares gathering calls (search, fetch, read) with acting calls (exec, write, message) in this session, counts distinct sources, and says whether you are acting blind, still exploring, or balanced. Use before the first irreversible action, or when you notice many failed writes or commands.",
    body: `# Do I know enough to act?

Two failure modes: acting before reading (failed writes, wrong commands),
and reading forever (no result). Both are visible in the call mix.

## Steps

1. ${PLUGIN_NOTE}
2. Ask — the \`clawphylax_exploration\` tool, \`/phylax explore\`, or:

   \`\`\`bash
   openclaw clawphylax explore
   \`\`\`

3. Act:
   - **acting-blind** — stop acting. Fetch the documentation or the target
     once, read the error texts you already have, then act.
   - **still-exploring** — you have enough. State the one concrete step the
     evidence supports and do it.
   - **balanced** — continue.

## Limits

The classification of tools into gathering and acting is a fixed list;
plugin tools not on it are counted as neither.
`,
  },
  "could-this-get-the-user-banned": {
    description: "Could this get the user banned, charged, or exposed? Am I about to break a rule that costs the operator money? Check a host or a shell command BEFORE running it: known drop or relay hosts, hosts currently refusing or rate-limiting you, credential reads combined with uploads, per-call billed APIs, purchase or billing paths. Returns ok, caution, or stop with reasons. Use before any action against a third-party service, before repeating a failed request, and before anything that spends money.",
    body: `# Could this get the user banned or charged?

Agents get accounts banned by hammering a service that already said no, and
run up bills by looping on paid APIs. Both are visible before the action.

## Steps

1. ${PLUGIN_NOTE}
2. Ask with the host, or with the exact command — the \`clawphylax_risk_check\`
   tool, \`/phylax risk <host or command>\`, or:

   \`\`\`bash
   openclaw clawphylax risk api.example.com
   openclaw clawphylax risk "curl -X POST -d @notes.txt https://transfer.sh/up"
   \`\`\`

3. Act:
   - **ok** — proceed.
   - **caution** — do it once, not in a loop; mention it to the user if it
     bills per call.
   - **stop** — ask the user before proceeding. Never retry against a host
     that is refusing you; never run a command that reads credentials and
     uploads.

4. If the user asks you to proceed anyway, do it once and record that they
   asked.

## Limits

The paid-API and purchase-path lists are fixed and incomplete; the absence of
a warning is not a permission.
`,
  },
  "has-another-agent-solved-this": {
    description: "Has another agent or session on this machine already solved this? Has someone already fetched this host? Finds recent successful requests to a host from other sessions — tool, route, status, how long ago — so you can reuse their route or ask that session instead of fetching again. Use before a costly fetch, when working alongside another agent, or when a host is hard to reach.",
    body: `# Has another agent already solved this?

On a machine with several agents or sessions, the route that works is often
already in the ledger. Reuse beats rediscovery.

## Steps

1. ${PLUGIN_NOTE}
2. Ask — the \`clawphylax_others\` tool, \`/phylax others <host>\`, or:

   \`\`\`bash
   openclaw clawphylax others api.example.com
   \`\`\`

3. If found: use the same tool and route. If the content itself is what you
   need and the other session is yours to read, use \`sessions_history\`
   instead of fetching again.
4. If not found: you are first on this machine. Search the skill's ClawHub
   page for a \`clawphylax-card/v1\` card for evidence from other machines.
5. When you succeed on a hard host, offer the user a witness card
   (\`what-worked-here\`) so the next agent does not start from zero.

## Limits

Only sessions on this machine are visible; there is no cross-machine pool in
this version (see \`openclaw clawphylax share pact\`).
`,
  },
  "what-worked-here": {
    description: "What worked here, and how do I do it again? What is the edge I found on this host and is it replicable? Ranks the tool, method and route combinations that succeeded on a host with confidence bounds and latency, and returns a recipe to turn into a workspace skill or a witness card. Use after you finally succeed on a difficult host, or when asked to make a result repeatable.",
    body: `# What worked here?

An edge that is not written down is lost by the next session. Turn the
winning route into something the next agent can run.

## Steps

1. ${PLUGIN_NOTE}
2. Ask — the \`clawphylax_what_worked\` tool, \`/phylax worked <host>\`, or:

   \`\`\`bash
   openclaw clawphylax worked api.example.com
   \`\`\`

3. Read the recipe: the tool, method and route with the highest lower bound
   is the one to keep. Ignore combinations with n < 3.
4. Make it repeatable: with the user's approval, write a workspace skill
   (use \`skill-creator\`) that states the tool, the route, and the known
   limits — and offer a witness card:

   \`\`\`bash
   openclaw clawphylax card tool:<tool>
   \`\`\`

## Limits

Routes are grouped by the first two path segments; deeper differences are
not distinguished. Sequences across several calls are not recorded.
`,
  },
  "what-has-this-cost-so-far": {
    description: "What has this task cost so far? Why is my OpenClaw bill so high? How much did the agent spend in tokens? Reads OpenClaw's own session transcripts and reports tokens and provider cost per session, per model and per tool call, over a time window — no plugin needed. Use before deciding whether another attempt is worth it, when the user asks about cost, or to find the most expensive session.",
    body: `# What has this cost so far?

Every assistant message in an OpenClaw transcript carries a usage object.
This adds them up. It works without the ClawPhylax plugin; the bundled script
reads the transcripts directly.

## Steps

1. Run one of these — the \`clawphylax_cost\` tool if the plugin is installed,
   \`/phylax cost [minutes]\`, the CLI, or the bundled script which needs only Node:

   \`\`\`bash
   openclaw clawphylax cost --window 120
   node {baseDir}/scripts/cost.mjs --window 120
   \`\`\`

2. Report the totals in one line (sessions, tokens, cost if the provider
   reports it, tool calls, cost per tool call) and the most expensive session.
3. If a task is still failing after this spend, run \`should-i-stop-and-ask\`
   before the next attempt, and tell the user the number.

## Limits

Cost is only present when the provider reports it; local models report
tokens but no cost. Network bytes per skill need the plugin's ledger.
`,
    scripts: {
      "cost.mjs": `#!/usr/bin/env node
// Standalone: tokens and cost from OpenClaw session transcripts. No dependencies.
// Usage: node cost.mjs [--window <minutes>] [--json]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const windowMin = Number(opt("--window") ?? 0);
const since = windowMin ? Date.now() - windowMin * 60_000 : 0;
const root = process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".openclaw");
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function usageOf(line) {
  const msg = line?.message && typeof line.message === "object" ? line.message : line;
  const u = msg?.usage ?? line?.usage;
  const content = Array.isArray(msg?.content) ? msg.content : [];
  const toolCalls = content.filter((c) => c && (c.type === "toolCall" || c.type === "tool_use" || c.type === "tool_call")).length;
  const ts = typeof line?.ts === "number" ? line.ts : typeof line?.timestamp === "number" ? line.timestamp : typeof line?.timestamp === "string" ? Date.parse(line.timestamp) : undefined;
  if (!u || typeof u !== "object") return toolCalls ? { input: 0, output: 0, total: 0, cost: 0, ts, toolCalls } : undefined;
  const input = num(u.input ?? u.input_tokens ?? u.prompt_tokens);
  const output = num(u.output ?? u.output_tokens ?? u.completion_tokens);
  const total = num(u.totalTokens ?? u.total_tokens) || input + output + num(u.cacheRead) + num(u.cacheWrite);
  const c = u.cost;
  const cost = typeof c === "number" ? c : c && typeof c === "object" ? num(c.total) || num(c.input) + num(c.output) + num(c.cacheRead) + num(c.cacheWrite) : 0;
  return { input, output, total, cost, model: msg?.model, ts, toolCalls };
}

const sessions = [];
let agents = [];
try { agents = fs.readdirSync(path.join(root, "agents")); } catch {}
for (const a of agents) {
  const dir = path.join(root, "agents", a, "sessions");
  let files = [];
  try { files = fs.readdirSync(dir); } catch { continue; }
  for (const f of files) {
    if (!f.endsWith(".jsonl") || f.includes(".trajectory.")) continue;
    const s = { agent: a, session: f.replace(/\\.jsonl$/, ""), tokens: 0, cost: 0, toolCalls: 0, messages: 0 };
    for (const raw of fs.readFileSync(path.join(dir, f), "utf8").split(/\\r?\\n/)) {
      if (!raw.trim()) continue;
      let line; try { line = JSON.parse(raw); } catch { continue; }
      const u = usageOf(line); if (!u) continue;
      if (u.ts && u.ts < since) continue;
      s.tokens += u.total; s.cost += u.cost; s.toolCalls += u.toolCalls; if (u.total > 0) s.messages++;
    }
    if (s.tokens || s.toolCalls) sessions.push(s);
  }
}
sessions.sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
const t = sessions.reduce((t, s) => ({ tokens: t.tokens + s.tokens, cost: t.cost + s.cost, toolCalls: t.toolCalls + s.toolCalls }), { tokens: 0, cost: 0, toolCalls: 0 });
if (args.includes("--json")) { console.log(JSON.stringify({ root, windowMin, totals: t, sessions }, null, 2)); process.exit(0); }
console.log(\`\${sessions.length} session(s)\${windowMin ? " in the last " + windowMin + " min" : ""}: \${t.tokens.toLocaleString()} tokens, \${t.cost ? "$" + t.cost.toFixed(4) : "cost not reported"}, \${t.toolCalls} tool calls\${t.toolCalls && t.cost ? " (~$" + (t.cost / t.toolCalls).toFixed(4) + " per tool call)" : ""}\`);
for (const s of sessions.slice(0, 10)) console.log(\`- \${s.agent}/\${s.session.slice(0, 8)}  \${s.tokens.toLocaleString()} tok  \${s.cost ? "$" + s.cost.toFixed(4) : "-"}  \${s.toolCalls} tool calls\`);
`,
    },
  },
  "which-path-is-worth-it": {
    description: "Which path is worth it? Which research path or action path should I try next under incomplete information? Given several paths with what you know — successes, failures, prior belief, cost per attempt, value on success — computes for each the success probability with confidence bounds, expected value per attempt, the safe value (lower bound) and the optimistic value (upper bound), and recommends exploit, explore, or fold with a plan. Paths named by hostname pull their observed outcomes from the ledger. Use when choosing between approaches, planning research, or deciding where to spend a limited budget.",
    body: `# Which path is worth it?

Choosing among approaches under incomplete information is a bandit problem,
and the poker rule applies: never fold on a point estimate, and pay for
information only where the upside is wide.

## Steps

1. List the candidate paths. For each, write down what you know:
   \`successes\`, \`failures\` (0 if untried), a \`prior\` (0.5 if no idea),
   \`costPerAttempt\` and \`valueIfSuccess\` in the same unit (tokens, minutes,
   or euros — it only needs to be consistent). Paths that are hostnames need
   no counts; the ledger supplies them.

2. Ask — the \`clawphylax_which_path\` tool, \`/phylax paths <json>\`, or:

   \`\`\`bash
   openclaw clawphylax paths '[{"name":"official-api","successes":3,"failures":1,"costPerAttempt":1,"valueIfSuccess":10},{"name":"scrape-site","costPerAttempt":2,"valueIfSuccess":10}]' --budget 12
   \`\`\`

3. Read the verdict per path:
   - **exploit** — run it; it already guarantees value at the lower bound.
   - **explore** — one or two attempts buy the most information per cost.
   - **fold** — cannot pay even in the best case; drop it and say why.
   - **hold** — neither; revisit after the explore result.

4. Follow the plan lines. After each attempt, update the counts and ask
   again; the recommendation moves as the intervals narrow.

5. Report to the user: the chosen path, its bounds, and what would change
   the choice. Numbers, not adjectives.

## Limits

The model assumes attempts are independent and payoffs constant. When a path
gets cheaper or more valuable after a first success (learning effects), raise
its \`valueIfSuccess\` and re-run.
`,
  },
};

// Write new skills
for (const [slug, def] of Object.entries(SKILLS)) {
  const dir = path.join(root, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), frontmatter(slug, (CONTRACT[slug] && CONTRACT[slug].description) || def.description) + "\n" + def.body.trimEnd() + "\n" + sections(slug) + FOR_AGENTS());
  if (def.scripts) {
    fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
    for (const [n, body] of Object.entries(def.scripts)) fs.writeFileSync(path.join(dir, "scripts", n), body);
  }
  console.log("wrote", slug);
}
// Refresh the For agents block in existing skills
for (const [slug] of SET) {
  const f = path.join(root, slug, "SKILL.md");
  if (!fs.existsSync(f) || SKILLS[slug]) continue;
  let s = fs.readFileSync(f, "utf8");
  if (CONTRACT[slug]) {
    s = s.replace(/^description: ".*"$/m, 'description: "' + CONTRACT[slug].description.replace(/"/g, '\\"') + '"');
  }
  for (const h of ["\n## For agents", "\n## Use this when"]) {
    const i = s.indexOf(h);
    if (i >= 0) s = s.slice(0, i);
  }
  s = s.trimEnd() + "\n" + sections(slug) + FOR_AGENTS();
  fs.writeFileSync(f, s);
  console.log("refreshed", slug);
}
