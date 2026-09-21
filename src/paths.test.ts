import { describe, expect, it } from "vitest";
import { Ledger } from "./ledger.js";
import { whichPath } from "./paths.js";
import type { EgressEvent } from "./types.js";

describe("whichPath", () => {
  it("exploits a proven path over an unknown one when the safe value is clearly ahead", () => {
    const r = whichPath([
      { name: "official-api", successes: 18, failures: 2, costPerAttempt: 1, valueIfSuccess: 10 },
      { name: "scrape-site", costPerAttempt: 1, valueIfSuccess: 10 },
    ]);
    expect(r.paths[0].name).toBe("official-api");
    expect(r.paths[0].action).toBe("exploit");
    expect(r.recommendation).toMatch(/Exploit "official-api"/);
  });

  it("explores when nothing is safely profitable yet", () => {
    const r = whichPath([
      { name: "ask-forum", costPerAttempt: 2, valueIfSuccess: 10 },
      { name: "read-source", costPerAttempt: 3, valueIfSuccess: 12 },
    ]);
    expect(r.paths.some((p) => p.action === "explore")).toBe(true);
    expect(r.recommendation).toMatch(/Explore/);
  });

  it("folds paths that cannot pay even in the best case", () => {
    const r = whichPath([
      { name: "expensive-longshot", successes: 0, failures: 10, costPerAttempt: 9, valueIfSuccess: 10 },
      { name: "cheap", successes: 3, failures: 3, costPerAttempt: 1, valueIfSuccess: 10 },
    ]);
    const fold = r.paths.find((p) => p.name === "expensive-longshot")!;
    expect(fold.action).toBe("fold");
    expect(r.plan.join(" ")).toMatch(/Fold/);
  });

  it("pulls observations from the ledger when a path is a host", () => {
    const l = new Ledger(":memory:");
    const T0 = Date.now() - 60_000;
    for (let i = 0; i < 8; i++) {
      const e: EgressEvent = { ts: T0 + i * 1000, source: "inproc", protocol: "https", method: "GET", host: "api.example.com", status: i < 7 ? 200 : 500, category: "external", flags: [], blocked: false, attribution: { toolName: "web_fetch" } };
      l.record(e);
    }
    const r = whichPath([{ name: "api.example.com" }, { name: "manual-search" }], { ledger: l });
    const api = r.paths.find((p) => p.name === "api.example.com")!;
    expect(api.fromLedger).toBe(true);
    expect(api.n).toBe(8);
    expect(api.successes).toBe(7);
    l.close();
  });

  it("never folds on a point estimate with little evidence", () => {
    const r = whichPath([{ name: "one-miss", successes: 0, failures: 1, costPerAttempt: 1, valueIfSuccess: 10 }]);
    expect(r.paths[0].action).not.toBe("fold");
  });
});
