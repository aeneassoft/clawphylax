// Third transport seam: OpenClaw's own bundled undici.
//
// The host imports `{ Agent, fetch } from "undici"` (its own copy, not Node's
// internal one), so neither the http/https patch nor globalThis.fetch sees
// provider traffic. undici's fetch uses that instance's global dispatcher
// unless a request passes an explicit one, so composing an interceptor onto
// the global dispatcher observes and can refuse those requests.
//
// Verified against undici 8.3.0 shipped with OpenClaw 2026.6.1: the new
// controller-style handler API (onResponseStart/onResponseData) and the old
// one (onHeaders/onData) are both wrapped.

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import type { Decision, Observed } from "./intercept.js";

type Seam = { decide: (t: { protocol: "http" | "https"; host: string; port?: number; path?: string; method: string }) => Decision; observe: (o: Observed & { blocked: boolean }) => void };

let installedOn: unknown | undefined;

function findHostPackageRoot(): string | undefined {
  // 1. Resolve through this module's own resolution chain (npm link / devDependency).
  try {
    const req = createRequire(import.meta.url);
    return path.dirname(req.resolve("openclaw/package.json"));
  } catch {
    /* fall through */
  }
  // 2. Walk up from the running entry script (the Gateway/CLI bin lives inside the package).
  const start = process.argv[1] ? path.dirname(process.argv[1]) : undefined;
  let dir = start;
  for (let i = 0; dir && i < 8; i++) {
    const pkg = path.join(dir, "package.json");
    try {
      if (fs.existsSync(pkg) && JSON.parse(fs.readFileSync(pkg, "utf8")).name === "openclaw") {
        return dir;
      }
    } catch {
      /* ignore */
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return undefined;
}

export function installUndiciSeam(seam: Seam, log?: { warn: (m: string) => void; info?: (m: string) => void }): boolean {
  const root = findHostPackageRoot();
  if (!root) {
    log?.warn("undici seam: OpenClaw package root not found; provider calls via bundled undici will not be attributed");
    return false;
  }
  let undici: any;
  try {
    undici = createRequire(path.join(root, "package.json"))("undici");
  } catch (err: any) {
    log?.warn(`undici seam: cannot load host undici (${err?.message ?? err})`);
    return false;
  }
  const AgentClass = undici?.Agent;
  if (typeof AgentClass?.prototype?.dispatch !== "function") {
    log?.warn("undici seam: Agent.prototype.dispatch missing");
    return false;
  }
  if (installedOn === undici) {
    return true;
  }

  // Patch at the class level: covers the global dispatcher, every explicit
  // `new Agent()` the host passes as `dispatcher`, and EnvHttpProxyAgent
  // (which delegates to Agents). Composing onto the global dispatcher alone
  // misses explicit agents — verified against the provider transport.
  const interceptor = (dispatch: any) => (opts: any, handler: any) => {
    let host = "";
    let port: number | undefined;
    let protocol: "http" | "https" = "https";
    try {
      const u = new URL(String(opts.origin));
      host = u.hostname.toLowerCase();
      port = u.port ? Number(u.port) : undefined;
      protocol = u.protocol === "http:" ? "http" : "https";
    } catch {
      return dispatch(opts, handler);
    }
    const method = String(opts.method ?? "GET").toUpperCase();
    const reqPath = typeof opts.path === "string" ? opts.path.split("?")[0] : undefined;
    const target = { protocol, host, port, path: reqPath, method };
    const start = Date.now();

    let decision: Decision = { block: false };
    try {
      decision = seam.decide(target);
    } catch {
      /* never block on our own failure */
    }
    if (decision.block) {
      safe(seam, { ...target, durationMs: 0, blocked: true, error: decision.reason });
      throw new Error(`ClawPhylax blocked outbound request to ${host}${decision.reason ? `: ${decision.reason}` : ""}`);
    }

    const rec: { status?: number; bytesIn: number; done: boolean } = { bytesIn: 0, done: false };
    const finish = (error?: string) => {
      if (rec.done) {
        return;
      }
      rec.done = true;
      safe(seam, { ...target, status: rec.status, bytesIn: rec.bytesIn, bytesOut: bodyLength(opts.body), durationMs: Date.now() - start, blocked: false, error });
    };
    const wrapped = new Proxy(handler, {
      get(t, k) {
        const v = (t as any)[k];
        if (typeof v !== "function") {
          return v;
        }
        switch (k) {
          case "onResponseStart":
            return (ctrl: any, status: number, headers: any, ...rest: any[]) => {
              rec.status = status;
              return v.call(t, ctrl, status, headers, ...rest);
            };
          case "onResponseData":
            return (ctrl: any, chunk: any, ...rest: any[]) => {
              rec.bytesIn += chunk?.length ?? 0;
              return v.call(t, ctrl, chunk, ...rest);
            };
          case "onResponseEnd":
            return (...args: any[]) => {
              finish();
              return v.apply(t, args);
            };
          case "onResponseError":
            return (ctrl: any, err: any, ...rest: any[]) => {
              finish(err?.message ?? String(err));
              return v.call(t, ctrl, err, ...rest);
            };
          case "onHeaders":
            return (status: number, ...rest: any[]) => {
              rec.status = status;
              return v.call(t, status, ...rest);
            };
          case "onData":
            return (chunk: any, ...rest: any[]) => {
              rec.bytesIn += chunk?.length ?? 0;
              return v.call(t, chunk, ...rest);
            };
          case "onComplete":
            return (...args: any[]) => {
              finish();
              return v.apply(t, args);
            };
          case "onError":
            return (err: any, ...rest: any[]) => {
              finish(err?.message ?? String(err));
              return v.call(t, err, ...rest);
            };
          default:
            return v.bind(t);
        }
      },
    });
    return dispatch(opts, wrapped);
  };

  const original = AgentClass.prototype.dispatch;
  AgentClass.prototype.dispatch = function patchedDispatch(this: unknown, opts: any, handler: any) {
    return interceptor((o: any, h: any) => original.call(this, o, h))(opts, handler);
  };
  installedOn = undici;
  return true;
}

function bodyLength(body: unknown): number | undefined {
  if (typeof body === "string") {
    return Buffer.byteLength(body);
  }
  if (body instanceof Uint8Array) {
    return body.byteLength;
  }
  return undefined;
}

function safe(seam: Seam, o: Observed & { blocked: boolean }): void {
  try {
    seam.observe(o);
  } catch {
    /* never break the host */
  }
}
