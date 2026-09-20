// Host classification and the built-in suspicious-host list.

import type { Category, PluginConfig } from "./types.js";

const MODEL_HOSTS = [
  "api.anthropic.com",
  "api.openai.com",
  "generativelanguage.googleapis.com",
  "api.mistral.ai",
  "api.cohere.com",
  "api.groq.com",
  "api.together.xyz",
  "api.fireworks.ai",
  "openrouter.ai",
  "api.deepseek.com",
  "api.x.ai",
  "bedrock-runtime",
  "aiplatform.googleapis.com",
  "openai.azure.com",
  "api.perplexity.ai",
  "api.z.ai",
  "open.bigmodel.cn",
];

const CHANNEL_HOSTS = [
  "api.telegram.org",
  "discord.com",
  "discordapp.com",
  "gateway.discord.gg",
  "slack.com",
  "graph.microsoft.com",
  "signal.org",
  "whatsapp.net",
  "web.whatsapp.com",
  "open.feishu.cn",
  "api.line.me",
  "matrix.org",
  "mattermost",
];

// Services that are legitimate in general but are the classic drop points for
// silent exfiltration from an agent. Contacting one is not proof of abuse; it
// is worth a look every time.
export const BUILTIN_SUSPICIOUS = [
  "pastebin.com",
  "paste.ee",
  "hastebin.com",
  "dpaste.com",
  "ghostbin",
  "transfer.sh",
  "file.io",
  "0x0.st",
  "gofile.io",
  "anonfiles.com",
  "catbox.moe",
  "webhook.site",
  "requestbin",
  "pipedream.net",
  "hookbin.com",
  "beeceptor.com",
  "burpcollaborator.net",
  "oast.fun",
  "oast.pro",
  "oast.me",
  "interact.sh",
  "canarytokens.com",
  "ngrok.io",
  "ngrok-free.app",
  "ngrok.app",
  "trycloudflare.com",
  "loca.lt",
  "serveo.net",
  "telegra.ph",
  "discord.com/api/webhooks",
  "ipify.org",
  "ifconfig.me",
  "icanhazip.com",
];

export function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || /^\[?[0-9a-f:]+\]?$/i.test(host);
}

export function isPrivateOrLocal(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h === "::1" || h === "[::1]") {
    return true;
  }
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) {
    return true;
  }
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^169\.254\./.test(h) || h === "0.0.0.0") {
    return true;
  }
  return false;
}

function matches(host: string, patterns: string[]): boolean {
  const h = host.toLowerCase();
  return patterns.some((p) => {
    const q = p.toLowerCase();
    return h === q || h.endsWith("." + q) || h.includes(q);
  });
}

export function classifyHost(host: string, cfg: PluginConfig): Category {
  if (!host) {
    return "external";
  }
  if (matches(host, cfg.allowlist)) {
    return matches(host, MODEL_HOSTS) ? "model" : "external";
  }
  // An operator's own denylist outranks every built-in category, including local.
  if (matches(host, cfg.denylist)) {
    return "suspicious";
  }
  if (isPrivateOrLocal(host)) {
    return "local";
  }
  if (matches(host, BUILTIN_SUSPICIOUS)) {
    return "suspicious";
  }
  if (matches(host, MODEL_HOSTS)) {
    return "model";
  }
  if (matches(host, CHANNEL_HOSTS)) {
    return "channel";
  }
  return "external";
}

export function isAllowlisted(host: string, cfg: PluginConfig): boolean {
  return matches(host, cfg.allowlist);
}
