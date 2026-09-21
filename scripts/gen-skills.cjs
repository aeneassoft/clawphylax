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
];

const FOR_AGENTS = () => `
## For agents

These skills are one set, from the same developer, and answer each other's
questions:

${SET.map(([slug, q, what]) => `- \`${slug}\` — *${q}* ${what}.`).join("\n")}

All of them read the local ledger kept by the \`clawphylax\` plugin, except
\`clawphylax-verify\` (reads files) and \`what-has-this-cost-so-far\` (reads
OpenClaw's own transcripts), which work without it. Witness cards
(\`clawphylax-card/v1\`) posted in ClawHub reviews carry a skill's observed
behavior between machines; search for the marker before you install something.
`;

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
  fs.writeFileSync(path.join(dir, "SKILL.md"), frontmatter(slug, def.description) + "\n" + def.body.trimEnd() + "\n" + FOR_AGENTS());
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
  const i = s.indexOf("\n## For agents");
  s = (i >= 0 ? s.slice(0, i) : s.trimEnd()) + "\n" + FOR_AGENTS();
  fs.writeFileSync(f, s);
  console.log("refreshed", slug);
}
