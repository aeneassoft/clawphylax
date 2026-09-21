import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { costReport, parseTranscript, usageOf } from "./cost.js";

function tmpState(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phylax-state-"));
  const dir = path.join(root, "agents", "main", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    { ts: Date.now() - 60_000, message: { role: "user", content: [{ type: "text", text: "hi" }] } },
    { ts: Date.now() - 50_000, message: { role: "assistant", model: "mock/m", content: [{ type: "toolCall", id: "c1", name: "exec" }], usage: { input: 1200, output: 80, cacheRead: 0, cacheWrite: 0, totalTokens: 1280, cost: { input: 0.0036, output: 0.0012, total: 0.0048 } } } },
    { ts: Date.now() - 40_000, message: { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "ok" }] } },
    { ts: Date.now() - 30_000, message: { role: "assistant", model: "mock/m", content: [{ type: "text", text: "done" }], usage: { input: 1400, output: 40, totalTokens: 1440, cost: { input: 0.0042, output: 0.0006 } } } },
  ];
  fs.writeFileSync(path.join(dir, "abc.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "abc.trajectory.jsonl"), "{}\n");
  return root;
}

describe("cost", () => {
  it("reads usage from a transcript", () => {
    const root = tmpState();
    const s = parseTranscript(path.join(root, "agents", "main", "sessions", "abc.jsonl"))!;
    expect(s.totalTokens).toBe(2720);
    expect(s.cost).toBeCloseTo(0.0096, 6);
    expect(s.toolCalls).toBe(1);
    expect(s.models["mock/m"]).toBe(2720);
  });

  it("reports totals and per-tool-call cost, ignoring trajectory files", () => {
    const root = tmpState();
    const r = costReport({ root });
    expect(r.totals.sessions).toBe(1);
    expect(r.perToolCall).toBeCloseTo(0.0096, 6);
    expect(r.say).toMatch(/1 session/);
  });

  it("tolerates unknown shapes", () => {
    expect(usageOf({ foo: 1 })).toBeUndefined();
    expect(usageOf({ usage: { prompt_tokens: 10, completion_tokens: 5 } })!.total).toBe(15);
  });
});
