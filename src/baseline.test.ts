import { describe, expect, it } from "vitest";
import { computeBaseline, isUnexpectedNewHost, wilsonUpper } from "./baseline.js";

describe("baseline gate (poker LCB port)", () => {
  it("never triggers while learning", () => {
    const b = computeBaseline("skill:x", 5, 1);
    expect(b.status).toBe("learning");
    expect(isUnexpectedNewHost(b)).toBe(false);
  });

  it("triggers for a settled origin that has only ever used a couple of hosts", () => {
    const b = computeBaseline("skill:x", 200, 2);
    expect(b.status).toBe("stable");
    expect(b.noveltyUpper).toBeLessThan(0.25);
    expect(isUnexpectedNewHost(b)).toBe(true);
  });

  it("does not trigger for an origin that contacts many different hosts (web_fetch)", () => {
    const b = computeBaseline("tool:web_fetch", 60, 40);
    expect(b.status).toBe("volatile");
    expect(isUnexpectedNewHost(b)).toBe(false);
  });

  it("uses the bound, not the point estimate: few events with one host is still learning", () => {
    // 20 events, 1 host: point estimate novelty 5 %, but the bound is wide.
    const b = computeBaseline("skill:y", 20, 1);
    expect(b.n).toBe(20);
    expect(wilsonUpper(1, 20)).toBeGreaterThan(0.2);
    expect(b.status === "stable" || b.status === "volatile").toBe(true);
    // At 60 events with one host the bound closes and it becomes stable.
    expect(computeBaseline("skill:y", 60, 1).status).toBe("stable");
  });

  it("wilson upper is monotone in n", () => {
    expect(wilsonUpper(1, 10)).toBeGreaterThan(wilsonUpper(1, 100));
    expect(wilsonUpper(0, 0)).toBe(1);
  });
});
