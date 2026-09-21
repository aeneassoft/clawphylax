// Decision record: the output shape a model acts on rather than summarises.
// ACTION first; the prohibited action named; the next call spelled out; the
// scope the evidence applies to. (See OPENAI_ANTWORT_ANNOTIERT.md, points 3–5.)

export type DecisionRecord = {
  action: string;
  evidence: string;
  doNot?: string;
  next: string;
  confidence?: string;
  scope?: string;
  note?: string;
};

export function renderRecord(r: DecisionRecord): string {
  const lines = [`ACTION: ${r.action}`, `EVIDENCE: ${r.evidence}`];
  if (r.doNot) lines.push(`DO NOT: ${r.doNot}`);
  lines.push(`NEXT: ${r.next}`);
  if (r.confidence) lines.push(`CONFIDENCE: ${r.confidence}`);
  if (r.scope) lines.push(`SCOPE: ${r.scope}`);
  if (r.note) lines.push(`NOTE: ${r.note}`);
  return lines.join("\n");
}

export const SCOPE_LOCAL = "this machine, current credentials and tools; evidence goes stale if credentials, endpoint or tool version change";
