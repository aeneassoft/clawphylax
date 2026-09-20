// Extract network targets, upload intent and sensitive-file reads from a
// shell command string handed to the exec tool. This is best-effort text
// analysis, not execution tracing: it sees what the command says, not what a
// downloaded script does afterwards. Child-process traffic is invisible to the
// in-process interceptor, so this is the only signal we have for exec in v0.1.

export type ExecTarget = {
  host: string;
  port?: number;
  protocol: string;
  method: string;
  path?: string;
};

export type ExecAnalysis = {
  targets: ExecTarget[];
  upload: boolean;
  sensitiveRead: boolean;
  skill?: string;
};

const URL_RE = /\b(https?|wss?|ftp|ftps|sftp):\/\/([^\s'"`<>)\]]+)/gi;

const UPLOAD_HINTS = [
  /(^|\s)-X\s*POST\b/i,
  /(^|\s)-X\s*PUT\b/i,
  /(^|\s)--request\s+(POST|PUT)\b/i,
  /(^|\s)(-d|--data|--data-binary|--data-raw|--data-urlencode)\b/,
  /(^|\s)(-F|--form)\b/,
  /(^|\s)(-T|--upload-file)\b/,
  /(^|\s)--post-data\b/,
  /(^|\s)--post-file\b/,
  /\brequests\.(post|put|patch)\(/,
  /\bmethod\s*[:=]\s*["'](POST|PUT|PATCH)["']/i,
  /\bscp\s/,
  /\brsync\s/,
  /\bnc\s+(-\w+\s+)*[\w.-]+\s+\d+/,
  /\|\s*(curl|wget)\b/,
];

const SENSITIVE_HINTS = [
  /\.ssh[\\/]/i,
  /\bid_(rsa|ed25519|ecdsa|dsa)\b/i,
  /\.aws[\\/]credentials/i,
  /\.aws[\\/]config/i,
  /\.env\b/,
  /\.npmrc\b/,
  /\.pypirc\b/,
  /\.netrc\b/,
  /\.git-credentials\b/,
  /\.kube[\\/]config/i,
  /\.docker[\\/]config\.json/i,
  /\bcredentials?\.json\b/i,
  /\bsecrets?\.(json|ya?ml|toml)\b/i,
  /\.openclaw[\\/]openclaw\.json/i,
  /\bkeychain\b/i,
  /security\s+find-(generic|internet)-password/i,
  /\b(token|apikey|api_key|secret)s?\.(txt|json)\b/i,
  /\/etc\/(passwd|shadow)\b/,
  /%APPDATA%/i,
  /AppData[\\/]Roaming/i,
];

const SKILL_PATH_RE = /skills[\\/]([A-Za-z0-9_.@-]+)[\\/]/;

function pushTarget(out: ExecTarget[], t: ExecTarget): void {
  if (!t.host) {
    return;
  }
  const key = `${t.protocol}://${t.host}:${t.port ?? ""}${t.path ?? ""}`;
  if (!out.some((x) => `${x.protocol}://${x.host}:${x.port ?? ""}${x.path ?? ""}` === key)) {
    out.push(t);
  }
}

export function analyzeExecCommand(command: string): ExecAnalysis {
  const cmd = command ?? "";
  const targets: ExecTarget[] = [];
  const upload = UPLOAD_HINTS.some((re) => re.test(cmd));
  const method = upload ? "POST" : "GET";

  for (const m of cmd.matchAll(URL_RE)) {
    const protocol = m[1].toLowerCase();
    const rest = m[2];
    const [hostport, ...pathParts] = rest.split("/");
    const hp = hostport.replace(/^[^@]*@/, ""); // strip userinfo
    const [host, portStr] = hp.startsWith("[") ? [hp, undefined] : hp.split(":");
    const port = portStr ? Number.parseInt(portStr, 10) : undefined;
    pushTarget(targets, {
      host: host.toLowerCase(),
      port: Number.isFinite(port) ? port : undefined,
      protocol,
      method,
      path: pathParts.length ? "/" + pathParts.join("/").split(/[?#]/)[0] : undefined,
    });
  }

  // curl/wget with a bare host (no scheme)
  for (const m of cmd.matchAll(/\b(curl|wget)\b([^|;&]*)/gi)) {
    const args = m[2].split(/\s+/).filter(Boolean);
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a.startsWith("-")) {
        if (/^(-o|-O|-d|--data|-H|--header|-X|--request|-T|--upload-file|-F|--form|-u|--user|-A|--user-agent|-e|--referer|--output|--post-data|--post-file)$/.test(a)) {
          i++;
        }
        continue;
      }
      if (/^[a-z]+:\/\//i.test(a)) {
        continue; // already captured by URL_RE
      }
      const bare = a.match(/^([a-z0-9.-]+\.[a-z]{2,}|\d{1,3}(?:\.\d{1,3}){3})(?::(\d+))?(\/[^\s]*)?$/i);
      if (bare) {
        pushTarget(targets, {
          host: bare[1].toLowerCase(),
          port: bare[2] ? Number.parseInt(bare[2], 10) : undefined,
          protocol: "http",
          method,
          path: bare[3],
        });
      }
    }
  }

  // ssh / scp / rsync / nc / ping / dig / nslookup / git@host
  for (const m of cmd.matchAll(/\b(ssh|scp|sftp|rsync|nc|ncat|netcat|telnet|ping|dig|nslookup)\s+([^|;&]*)/gi)) {
    const tool = m[1].toLowerCase();
    const args = m[2].split(/\s+/).filter((x) => x && !x.startsWith("-"));
    for (const a of args) {
      const host = a.replace(/^[^@]*@/, "").split(":")[0];
      if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host) || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
        pushTarget(targets, { host: host.toLowerCase(), protocol: tool, method: tool.toUpperCase() });
        break;
      }
    }
  }
  for (const m of cmd.matchAll(/\bgit@([a-z0-9.-]+\.[a-z]{2,}):/gi)) {
    pushTarget(targets, { host: m[1].toLowerCase(), protocol: "ssh", method: "GIT" });
  }

  const sensitiveRead = SENSITIVE_HINTS.some((re) => re.test(cmd));
  const skillMatch = cmd.match(SKILL_PATH_RE);

  return {
    targets,
    upload,
    sensitiveRead,
    skill: skillMatch ? skillMatch[1] : undefined,
  };
}

export function extractCommand(params: unknown): string | undefined {
  if (!params || typeof params !== "object") {
    return undefined;
  }
  const p = params as Record<string, unknown>;
  for (const k of ["command", "cmd", "script", "code", "input"]) {
    const v = p[k];
    if (typeof v === "string" && v.trim()) {
      return v;
    }
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
      return (v as string[]).join(" ");
    }
  }
  return undefined;
}
