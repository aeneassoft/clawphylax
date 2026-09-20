// Pre-install scan of a skill folder: the same command analysis we run at
// runtime, applied to SKILL.md code blocks and bundled scripts. Cheap, local,
// static — meant for the moment an agent is deciding whether to install.
// It complements a full scanner (Cisco skill-scanner); it does not replace it.

import fs from "node:fs";
import path from "node:path";
import { analyzeExecCommand } from "./exec-parse.js";

export type ScanFinding = {
  file: string;
  line: number;
  host?: string;
  method?: string;
  upload: boolean;
  sensitiveRead: boolean;
  snippet: string;
};

export type ScanResult = {
  root: string;
  filesScanned: number;
  hosts: string[];
  findings: ScanFinding[];
  verdict: "clean" | "review" | "suspicious";
};

const SCRIPT_EXT = new Set([".md", ".sh", ".bash", ".zsh", ".py", ".js", ".mjs", ".cjs", ".ts", ".ps1", ".bat", ".cmd", ".rb", ".pl"]);
const MAX_FILES = 300;
const MAX_BYTES = 512 * 1024;

function* walk(dir: string, depth = 0): Generator<string> {
  if (depth > 6) {
    return;
  }
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name.startsWith(".git")) {
      continue;
    }
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walk(p, depth + 1);
    } else if (e.isFile() && SCRIPT_EXT.has(path.extname(e.name).toLowerCase())) {
      yield p;
    }
  }
}

export function scanSkillFolder(root: string, isSuspicious: (host: string) => boolean): ScanResult {
  const findings: ScanFinding[] = [];
  const hosts = new Set<string>();
  let filesScanned = 0;
  for (const file of walk(root)) {
    if (filesScanned >= MAX_FILES) {
      break;
    }
    let text: string;
    try {
      const st = fs.statSync(file);
      if (st.size > MAX_BYTES) {
        continue;
      }
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    filesScanned++;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!/[a-z]+:\/\/|\b(curl|wget|ssh|scp|rsync|nc|requests\.|fetch\(|\.ssh|\.env\b|\.aws|credentials|id_rsa)/i.test(line)) {
        continue;
      }
      const a = analyzeExecCommand(line);
      if (a.targets.length === 0 && !a.sensitiveRead) {
        continue;
      }
      const rel = path.relative(root, file) || path.basename(file);
      if (a.targets.length === 0) {
        findings.push({ file: rel, line: i + 1, upload: a.upload, sensitiveRead: true, snippet: line.trim().slice(0, 160) });
        continue;
      }
      for (const t of a.targets) {
        hosts.add(t.host);
        findings.push({ file: rel, line: i + 1, host: t.host, method: t.method, upload: a.upload, sensitiveRead: a.sensitiveRead, snippet: line.trim().slice(0, 160) });
      }
    }
  }
  const anySuspicious = findings.some((f) => (f.host && isSuspicious(f.host)) || (f.upload && f.sensitiveRead));
  const anyReview = findings.some((f) => f.upload || f.sensitiveRead);
  return {
    root,
    filesScanned,
    hosts: [...hosts].sort(),
    findings,
    verdict: anySuspicious ? "suspicious" : anyReview ? "review" : "clean",
  };
}
