import { describe, expect, it } from "vitest";
import { Ledger } from "./ledger.js";
import { computeOutlook, outlookFor, wilsonLower } from "./outlook.js";
import type { EgressEvent } from "./types.js";

function ev(host: string, status: number | undefined, ts: number, tool = "web_fetch", durationMs = 120): EgressEvent {
  return {
    ts,
    source: "inproc",
    protocol: "https",
    method: "GET",
    host,
    status,
    durationMs,
    category: "external",
    flags: [],
    blocked: false,
    attribution: { toolName: tool, toolCallId: `tc-${ts}` },
  };
}

const T0 = 1_800_000_000_000;

describe("computeOutlook", () => {
  it("says no-history when nothing was observed", () => {
    const o = computeOutlook("api.example", [], 60);
    expect(o.diagnosis).toBe("no-history");
    expect(o.pNext).toBeCloseTo(0.5);
  });

  it("detects a block: 403 streak after earlier successes", () => {
    const evs = [200, 200, 200, 200, 403, 403, 403].map((s, i) => ev("resy.example", s, T0 + i * 1000));
    const o = computeOutlook("resy.example", evs, 60);
    expect(o.diagnosis).toBe("blocked");
    expect(o.recommendation).toMatch(/Retrying makes it worse/);
    expect(o.backoffSeconds).toBe(900);
  });

  it("detects rate limiting and proposes a back-off from observed spacing", () => {
    const evs = [200, 200, 429, 200, 429].map((s, i) => ev("api.example", s, T0 + i * 2000));
    const o = computeOutlook("api.example", evs, 60);
    expect(o.diagnosis).toBe("rate-limited");
    expect(o.backoffSeconds).toBeGreaterThanOrEqual(10);
    expect(o.backoffSeconds).toBeLessThanOrEqual(300);
  });

  it("blames the site for a 5xx run", () => {
    const evs = [200, 502, 503, 500].map((s, i) => ev("down.example", s, T0 + i * 1000));
    expect(computeOutlook("down.example", evs, 60).diagnosis).toBe("site-error");
  });

  it("calls timeouts unreachable", () => {
    const evs = [undefined, undefined, undefined].map((s, i) => ev("gone.example", s, T0 + i * 1000));
    expect(computeOutlook("gone.example", evs, 60).diagnosis).toBe("unreachable");
  });

  it("says ok and points at the request when the host answers", () => {
    const evs = [200, 200, 404, 200, 200, 200].map((s, i) => ev("fine.example", s, T0 + i * 1000));
    const o = computeOutlook("fine.example", evs, 60);
    expect(o.diagnosis).toBe("ok");
    expect(o.pLower).toBeGreaterThan(0.3);
    expect(o.recommendation).toMatch(/probably in the request itself/);
  });

  it("recommends the tool that actually works on this host", () => {
    const evs = [
      ...[500, 500, 500, 500, 500].map((s, i) => ev("picky.example", s, T0 + i * 1000, "web_fetch")),
      ...[200, 200, 200, 200, 200, 200].map((s, i) => ev("picky.example", s, T0 + 10_000 + i * 1000, "browser")),
    ];
    const o = computeOutlook("picky.example", evs, 60);
    expect(o.bestTool).toBe("browser");
  });

  it("wilson lower bound grows with evidence", () => {
    expect(wilsonLower(9, 10)).toBeGreaterThan(wilsonLower(3, 3));
    expect(wilsonLower(0, 0)).toBe(0);
  });
});

describe("outlookFor (ledger)", () => {
  it("reads the host history from the ledger and falls back to all-time", () => {
    const l = new Ledger(":memory:");
    const old = Date.now() - 3 * 3_600_000;
    for (let i = 0; i < 4; i++) {
      l.record(ev("old.example", 200, old + i * 1000));
    }
    const o = outlookFor(l, "old.example", 60);
    expect(o.windowMinutes).toBe(0); // fell back to all-time
    expect(o.n).toBe(4);
    expect(o.diagnosis).toBe("ok");
    l.close();
  });
});
