// The Data Pact: opt-in sharing of observed request outcomes so that every
// contributor's outlook improves with everyone else's observations.
//
// This module holds the local side only: the consent switch, the exact rows
// that would leave the machine, and the pact text. No upload path exists in
// this version; nothing leaves the machine regardless of the switch. That is
// stated wherever the switch is shown.

import { createHash } from "node:crypto";
import type { Ledger } from "./ledger.js";

export const PACT_VERSION = "1";

export type ShareRow = {
  hostHash: string; // sha256(host), first 16 hex chars — hosts are pooled by hash, never by name
  method: string;
  statusClass: "2xx" | "3xx" | "4xx" | "5xx" | "401/403" | "429" | "error";
  latencyBucket: "<200ms" | "<1s" | "<5s" | ">=5s" | "n/a";
  tool: string; // tool name only; never skill names, never paths, never bodies
  day: string; // UTC date, no time
};

export function hostHash(host: string): string {
  return createHash("sha256").update(host.toLowerCase()).digest("hex").slice(0, 16);
}

export function previewRows(ledger: Ledger, limit = 20): ShareRow[] {
  return ledger
    .recentEvents(limit)
    .filter((e) => e.source === "inproc" && e.category !== "local")
    .map((e) => ({
      hostHash: hostHash(e.host),
      method: e.method,
      statusClass: e.status === 429 ? "429" : e.status === 401 || e.status === 403 ? "401/403" : typeof e.status === "number" ? (`${Math.floor(e.status / 100)}xx` as ShareRow["statusClass"]) : "error",
      latencyBucket: typeof e.durationMs !== "number" ? "n/a" : e.durationMs < 200 ? "<200ms" : e.durationMs < 1000 ? "<1s" : e.durationMs < 5000 ? "<5s" : ">=5s",
      tool: e.attribution.toolName ?? "model-turn",
      day: new Date(e.ts).toISOString().slice(0, 10),
    }));
}

export function getConsent(ledger: Ledger): { on: boolean; since?: string; pactVersion?: string } {
  const row = ledger.getSetting("share.consent");
  if (!row) {
    return { on: false };
  }
  try {
    const j = JSON.parse(row);
    return { on: j.on === true, since: j.since, pactVersion: j.pactVersion };
  } catch {
    return { on: false };
  }
}

export function setConsent(ledger: Ledger, on: boolean): { on: boolean; since?: string; pactVersion?: string } {
  const v = on ? { on: true, since: new Date().toISOString(), pactVersion: PACT_VERSION } : { on: false };
  ledger.setSetting("share.consent", JSON.stringify(v));
  return v;
}

export const PACT_TEXT = `ClawPhylax Data Pact (v${PACT_VERSION})

What you would share, and nothing else:
  hostHash (sha256 prefix of the hostname), method, status class, latency
  bucket, tool name, UTC day. Six fields. No hostnames in clear text, no
  paths, no query strings, no bodies, no headers, no skill names, no session
  or run ids, no machine identifier, no timestamps finer than a day.

What you get for it:
  1. Outlook with context: "agents like yours succeed on this host 80% of the
     time; you 40%" — the answer to "is it me or the site" from more than one
     machine.
  2. Early warning: when a host starts refusing agents, contributors see it
     before their own attempts fail.
  3. Witness-card matching: a skill's behavior on your machine compared with
     what it did elsewhere.
  4. Voice: contributors decide, by majority, what a future pact version may
     add. Nothing is added to the six fields without a new version and a new
     opt-in; an old consent never covers new fields.

Rules we bind ourselves to:
  - Off by default. Consent is per machine, recorded locally, revocable with
    one command. Revocation deletes your rows from the pool within 30 days.
  - Raw rows are never sold and never shown per machine. Only aggregates with
    at least 25 distinct contributors per host are published or used in the
    outlook, so no single contributor is identifiable.
  - The row format is public (this file). You can see every row before it
    leaves: openclaw clawphylax share --preview.
  - If the operator of the pool changes, or these rules change, the pool is
    deleted and consent starts from zero. Your data cannot be inherited by
    new terms.
  - The aggregated map is open to contributors at no cost, for as long as
    the pool exists. Paid use is limited to organisations that do not
    contribute (fleet views, API access); it never restricts what
    contributors receive.

Status: the pool does not exist yet. Turning the switch on today records
your consent and shows you the rows; nothing leaves your machine until a
release that includes an upload path, announced in the changelog.`;
