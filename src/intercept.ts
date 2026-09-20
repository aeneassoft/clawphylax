// In-process transport interception for the Gateway process.
//
// Ported from the AeneasSoft universal interceptor: patch node:http and
// node:https at the module level so every library that ends in Node's HTTP
// stack is seen, plus globalThis.fetch for undici-based callers (Node's own
// fetch does not route through http.request). No proxy, no CA, no body
// capture: we record host, method, path, status, sizes from headers, timing.
//
// Blocking (enforce mode) happens here for in-process requests: the request is
// refused before any bytes leave the process. This is the circuit-breaker
// path; it is off unless the operator sets mode: "enforce".

import http from "node:http";
import https from "node:https";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";

export type Observed = {
  protocol: "http" | "https";
  method: string;
  host: string;
  port?: number;
  path?: string;
  status?: number;
  bytesOut?: number;
  bytesIn?: number;
  durationMs: number;
  error?: string;
};

export type Decision = { block: boolean; reason?: string };

export type Hooks = {
  /** Called before the request is made. Return block:true to refuse it. */
  decide: (target: { protocol: "http" | "https"; host: string; port?: number; path?: string; method: string }) => Decision;
  /** Called once per finished (or failed/blocked) request. Must never throw. */
  observe: (o: Observed & { blocked: boolean }) => void;
};

let installed = false;
let hooks: Hooks | undefined;
const originals: { httpRequest?: typeof http.request; httpGet?: typeof http.get; httpsRequest?: typeof https.request; httpsGet?: typeof https.get; fetch?: typeof globalThis.fetch } = {};

export class BlockedByClawPhylax extends Error {
  constructor(host: string, reason?: string) {
    super(`ClawPhylax blocked outbound request to ${host}${reason ? `: ${reason}` : ""}`);
    this.name = "BlockedByClawPhylax";
  }
}

function parseTarget(
  protocol: "http" | "https",
  urlOrOptions: string | URL | RequestOptions,
  optionsOrCb?: RequestOptions | ((res: IncomingMessage) => void),
): { host: string; port?: number; path?: string; method: string } {
  let host = "";
  let port: number | undefined;
  let path: string | undefined;
  let method = "GET";
  try {
    const opts = (typeof optionsOrCb === "object" ? optionsOrCb : undefined) ?? {};
    if (typeof urlOrOptions === "string" || urlOrOptions instanceof URL) {
      const u = typeof urlOrOptions === "string" ? new URL(urlOrOptions) : urlOrOptions;
      host = u.hostname;
      port = u.port ? Number(u.port) : undefined;
      path = u.pathname;
    } else {
      const o = urlOrOptions;
      host = (o.hostname ?? o.host ?? "").split(":")[0];
      port = typeof o.port === "string" ? Number(o.port) : o.port ?? undefined;
      path = typeof o.path === "string" ? o.path.split("?")[0] : undefined;
      method = (o.method ?? "GET").toUpperCase();
    }
    if (typeof opts.method === "string") {
      method = opts.method.toUpperCase();
    }
    if (!host && typeof opts.hostname === "string") {
      host = opts.hostname;
    }
  } catch {
    /* keep defaults */
  }
  return { host: host.toLowerCase(), port, path, method };
}

function wrapRequest(protocol: "http" | "https", original: typeof http.request) {
  return function patched(this: unknown, urlOrOptions: any, optionsOrCb?: any, cb?: any): ClientRequest {
    const h = hooks;
    if (!h) {
      return original.call(this, urlOrOptions, optionsOrCb, cb);
    }
    const t = parseTarget(protocol, urlOrOptions, optionsOrCb);
    const start = Date.now();
    let decision: Decision = { block: false };
    try {
      decision = h.decide({ protocol, ...t });
    } catch {
      /* never block on our own failure */
    }
    if (decision.block) {
      safeObserve(h, { protocol, ...t, durationMs: 0, blocked: true, error: decision.reason });
      // Return a request that fails asynchronously with a clear error, so
      // callers see a normal network failure instead of a crash in our code.
      const req: ClientRequest = (original as any).call(this, { hostname: "127.0.0.1", port: 9, path: "/", method: t.method }, () => {});
      process.nextTick(() => req.destroy(new BlockedByClawPhylax(t.host, decision.reason)));
      return req;
    }

    const req: ClientRequest = original.call(this, urlOrOptions, optionsOrCb, cb);
    let bytesOut = 0;
    const origWrite = req.write.bind(req);
    const origEnd = req.end.bind(req);
    req.write = function (chunk: any, ...args: any[]) {
      if (chunk) {
        bytesOut += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
      }
      return (origWrite as any)(chunk, ...args);
    } as any;
    req.end = function (chunk?: any, ...args: any[]) {
      if (chunk && typeof chunk !== "function") {
        bytesOut += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
      }
      return (origEnd as any)(chunk, ...args);
    } as any;

    let done = false;
    const finish = (status?: number, bytesIn?: number, error?: string) => {
      if (done) {
        return;
      }
      done = true;
      safeObserve(h, { protocol, ...t, status, bytesOut, bytesIn, durationMs: Date.now() - start, blocked: false, error });
    };
    req.on("response", (res: IncomingMessage) => {
      let bytesIn = 0;
      res.on("data", (c: Buffer) => {
        bytesIn += c.length;
      });
      res.on("end", () => finish(res.statusCode, bytesIn));
      res.on("close", () => finish(res.statusCode, bytesIn));
    });
    req.on("error", (err: Error) => finish(undefined, undefined, err.message));
    req.on("close", () => finish(undefined, undefined, done ? undefined : "closed"));
    return req;
  };
}

function wrapFetch(original: typeof globalThis.fetch): typeof globalThis.fetch {
  return async function patchedFetch(input: any, init?: any): Promise<Response> {
    const h = hooks;
    if (!h) {
      return original(input, init);
    }
    let url: URL | undefined;
    try {
      url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    } catch {
      return original(input, init);
    }
    const protocol = url.protocol === "https:" ? "https" : "http";
    const method = String(init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
    const t = { protocol: protocol as "http" | "https", host: url.hostname.toLowerCase(), port: url.port ? Number(url.port) : undefined, path: url.pathname, method };
    const start = Date.now();
    let decision: Decision = { block: false };
    try {
      decision = h.decide(t);
    } catch {
      /* never block on our own failure */
    }
    if (decision.block) {
      safeObserve(h, { ...t, durationMs: 0, blocked: true, error: decision.reason });
      throw new BlockedByClawPhylax(t.host, decision.reason);
    }
    let bytesOut: number | undefined;
    const body = init?.body;
    if (typeof body === "string") {
      bytesOut = Buffer.byteLength(body);
    } else if (body instanceof Uint8Array) {
      bytesOut = body.byteLength;
    }
    try {
      const res = await original(input, init);
      const len = res.headers.get("content-length");
      safeObserve(h, {
        ...t,
        status: res.status,
        bytesOut,
        bytesIn: len ? Number(len) : undefined,
        durationMs: Date.now() - start,
        blocked: false,
      });
      return res;
    } catch (err: any) {
      safeObserve(h, { ...t, bytesOut, durationMs: Date.now() - start, blocked: false, error: err?.message ?? String(err) });
      throw err;
    }
  };
}

function safeObserve(h: Hooks, o: Observed & { blocked: boolean }): void {
  try {
    h.observe(o);
  } catch {
    /* observability must never break the host */
  }
}

export function installInterceptor(h: Hooks): void {
  hooks = h;
  if (installed) {
    return;
  }
  installed = true;
  originals.httpRequest = http.request;
  originals.httpGet = http.get;
  originals.httpsRequest = https.request;
  originals.httpsGet = https.get;
  originals.fetch = globalThis.fetch;

  const httpReq = wrapRequest("http", originals.httpRequest);
  const httpsReq = wrapRequest("https", originals.httpsRequest);
  (http as any).request = httpReq;
  (https as any).request = httpsReq;
  // http.get calls the module-internal request, so it must be wrapped too.
  (http as any).get = function (a: any, b?: any, c?: any) {
    const req = httpReq.call(http, a, b, c);
    req.end();
    return req;
  };
  (https as any).get = function (a: any, b?: any, c?: any) {
    const req = httpsReq.call(https, a, b, c);
    req.end();
    return req;
  };
  if (typeof originals.fetch === "function") {
    globalThis.fetch = wrapFetch(originals.fetch);
  }
}

export function uninstallInterceptor(): void {
  if (!installed) {
    return;
  }
  (http as any).request = originals.httpRequest;
  (http as any).get = originals.httpGet;
  (https as any).request = originals.httpsRequest;
  (https as any).get = originals.httpsGet;
  if (originals.fetch) {
    globalThis.fetch = originals.fetch;
  }
  installed = false;
  hooks = undefined;
}

export function isInstalled(): boolean {
  return installed;
}
