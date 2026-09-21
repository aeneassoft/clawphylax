// Rewrites every skill description after the OpenAI consultation (trigger first,
// tool names + status codes, exact action contract, negative routing), adds the
// "Use this when / Do not use when / Output" sections and the provenance
// sentence, and adds the did-that-actually-work skill.
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const rd = (f) => fs.readFileSync(path.join(root, f), "utf8");
const wr = (f, s) => fs.writeFileSync(path.join(root, f), s);
function must(s, from, to, label) {
  if (!s.includes(from)) throw new Error("anchor not found: " + label);
  return s.replace(from, to);
}

// slug → { description, useWhen, doNot, output }
const D = {
  "clawphylax-verify": {
    description: "Is this skill safe? Use this before installing any third-party ClawHub skill or running its scripts, and whenever the user asks whether a skill is safe. Inspects every file in the skill folder — SKILL.md and scripts — and reports every network host contacted, whether data or files are uploaded (curl -d/-T, requests.post, scp), and whether credential paths such as ~/.ssh, .env or ~/.aws are read. Returns exactly CLEAN, REVIEW or SUSPICIOUS with file and line; do not recommend installation on SUSPICIOUS. Do not use to judge a running skill's behavior — use skill-network-audit for that.",
    useWhen: "Before `openclaw skills install <slug>` of any third-party skill; when the user asks \"is this skill safe?\"; when a skill's scripts are about to run for the first time.",
    doNot: "For what an already-installed skill actually did at runtime (use `skill-network-audit`). For deciding whether a remote service is trustworthy — a file scan cannot see what a server does after contact.",
    output: "First line `ACTION: INSTALL_OK` / `ACTION: REVIEW_WITH_USER` / `ACTION: DO_NOT_INSTALL`, then the hosts by name, then each finding as file:line. On SUSPICIOUS, tell the user the finding; do not soften it.",
  },
  "skill-network-audit": {
    description: "Where does this skill send data? What hosts did it contact? Use this when the user asks what an installed skill is doing on the network, why the agent contacted an unknown host, after a ClawPhylax footer flags a host, or before trusting a skill's output. Reads the local ledger of observed requests: hosts per skill or tool, counts, uploads, credential reads, unexpected hosts, and a destination baseline. Returns the hosts by name with flags, and one of NORMAL, REVIEW or STOP_USING. Do not use before installation — use clawphylax-verify for that.",
    useWhen: "\"What is skill X doing on the network?\", \"why did my agent contact host Y?\", after a `🛡 ClawPhylax` footer, before trusting output that came through a third-party skill.",
    doNot: "Before installation (use `clawphylax-verify`). For a single request's failure (use `why-did-my-request-fail`).",
    output: "First line `ACTION: NORMAL` / `ACTION: REVIEW` / `ACTION: STOP_USING`, then hosts by name with counts and flags (`upload`, `sensitive-read`, `unexpected-host`, `suspicious`), then the baseline state (`learning` / `stable` / `volatile`). No events = \"not observed yet\", never \"safe\".",
  },
  "why-did-my-request-fail": {
    description: "Why did my request fail? Should I retry, wait, or switch tools? Use this before retrying a failed web_fetch, API call, browser request or network exec — especially after a timeout, 401, 403, 429 or 5xx, or after two unsuccessful attempts. Diagnoses the host from this machine's observed requests: refusal/blocking, rate limiting, outage, unreachable, or a malformed request. Returns exactly RETRY_AFTER_FIXING_REQUEST, BACKOFF, SWITCH_TOOL, STOP or TRY_ONCE, with evidence, success probability and bounds, back-off seconds, and the tool most likely to work on this host. Do not use for a first failure with no repetition and a clear input error (400 with a message) — fix the input.",
    useWhen: "Before any retry of a failed request; after 401/403/429/5xx or a timeout; when the same host has failed twice; when asked \"is this site blocking agents?\".",
    doNot: "A first 400 with a clear validation message: fix the input. A failure inside your own code, not on the wire.",
    output: "First line `ACTION: …` (one of RETRY_AFTER_FIXING_REQUEST / BACKOFF / SWITCH_TOOL / STOP / TRY_ONCE), then EVIDENCE (n, statuses), DO NOT (the prohibited retry), NEXT (with seconds to wait or the tool to use), CONFIDENCE (bounds), SCOPE (this host, this machine, current credentials).",
  },
  "why-do-i-keep-failing": {
    description: "Why do I keep failing? What is the pattern behind my errors? Use this when errors pile up — three or more failed tool calls (exec, write, web_fetch, API) in a session — before retrying anything. Clusters this session's failed tool calls and failed requests by tool, host and error signature, names the single cause behind most of them with its share, and returns a compact trail of the last failures to reason about. Returns FIX_DOMINANT_CAUSE, HOLD_APPROACH_VARY_ONE_INPUT or NO_TOOL_FAILURES. Do not use for a single failure — use why-did-my-request-fail for a failing host.",
    useWhen: "Three or more failures in a session; the same error keeps returning; before yet another retry.",
    doNot: "A single failure (use `why-did-my-request-fail` if it was a request). Failures the user already explained.",
    output: "First line `ACTION: FIX_DOMINANT_CAUSE` (with the cause and its share) / `ACTION: HOLD_APPROACH_VARY_ONE_INPUT` / `ACTION: NO_TOOL_FAILURES`, then the clusters (tool, host, signature, count), then the trail (time, tool, hint, error). Report one cause to the user, not every error.",
  },
  "should-i-stop-and-ask": {
    description: "Should I stop and ask the user? Is this task possible with what I have? Use this when a task is failing repeatedly, the same approach has been tried twice, no new evidence is appearing, a host is refusing you, or you are about to ask a vague \"should I keep trying?\". Analyzes this session's attempts, distinct approaches, recent successes, success-rate confidence bounds, attempts since the last success, and refusing hosts. Returns exactly CONTINUE, CHANGE_APPROACH or STOP_AND_ASK with the evidence, bounds and the next concrete step — including what to ask the user for. Do not use before the second failure.",
    useWhen: "Repeated failure; two attempts with the same approach; no new evidence for several calls; a refusing host; before asking the user anything vague.",
    doNot: "After a single failure. When the user already set a hard budget or deadline — then follow that.",
    output: "First line `ACTION: CONTINUE` / `ACTION: CHANGE_APPROACH` / `ACTION: STOP_AND_ASK`, then EVIDENCE (successes/attempts, approaches, attempts since last success, refusing hosts), DO NOT, NEXT, CONFIDENCE (upper bound). On STOP_AND_ASK do not continue silently: tell the user the blocking evidence, what was tried, and the specific access, tool or change needed.",
  },
  "am-i-going-in-circles": {
    description: "Am I going in circles? Am I repeating myself? Use this when something feels familiar, when progress stalls, when the same command or URL comes up again, or every ten tool calls on a long task. Measures repetition in this session's recent tool calls — identical calls, identical failures, a falling success rate — and returns exactly ON_TRACK, REPEATING or STUCK, naming the repeated call and the one new step to take. Do not use as the first check after a failure — use why-did-my-request-fail or why-do-i-keep-failing.",
    useWhen: "\"I have done this before\"; no progress for several calls; the same exec/URL again; periodically on long tasks.",
    doNot: "As the first response to a single failure.",
    output: "First line `ACTION: ON_TRACK` / `ACTION: REPEATING` / `ACTION: STUCK`, then EVIDENCE (distinct actions in last n, most-repeated call ×k, success trend), DO NOT (re-run the identical call), NEXT (one new step, or write down what is established).",
  },
  "do-i-know-enough-to-act": {
    description: "Do I know enough to act? Am I acting blind, or exploring forever? Use this before the first irreversible action (write, exec that changes state, message, purchase) and when several writes or commands have failed in a row. Compares gathering calls (web_search, web_fetch, read, memory) with acting calls (exec, write, edit, message) in this session and counts distinct sources. Returns exactly ACT_NOW, GATHER_FIRST or BALANCED with the one call to make next. Do not use for pure research tasks with no action planned.",
    useWhen: "Before the first irreversible action; after two failed writes or commands; when a task has produced many reads and no result.",
    doNot: "Pure research with no action planned; trivial single-step tasks.",
    output: "First line `ACTION: ACT_NOW` / `ACTION: GATHER_FIRST` / `ACTION: BALANCED`, then EVIDENCE (gather vs act counts, distinct sources, failures after first act), NEXT (the single call).",
  },
  "could-this-get-the-user-banned": {
    description: "Could this get the user banned, charged, or exposed? Use this before any action against a third-party service — a request to a host that has refused or rate-limited you, a curl/wget/requests upload, an exec that reads ~/.ssh, .env or ~/.aws, a call to a per-request billed API (OpenAI, Anthropic, Twilio, SendGrid, Stripe, AWS), or a POST to a checkout, order, billing or subscribe path. Returns exactly OK, CAUTION or STOP with reasons; on STOP, ask the user before proceeding. Do not use for local file reads or GET requests to hosts that have been answering normally.",
    useWhen: "Before retrying a host that returned 401/403/429; before uploads; before commands touching credential files; before billed APIs; before purchase/billing/subscription actions; before anything the user would have to pay for or could be banned for.",
    doNot: "Local reads; GETs to a host that is answering normally; actions the user explicitly and specifically authorized in this conversation.",
    output: "First line `ACTION: OK` / `ACTION: CAUTION` / `ACTION: STOP`, then the reasons (host state, pattern, billing, purchase path), DO NOT (the specific prohibited action), NEXT (proceed once / ask the user for X).",
  },
  "has-another-agent-solved-this": {
    description: "Has another agent or session on this machine already solved this? Has this host already been reached? Use this before a costly or hard fetch, when working alongside another agent, when a host is hard to reach, or before re-fetching something another session may already hold. Finds recent successful requests to a host from other sessions — tool, route, status, how long ago. Returns exactly REUSE_ROUTE, ASK_THAT_SESSION or YOU_ARE_FIRST. Do not use for hosts you have already reached yourself in this session.",
    useWhen: "Before a costly fetch; when a host is hard; when another agent is active on this machine; before re-fetching large content.",
    doNot: "Hosts you already reached in this session; single-agent machines with an empty ledger.",
    output: "First line `ACTION: REUSE_ROUTE` (tool + route) / `ACTION: ASK_THAT_SESSION` / `ACTION: YOU_ARE_FIRST`, then the matches (session, tool, method, path, status, age).",
  },
  "what-worked-here": {
    description: "What worked here, and how do I do it again? Which tool and route succeeded on this host, and is it repeatable? Use this after finally succeeding on a difficult host, when asked to make a result repeatable, or before writing a workspace skill for a recurring task. Ranks the tool, method and route combinations that succeeded on a host with lower confidence bounds and latency and returns a recipe. Returns exactly WRITE_SKILL, POST_WITNESS_CARD or NOTHING_PROVEN_YET. Do not use on hosts with fewer than three observed requests.",
    useWhen: "After a hard-won success; when asked to make something repeatable; before creating a workspace skill; when a card for other agents would help.",
    doNot: "Hosts with fewer than three observations; one-off tasks nobody will repeat.",
    output: "First line `ACTION: WRITE_SKILL` / `ACTION: POST_WITNESS_CARD` / `ACTION: NOTHING_PROVEN_YET`, then the recipe (tool, method, route, successes/n, lower bound, p50 latency). Ask the user before writing a skill or posting a card.",
  },
  "what-has-this-cost-so-far": {
    description: "What has this task cost so far? Why is my OpenClaw bill so high? How many tokens has the agent used? Use this before deciding whether another attempt is worth it, when the user asks about cost or tokens, when a task has run for a long time, or to find the most expensive session. Reads OpenClaw's own session transcripts and reports tokens and provider cost per session, per model and per tool call — no plugin ledger needed. Returns the totals and WORTH_ANOTHER_ATTEMPT or ASK_BEFORE_SPENDING_MORE. Do not use for per-request network bytes — that needs the ledger.",
    useWhen: "Before another expensive attempt; when the user asks about cost or tokens; after a long task; to find the most expensive session.",
    doNot: "Network bytes per host or skill (use `skill-network-audit`). Providers that report no usage will show tokens only.",
    output: "First line `ACTION: WORTH_ANOTHER_ATTEMPT` / `ACTION: ASK_BEFORE_SPENDING_MORE`, then totals (sessions, tokens, cost, tool calls, cost per tool call) and the most expensive session. Give the user the number.",
  },
  "which-path-is-worth-it": {
    description: "Which path is worth it? Which research or action path should I try next under incomplete information? Use this when choosing between two or more approaches, planning research, deciding where to spend a limited budget, or when the user asks which option to pursue. Given each path's successes, failures, prior, cost per attempt and value on success, computes success probability with bounds, expected value, safe value (lower bound) and optimistic value (upper bound). Returns exactly EXPLOIT, EXPLORE or FOLD per path with a plan; hostnames pull their outcomes from the ledger. Do not use with a single option — then use should-i-stop-and-ask.",
    useWhen: "Two or more candidate approaches; research planning; budget allocation; \"which option should I pursue?\".",
    doNot: "A single option (use `should-i-stop-and-ask`). Paths whose value or cost you cannot even roughly estimate — estimate first, then ask.",
    output: "First line `ACTION: EXPLOIT <path>` / `ACTION: EXPLORE <path>` / `ACTION: ALL_FOLD`, then per path: P with bounds, n, EV per attempt, safe and optimistic value, its verdict; then the plan lines. Re-run after each attempt with updated counts.",
  },
  "am-i-using-too-many-tokens": {
    description: "Am I using too many tokens? Am I spending tokens to refute myself instead of executing? Am I overthinking? Use this every ten turns on a long task, when a good first idea seems to be drifting, when several text-only turns have passed without a tool call, or when the user asks why this is taking so long. Classifies this session's assistant turns from the transcript into act, gather, repeat and deliberate, attributes output tokens, finds deliberation streaks and repeated identical calls. Returns exactly EXECUTING, RETURN_TO_PLAN or STOP_REPEATING with the next call. No plugin ledger needed. Do not use in the first three turns.",
    useWhen: "Every ten turns on long tasks; after several text-only turns; when the plan is drifting; when asked why this takes so long.",
    doNot: "The first three turns; tasks that are legitimately analysis-only and the user asked for analysis.",
    output: "First line `ACTION: EXECUTING` / `ACTION: RETURN_TO_PLAN` / `ACTION: STOP_REPEATING`, then the shares (act / gather / repeat / deliberate), the longest deliberation streak, the repeated calls, NEXT (the first step of the plan you had, or the settled result to build on).",
  },
  "did-that-actually-work": {
    description: "Did that actually work? Did my last action take effect, or did it only look like it did? Use this after any tool call whose effect matters — an exec, a write, a POST or PUT, a message send, a fetch you will build on — and before reporting success to the user. Cross-checks what the tool reported (ok/error) against what the wire showed for that same tool call: status codes (403, 5xx), empty 200 bodies, unsent uploads, no observable request at all. Returns exactly CONFIRMED, SILENT_FAILURE, UNVERIFIED or FAILED with the mismatch named. Do not use for reads you will not act on.",
    useWhen: "After exec, write, POST/PUT/DELETE, message or any fetch you will build on; before telling the user \"done\"; when a result looks too easy.",
    doNot: "Reads you will not act on; diagnostic calls; when the tool itself already returned an error (then fix that).",
    output: "First line `ACTION: BUILD_ON_IT` / `ACTION: TREAT_AS_NOT_DONE` / `ACTION: VERIFY_DIRECTLY` / `ACTION: FIX_THEN_RETRY`, then EVIDENCE (what the tool reported, what the wire showed), DO NOT (proceed as if it succeeded), NEXT, SCOPE. Never claim success to the user unless the verdict is CONFIRMED or you verified the effect directly.",
    body: `# Did that actually work?

A tool's return value is what the tool claims. What happened on the wire is a
different fact: the POST answered 403, the 200 had no body, the upload never
left. Agents build on the claim. This checks the fact.

## Procedure

1. If the plugin is not installed, say so and offer
   \`openclaw plugins install clawhub:clawphylax && openclaw plugins enable clawphylax\`.
2. Right after the action, call the \`clawphylax_did_it_work\` tool (defaults to
   the last non-diagnostic tool call), or \`/phylax check\`, or:

   \`\`\`bash
   openclaw clawphylax check
   \`\`\`

3. Act on the verdict:
   - **CONFIRMED** — the wire agrees with the tool. Build on it.
   - **SILENT_FAILURE** — the tool said ok, the wire said no. Treat the action as
     not done. Run \`why-did-my-request-fail\` for the host before retrying.
   - **UNVERIFIED** — no observable request (child process, local file). If the
     effect matters, verify it directly: fetch the resource, list the file,
     read the reply.
   - **FAILED** — the tool itself failed. Fix, then retry once.

## Rules

- Never report "done" to the user on UNVERIFIED or SILENT_FAILURE.
- One check per action that matters; do not check reads you will not act on.
`,
  },
};

// ---- gen-skills.cjs: update SET, descriptions, add sections + provenance
let g = rd("scripts/gen-skills.cjs");
g = must(g, `  ["am-i-using-too-many-tokens", "Am I using too many tokens?", "act / gather / repeat / deliberate — executing or arguing with yourself"],
];`, `  ["am-i-using-too-many-tokens", "Am I using too many tokens?", "act / gather / repeat / deliberate — executing or arguing with yourself"],
  ["did-that-actually-work", "Did that actually work?", "the tool's report cross-checked against the wire"],
];

const CONTRACT = ${JSON.stringify(Object.fromEntries(Object.entries(D).map(([k, v]) => [k, { description: v.description, useWhen: v.useWhen, doNot: v.doNot, output: v.output }])), null, 2)};`, "set + contract");

g = must(g, `All of them read the local ledger kept by the \\\`clawphylax\\\` plugin, except
\\\`clawphylax-verify\\\` (reads files) and \\\`what-has-this-cost-so-far\\\` (reads
OpenClaw's own transcripts), which work without it.`, `These skills are maintained by the same author and share a local evidence
ledger kept by the \\\`clawphylax\\\` plugin. Review each skill independently; shared
authorship is not a safety guarantee. \\\`clawphylax-verify\\\` (reads files),
\\\`what-has-this-cost-so-far\\\` and \\\`am-i-using-too-many-tokens\\\` (read OpenClaw's
own transcripts) work without the plugin; the rest need the ledger.`, "provenance");

// sections builder used for every skill
g = must(g, `function frontmatter(name, description) {`, `function sections(slug) {
  const c = CONTRACT[slug];
  if (!c) return "";
  return \`
## Use this when

\${c.useWhen}

## Do not use when

\${c.doNot}

## Output

\${c.output}
\`;
}

function frontmatter(name, description) {`, "sections fn");

// generated skills: use CONTRACT description when present, insert sections before For agents
g = must(g, `  fs.writeFileSync(path.join(dir, "SKILL.md"), frontmatter(slug, def.description) + "\\n" + def.body.trimEnd() + "\\n" + FOR_AGENTS());`,
  `  fs.writeFileSync(path.join(dir, "SKILL.md"), frontmatter(slug, (CONTRACT[slug] && CONTRACT[slug].description) || def.description) + "\\n" + def.body.trimEnd() + "\\n" + sections(slug) + FOR_AGENTS());`, "generated write");
// existing (handwritten) skills: replace description line + sections + For agents
g = must(g, `  let s = fs.readFileSync(f, "utf8");
  const i = s.indexOf("\\n## For agents");
  s = (i >= 0 ? s.slice(0, i) : s.trimEnd()) + "\\n" + FOR_AGENTS();`,
  `  let s = fs.readFileSync(f, "utf8");
  if (CONTRACT[slug]) {
    s = s.replace(/^description: ".*"$/m, 'description: "' + CONTRACT[slug].description.replace(/"/g, '\\\\"') + '"');
  }
  for (const h of ["\\n## For agents", "\\n## Use this when"]) {
    const i = s.indexOf(h);
    if (i >= 0) s = s.slice(0, i);
  }
  s = s.trimEnd() + "\\n" + sections(slug) + FOR_AGENTS();`, "existing rewrite");

// add did-that-actually-work definition into SKILLS
g = must(g, `const SKILLS = {`, `const SKILLS = {
  "did-that-actually-work": { description: ${JSON.stringify(D["did-that-actually-work"].description)}, body: ${JSON.stringify(D["did-that-actually-work"].body)} },`, "didit skill def");
wr("scripts/gen-skills.cjs", g);
console.log("gen-skills patched for 0.4.0");
