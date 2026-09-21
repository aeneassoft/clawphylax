import { describe, expect, it } from "vitest";
import { didItWork } from "./diagnostics.js";
import { Ledger } from "./ledger.js";
import type { EgressEvent } from "./types.js";

const T0 = Date.now() - 60_000;
function outcome(l: Ledger, id: string, tool: string, ok: boolean, hint?: string, err?: string) {
  l.recordToolOutcome({ ts: T0 + Number(id.replace(/\D/g, "")) * 1000, sessionKey: "s1", toolName: tool, toolCallId: id, ok, argHint: hint, errorText: err });
}
function ev(l: Ledger, id: string, method: string, host: string, status: number | undefined, bytesIn = 512) {
  const e: EgressEvent = { ts: T0 + Number(id.replace(/\D/g, "")) * 1000 + 10, source: "inproc", protocol: "https", method, host, path: "/api", status, bytesIn, category: "external", flags: [], blocked: false, attribution: { toolName: "web_fetch", toolCallId: id, sessionKey: "s1" } };
  l.record(e);
}

describe("didItWork", () => {
  it("confirms when the tool said ok and the wire agrees", () => {
    const l = new Ledger(":memory:");
    outcome(l, "tc1", "web_fetch", true, "api.example/api");
    ev(l, "tc1", "GET", "api.example", 200);
    const r = didItWork(l, { sessionKey: "s1" });
    expect(r.verdict).toBe("CONFIRMED");
    l.close();
  });

  it("catches the silent failure: tool ok, wire 403", () => {
    const l = new Ledger(":memory:");
    outcome(l, "tc2", "web_fetch", true, "api.example/api");
    ev(l, "tc2", "POST", "api.example", 403);
    const r = didItWork(l, { sessionKey: "s1" });
    expect(r.verdict).toBe("SILENT_FAILURE");
    expect(r.mismatch).toMatch(/reported ok, but POST api.example.*403/);
    l.close();
  });

  it("catches an empty 200 as a silent failure", () => {
    const l = new Ledger(":memory:");
    outcome(l, "tc3", "web_fetch", true, "api.example/api");
    ev(l, "tc3", "GET", "api.example", 200, 0);
    expect(didItWork(l, { sessionKey: "s1" }).verdict).toBe("SILENT_FAILURE");
    l.close();
  });

  it("marks exec with a network target but no observable request as unverified", () => {
    const l = new Ledger(":memory:");
    outcome(l, "tc4", "exec", true, "curl -X POST -d x https://drop.example/up");
    const r = didItWork(l, { sessionKey: "s1" });
    expect(r.verdict).toBe("UNVERIFIED");
    expect(r.mismatch).toMatch(/child process/);
    l.close();
  });

  it("skips our own diagnostic tools when picking the last action", () => {
    const l = new Ledger(":memory:");
    outcome(l, "tc5", "write", true, "notes.md");
    outcome(l, "tc6", "clawphylax_outlook", true, "x");
    const r = didItWork(l, { sessionKey: "s1" });
    expect(r.tool).toBe("write");
    expect(r.verdict).toBe("UNVERIFIED");
    l.close();
  });

  it("reports failures as failed", () => {
    const l = new Ledger(":memory:");
    outcome(l, "tc7", "exec", false, "npm test", "exit code 1");
    expect(didItWork(l, { sessionKey: "s1" }).verdict).toBe("FAILED");
    l.close();
  });
});
