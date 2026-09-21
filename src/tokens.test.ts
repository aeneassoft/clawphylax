import { describe, expect, it } from "vitest";
import { analyseTranscriptText } from "./tokens.js";

function turn(role: string, content: any[], output = 100) {
  return JSON.stringify({ ts: Date.now(), message: { role, content, usage: { input: 1000, output, totalTokens: 1000 + output } } });
}
const text = (t: string) => ({ type: "text", text: t });
const call = (name: string, args: any) => ({ type: "toolCall", id: "c", name, arguments: args });

describe("token use", () => {
  it("recognises execution", () => {
    const lines = [
      turn("assistant", [call("read", { path: "a.ts" })]),
      turn("assistant", [call("edit", { path: "a.ts" })]),
      turn("assistant", [call("exec", { command: "npm test" })]),
      turn("assistant", [text("done")]),
      turn("assistant", [call("write", { path: "b.ts" })]),
    ];
    const t = analyseTranscriptText(lines.join("\n"));
    expect(t.verdict).toBe("executing");
    expect(t.byClass.act.turns).toBe(3);
  });

  it("calls out deliberation: long text-only runs", () => {
    const lines = [
      turn("assistant", [call("read", { path: "a.ts" })], 50),
      turn("assistant", [text("Let me reconsider the whole approach...")], 900),
      turn("assistant", [text("On the other hand...")], 900),
      turn("assistant", [text("Actually, maybe not.")], 900),
      turn("assistant", [call("exec", { command: "ls" })], 50),
    ];
    const t = analyseTranscriptText(lines.join("\n"));
    expect(t.verdict).toBe("deliberating");
    expect(t.longestDeliberationStreak).toBe(3);
    expect(t.say).toMatch(/arguing with yourself/);
  });

  it("calls out churn: the same call again and again", () => {
    const lines = [
      turn("assistant", [call("exec", { command: "npm test" })]),
      turn("assistant", [call("exec", { command: "npm test" })]),
      turn("assistant", [call("exec", { command: "npm test" })]),
      turn("assistant", [call("exec", { command: "npm test" })]),
      turn("assistant", [call("read", { path: "x" })]),
    ];
    const t = analyseTranscriptText(lines.join("\n"));
    expect(t.verdict).toBe("churning");
    expect(t.repeatedCalls[0].times).toBe(4);
  });

  it("falls back to turn counts when no usage is reported", () => {
    const lines = [
      JSON.stringify({ message: { role: "assistant", content: [text("a")] } }),
      JSON.stringify({ message: { role: "assistant", content: [text("b")] } }),
      JSON.stringify({ message: { role: "assistant", content: [text("c")] } }),
      JSON.stringify({ message: { role: "assistant", content: [call("exec", { command: "x" })] } }),
    ];
    const t = analyseTranscriptText(lines.join("\n"));
    expect(t.outputTokens).toBe(0);
    expect(t.byClass.deliberate.share).toBeCloseTo(0.75);
  });
});
