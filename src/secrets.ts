// Secret-shaped values in outbound text. Detection only: the value itself is
// never stored — callers get the kind and a masked sample. Patterns are the
// well-known prefixes plus one entropy rule for long opaque tokens.

export type SecretHit = { kind: string; masked: string };

const PATTERNS: Array<[string, RegExp]> = [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY(?: BLOCK)?-----/],
  ["aws-access-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["openai-key", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ["github-token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/],
  ["github-pat", /\bgithub_pat_[A-Za-z0-9_]{22,}\b/],
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ["stripe-key", /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["telegram-bot-token", /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/],
  ["twilio-key", /\bSK[0-9a-f]{32}\b/],
  ["npm-token", /\bnpm_[A-Za-z0-9]{36}\b/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ["bearer-token", /\bBearer\s+[A-Za-z0-9._-]{20,}\b/i],
  ["password-assignment", /\b(?:password|passwd|pwd|secret|api[_-]?key|token)\s*[=:]\s*["']?[^\s"']{8,}/i],
];

function entropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

export function mask(v: string): string {
  const t = v.trim();
  if (t.length <= 8) return "****";
  return `${t.slice(0, 4)}…${t.slice(-2)} (${t.length} chars)`;
}

/** Find secret-shaped values in text. Returns kinds and masked samples only. */
export function findSecretShapes(text: string): SecretHit[] {
  const hits: SecretHit[] = [];
  if (!text) return hits;
  for (const [kind, re] of PATTERNS) {
    const m = text.match(re);
    if (m) hits.push({ kind, masked: mask(m[0]) });
  }
  // Long opaque tokens with high entropy and no natural-language shape.
  for (const m of text.matchAll(/\b[A-Za-z0-9_-]{40,}\b/g)) {
    const v = m[0];
    if (/^[a-z-]+$/.test(v) || /^[0-9]+$/.test(v)) continue;
    if (/[A-Z]/.test(v) && /[a-z]/.test(v) && /[0-9]/.test(v) && entropy(v) >= 4.2) {
      if (!hits.some((h) => h.masked === mask(v))) hits.push({ kind: "high-entropy-token", masked: mask(v) });
      if (hits.length >= 8) break;
    }
  }
  return hits;
}
