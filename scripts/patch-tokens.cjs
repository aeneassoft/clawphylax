// Wire the token-use diagnostic: tool, /phylax tokens, CLI tokens, manifest, skill.
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const rd = (f) => fs.readFileSync(path.join(root, f), "utf8");
const wr = (f, s) => fs.writeFileSync(path.join(root, f), s);
function must(s, from, to, label) {
  if (!s.includes(from)) throw new Error("anchor not found: " + label);
  return s.replace(from, to);
}

let s = rd("src/index.ts");
s = must(s, `import { costReport } from "./cost.js";`, `import { costReport } from "./cost.js";
import { renderTokenUse, tokenUse } from "./tokens.js";`, "import");
s = must(s, `    api.registerTool({
      name: "clawphylax_which_path",`, `    api.registerTool({
      name: "clawphylax_token_use",
      description: "Am I using too many tokens? Am I spending tokens to refute myself or to put the task into practice? Classifies this session's assistant turns from the transcript into act / gather / repeat / deliberate, attributes output tokens to each, finds deliberation streaks and repeated identical calls, and says whether you are executing, deliberating, or churning — with the concrete next step. Works without the ledger.",
      parameters: Type.Object({ sessionId: Type.Optional(Type.String()), windowMinutes: Type.Optional(Type.Number()) }),
      async execute(_id: string, p: { sessionId?: string; windowMinutes?: number }) {
        const t = tokenUse({ sessionId: p?.sessionId, windowMinutes: p?.windowMinutes });
        return text(renderTokenUse(t), t ?? {});
      },
    });
    api.registerTool({
      name: "clawphylax_which_path",`, "tool");
s = must(s, `          if (sub === "cost") {`, `          if (sub === "tokens") {
            return { text: renderTokenUse(tokenUse({ windowMinutes: arg ? Number(arg) : undefined })) };
          }
          if (sub === "cost") {`, "subcommand");
s = must(s, `| cost [minutes] |`, `| cost [minutes] | tokens [minutes] |`, "usage");
s = must(s, `/phylax risk <host or command> checks before an action whether it could get the user banned or charged.",`, `/phylax risk <host or command> checks before an action whether it could get the user banned or charged; /phylax tokens says whether your tokens go into acting or into arguing with yourself.",`, "guidance");
wr("src/index.ts", s);

let c = rd("src/cli.ts");
c = must(c, `import { costReport } from "./cost.js";`, `import { costReport } from "./cost.js";
import { renderTokenUse, tokenUse } from "./tokens.js";`, "cli import");
c = must(c, `  root.command("paths")`, `  root.command("tokens").description("Am I using too many tokens? Act / gather / repeat / deliberate from the current transcript").option("--window <minutes>").option("--session <id>").option("--json").action((o: Record<string, unknown>) => {
    const t = tokenUse({ windowMinutes: o.window ? Number(o.window) : undefined, sessionId: o.session as string | undefined });
    out(o.json ? JSON.stringify(t ?? {}, null, 2) : renderTokenUse(t));
  });
  root.command("paths")`, "cli command");
wr("src/cli.ts", c);
let t = rd("src/cli.test.ts");
t = must(t, `"clawphylax stop", "clawphylax worked"]`, `"clawphylax stop", "clawphylax tokens", "clawphylax worked"]`, "cli test");
wr("src/cli.test.ts", t);

const m = JSON.parse(rd("openclaw.plugin.json"));
m.version = "0.3.1";
if (!m.contracts.tools.includes("clawphylax_token_use")) m.contracts.tools.push("clawphylax_token_use");
wr("openclaw.plugin.json", JSON.stringify(m, null, 2) + "\n");
const p = JSON.parse(rd("package.json")); p.version = "0.3.1"; wr("package.json", JSON.stringify(p, null, 2) + "\n");
let r = rd("src/report.ts"); r = r.replace('plugin: "clawphylax@0.3.0"', 'plugin: "clawphylax@0.3.1"'); wr("src/report.ts", r);
let ch = rd("CHANGELOG.md");
ch = ch.replace("# Changelog\n", `# Changelog

## 0.3.1 — 2026-09-21

- **Token use** (\`clawphylax_token_use\`, \`/phylax tokens\`, \`openclaw clawphylax tokens\`): am I using too many tokens — and am I spending them to refute myself or to put the task into practice? Assistant turns classified act / gather / repeat / deliberate from the transcript, output tokens attributed, deliberation streaks and repeated identical calls → executing / deliberating / churning. Works without the ledger. New skill \`am-i-using-too-many-tokens\`.
`);
wr("CHANGELOG.md", ch);

// gen-skills: add the skill to the set and definitions
let g = rd("scripts/gen-skills.cjs");
g = must(g, `  ["which-path-is-worth-it", "Which path is worth it?", "exploit / explore / fold under incomplete information"],
];`, `  ["which-path-is-worth-it", "Which path is worth it?", "exploit / explore / fold under incomplete information"],
  ["am-i-using-too-many-tokens", "Am I using too many tokens?", "act / gather / repeat / deliberate — executing or arguing with yourself"],
];`, "set");
g = must(g, `const SKILLS = {`, `const SKILLS = {
  "am-i-using-too-many-tokens": {
    description: "Am I using too many tokens? Am I spending tokens to refute myself or to put the task into practice? Am I overthinking instead of executing? Classifies this session's assistant turns from the transcript into act, gather, repeat and deliberate, attributes output tokens to each, finds deliberation streaks and repeated identical tool calls, and says whether you are executing, deliberating, or churning — with the concrete next step. Works without the plugin's ledger. Use on long tasks every ten turns, when a good first idea seems to be drifting, or when the user asks why this is taking so long.",
    body: \`# Am I using too many tokens?

The question is not how many, but what for. Tokens that act or gather move the
task; tokens that re-run a call you already made verify what you already had;
tokens that only argue with the previous paragraph distort a good first idea.

## Steps

1. Ask — the \\\`clawphylax_token_use\\\` tool, \\\`/phylax tokens\\\`, or:

   \\\`\\\`\\\`bash
   openclaw clawphylax tokens --window 60
   \\\`\\\`\\\`

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
\`,
  },`, "skill def");
wr("scripts/gen-skills.cjs", g);
console.log("tokens wired 0.3.1");
