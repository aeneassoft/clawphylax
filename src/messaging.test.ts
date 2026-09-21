import { describe, expect, it } from "vitest";
import { Ledger } from "./ledger.js";
import { asksOf, compactionBrief, didMessageGoOut, keywordsOf, reconcileText, sendCheck, taskMatch } from "./messaging.js";
import { findSecretShapes } from "./secrets.js";
import type { EgressEvent } from "./types.js";

const T0 = Date.now() - 120_000;
function ev(l: Ledger, ts: number, method: string, host: string, status: number | undefined, extra: Partial<EgressEvent> = {}) {
  const e: EgressEvent = { ts, source: "inproc", protocol: "https", method, host, path: "/", status, bytesIn: 100, category: "external", flags: [], blocked: false, attribution: { sessionKey: "s1" }, ...extra };
  l.record(e);
}

describe("secrets", () => {
  it("finds well-known key shapes and masks them", () => {
    const hits = findSecretShapes("here is my key sk-proj-abcdefghijklmnopqrstuvwxyz0123456789 and AKIAABCDEFGHIJKLMNOP");
    expect(hits.map((h) => h.kind)).toContain("openai-key");
    expect(hits.map((h) => h.kind)).toContain("aws-access-key");
    expect(hits.every((h) => !h.masked.includes("abcdefghij"))).toBe(true);
  });
  it("ignores ordinary prose", () => {
    expect(findSecretShapes("Meeting moved to 3pm tomorrow, see you there.")).toEqual([]);
  });
});

describe("sendCheck", () => {
  it("blocks a secret and flags a cross-conversation target", () => {
    const l = new Ledger(":memory:");
    l.recordInbound({ ts: T0, sessionKey: "s1", channelId: "telegram", conversationId: "12345", from: "u1", len: 20 });
    const a = sendCheck(l, { sessionKey: "s1", to: "12345", content: "token=abcdefgh12345678" });
    expect(a.verdict).toBe("DO_NOT_SEND");
    const b = sendCheck(l, { sessionKey: "s1", to: "99999", content: "hello there" });
    expect(b.verdict).toBe("CONFIRM_WITH_USER");
    expect(b.crossConversation).toBe(true);
    const c = sendCheck(l, { sessionKey: "s1", to: "12345", content: "hello there" });
    expect(c.verdict).toBe("SEND");
    l.close();
  });
});

describe("didMessageGoOut", () => {
  it("DELIVERED when runtime success and channel API 200 agree", () => {
    const l = new Ledger(":memory:");
    const id = l.recordOutbound({ ts: T0, sessionKey: "s1", channelId: "telegram", to: "12345", len: 10, cancelled: false });
    ev(l, T0 + 300, "POST", "api.telegram.org", 200);
    l.markSent({ ts: T0 + 500, sessionKey: "s1", to: "12345", success: true, messageId: "m1" });
    expect(didMessageGoOut(l, { sendId: id }).verdict).toBe("DELIVERED");
    l.close();
  });
  it("NOT_DELIVERED when the runtime says success but the wire answered 403", () => {
    const l = new Ledger(":memory:");
    const id = l.recordOutbound({ ts: T0, sessionKey: "s1", channelId: "discord", to: "chan", len: 10, cancelled: false });
    ev(l, T0 + 300, "POST", "discord.com", 403);
    l.markSent({ ts: T0 + 500, sessionKey: "s1", to: "chan", success: true });
    const r = didMessageGoOut(l, { sendId: id });
    expect(r.verdict).toBe("NOT_DELIVERED");
    expect(r.say).toMatch(/403/);
    l.close();
  });
  it("CLAIMED_ONLY when success is reported but no channel request was observed", () => {
    const l = new Ledger(":memory:");
    const id = l.recordOutbound({ ts: T0, sessionKey: "s1", channelId: "whatsapp", to: "+49", len: 10, cancelled: false });
    l.markSent({ ts: T0 + 500, sessionKey: "s1", to: "+49", success: true });
    const r = didMessageGoOut(l, { sendId: id });
    expect(r.verdict).toBe("CLAIMED_ONLY");
    expect(r.say).toMatch(/does not deliver over an HTTPS API/);
    l.close();
  });
  it("NO_SEND with an empty record", () => {
    const l = new Ledger(":memory:");
    expect(didMessageGoOut(l, { sessionKey: "s1" }).verdict).toBe("NO_SEND");
    l.close();
  });
});

describe("compactionBrief", () => {
  it("names a blocked host and a failed action after a compaction", () => {
    const l = new Ledger(":memory:");
    for (let i = 0; i < 6; i++) ev(l, T0 + i * 1000, "GET", "wall.example", 403, { attribution: { sessionKey: "s1", toolName: "web_fetch" } });
    l.recordToolOutcome({ ts: T0 + 7000, sessionKey: "s1", toolName: "exec", toolCallId: "x1", ok: false, argHint: "npm test", errorText: "exit 1" });
    l.recordCompaction({ ts: T0 + 8000, sessionKey: "s1", phase: "after", compactedCount: 40 });
    const b = compactionBrief(l, { sessionKey: "s1" });
    expect(b.compactedAt).toBe(T0 + 8000);
    expect(b.mustNotForget.join(" ")).toMatch(/wall\.example/);
    expect(b.mustNotForget.join(" ")).toMatch(/exec npm test/);
    l.close();
  });
});

describe("taskMatch", () => {
  it("keywords and asks", () => {
    expect(keywordsOf("Please send the quarterly report to Anna and check the invoice status")).toContain("quarterly");
    expect(asksOf("Please send the quarterly report to Anna")).toContain("send");
  });
  it("INCOHERENT when the request asked to send and nothing was sent, and the reply shares no terms", () => {
    const l = new Ledger(":memory:");
    l.recordInbound({ ts: T0, sessionKey: "s1", channelId: "telegram", conversationId: "1", len: 90, keywords: keywordsOf("Please send the quarterly report to Anna and confirm the invoice number today"), asks: ["send"] });
    l.recordToolOutcome({ ts: T0 + 1000, sessionKey: "s1", toolName: "web_search", ok: true });
    l.recordOutbound({ ts: T0 + 3000, sessionKey: "s1", channelId: "telegram", to: "1", len: 30, keywords: keywordsOf("The weather looks fine, enjoy your day"), cancelled: false });
    const r = taskMatch(l, { sessionKey: "s1" });
    expect(r.verdict).toBe("INCOHERENT");
    expect(r.asksMissing).toContain("send");
    l.close();
  });
  it("COHERENT when the reply covers the request and the asked action happened", () => {
    const l = new Ledger(":memory:");
    l.recordInbound({ ts: T0, sessionKey: "s1", channelId: "telegram", conversationId: "1", len: 60, keywords: keywordsOf("check the invoice status for order 4711 please"), asks: ["fetch"] });
    ev(l, T0 + 1000, "GET", "erp.example", 200);
    l.recordToolOutcome({ ts: T0 + 1100, sessionKey: "s1", toolName: "web_fetch", ok: true });
    l.recordOutbound({ ts: T0 + 3000, sessionKey: "s1", channelId: "telegram", to: "1", len: 80, keywords: keywordsOf("Invoice status for order 4711: paid on Monday, check complete"), cancelled: false });
    expect(taskMatch(l, { sessionKey: "s1" }).verdict).toBe("COHERENT");
    l.close();
  });
});

describe("reconcileText", () => {
  const line = (ts: number, role: string, content: unknown) => JSON.stringify({ timestamp: new Date(ts).toISOString(), message: { role, content } });
  it("contradicts a 'sent' claim when the send failed", () => {
    const l = new Ledger(":memory:");
    l.recordOutbound({ ts: T0 + 1000, sessionKey: "s1", channelId: "telegram", to: "1", len: 10, cancelled: false });
    l.markSent({ ts: T0 + 1500, sessionKey: "s1", to: "1", success: false, error: "chat not found" });
    const t = [line(T0, "user", "send it"), line(T0 + 2000, "assistant", [{ type: "text", text: "I have sent the report to Anna." }])].join("\n");
    const r = reconcileText(t, l, { sessionKey: "s1" });
    expect(r.claims[0].status).toBe("CONTRADICTED");
    expect(r.verdict).toBe("CLAIMS_EXCEED_RECORD");
    l.close();
  });
  it("supports a 'fixed' claim backed by a successful edit and reports an unmentioned failure", () => {
    const l = new Ledger(":memory:");
    l.recordToolOutcome({ ts: T0 + 500, sessionKey: "s1", toolName: "exec", ok: false, argHint: "npm test", errorText: "2 failing" });
    l.recordToolOutcome({ ts: T0 + 1000, sessionKey: "s1", toolName: "edit", ok: true, argHint: "app.ts" });
    const t = [line(T0 + 800, "assistant", [{ type: "text", text: "Looking at the code now." }]), line(T0 + 2000, "assistant", [{ type: "text", text: "Fixed the null check in app.ts." }])].join("\n");
    const r = reconcileText(t, l, { sessionKey: "s1" });
    expect(r.claims.find((c) => c.kind === "changed")?.status).toBe("SUPPORTED");
    expect(r.unmentionedFailures.length).toBe(1);
    expect(r.verdict).toBe("RECORD_EXCEEDS_CLAIMS");
    l.close();
  });
});
