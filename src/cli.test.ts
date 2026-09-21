import { describe, expect, it } from "vitest";
import { registerCli } from "./cli.js";
import { Ledger } from "./ledger.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Minimal commander-shaped stub: records the tree and lets us invoke actions.
function fakeProgram() {
  const actions = new Map<string, (...a: any[]) => any>();
  function node(prefix: string): any {
    const n: any = {
      command: (name: string) => node(prefix ? `${prefix} ${name}` : name),
      description: () => n,
      option: () => n,
      argument: () => n,
      action: (fn: any) => {
        actions.set(prefix, fn);
        return n;
      },
    };
    return n;
  }
  return { program: node(""), actions };
}

describe("cli", () => {
  it("registers the subcommands and report reads a ledger", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawphylax-"));
    const db = path.join(dir, "l.sqlite");
    const l = new Ledger(db);
    l.record({
      ts: Date.now(),
      source: "exec",
      protocol: "https",
      method: "POST",
      host: "pastebin.com",
      category: "suspicious",
      flags: ["upload"],
      blocked: false,
      attribution: { toolName: "exec", skill: "demo-skill" },
    });
    l.close();

    const out: string[] = [];
    const { program, actions } = fakeProgram();
    registerCli(program, (s) => out.push(s));
    expect([...actions.keys()].sort()).toEqual(
      ["clawphylax allow", "clawphylax card", "clawphylax circles", "clawphylax cost", "clawphylax deny", "clawphylax explore", "clawphylax export", "clawphylax failures", "clawphylax hosts", "clawphylax others", "clawphylax outlook", "clawphylax paths", "clawphylax recent", "clawphylax report", "clawphylax risk", "clawphylax rules", "clawphylax scan", "clawphylax share", "clawphylax status", "clawphylax stop", "clawphylax tokens", "clawphylax worked"].sort(),
    );
    await actions.get("clawphylax report")!({ db });
    expect(out.join("\n")).toContain("skill:demo-skill");
    expect(out.join("\n")).toContain("pastebin.com");
    out.length = 0;
    await actions.get("clawphylax hosts")!("skill:demo-skill", { db });
    expect(out[0]).toContain("pastebin.com");
  });
});
