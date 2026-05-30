import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Tool i18n extension — translates tool descriptions to user's system language.
 *
 * Workflow:
 *   1. session_start → load cache only, no LLM calls
 *   2. before_agent_start (first user message) → detect untranslated → request LLM translation via followUp
 *   3. before_provider_request (every LLM call) → replace descriptions with cached translations
 *   4. message_end → parse LLM response, save to cache
 *
 * Translation is lazy — only triggers on first user message, never at startup or during streaming.
 */

const CACHE_PATH = resolve(process.env.HOME ?? "~", ".pi/agent/tool-i18n.json");

function detectLanguage(): string {
  const lang = process.env.LANG ?? process.env.LC_ALL ?? "";
  if (lang.startsWith("zh")) return "中文 (Simplified Chinese)";
  if (lang.startsWith("ja")) return "日本語 (Japanese)";
  if (lang.startsWith("ko")) return "한국어 (Korean)";
  if (lang.startsWith("fr")) return "Français (French)";
  if (lang.startsWith("de")) return "Deutsch (German)";
  if (lang.startsWith("es")) return "Español (Spanish)";
  return "English (English)";
}

function loadCache(): Record<string, string> {
  try {
    if (existsSync(CACHE_PATH)) return JSON.parse(readFileSync(CACHE_PATH, "utf-8"));
  } catch {}
  return {};
}

function saveCache(data: Record<string, string>): void {
  writeFileSync(CACHE_PATH, JSON.stringify(data, null, 2), "utf-8");
}

export default function (pi: ExtensionAPI) {
  const targetLang = detectLanguage();
  let translations: Record<string, string> = {};
  let pendingTools: string[] = [];
  let translateRequested = false;

  // Step 1: load cache at startup
  pi.on("session_start", async () => {
    translations = { ...loadCache() };
    translateRequested = false;
  });

  // Step 2: on first user message, detect untranslated tools and request translation
  // before_agent_start fires when system is idle — followUp messages work here
  pi.on("before_agent_start", async () => {
    if (translateRequested) return;

    const allTools = pi.getAllTools();
    const untranslated: Array<{ name: string; description: string }> = [];

    for (const t of allTools) {
      if (!t.description) continue;
      if (translations[t.name]) continue;
      untranslated.push({ name: t.name, description: t.description });
    }

    if (untranslated.length === 0) {
      translateRequested = true;
      return;
    }

    translateRequested = true;
    pendingTools = untranslated.map((t) => t.name);

    const toolList = untranslated
      .map((t, i) => `${i + 1}. **${t.name}**: ${t.description}`)
      .join("\n");

    pi.sendUserMessage(
      `[System] Translate the following tool descriptions to ${targetLang} (keep technical terms in English):\n\n${toolList}\n\n` +
      `Reply exactly in this format:\n---I18N_START---\n` +
      untranslated.map((t) => `${t.name}|||translation`).join("\n") +
      `\n---I18N_END---`,
      { deliverAs: "followUp" }
    );
  });

  // Step 3: replace descriptions with cached translations on every LLM call
  pi.on("before_provider_request", (event) => {
    const payload = event.payload as any;
    if (!payload?.tools?.length) return;

    let replaced = 0;
    for (const tool of payload.tools) {
      const name = tool?.function?.name ?? tool?.name;
      if (name && translations[name]) {
        if (tool.function) tool.function.description = translations[name];
        else if (tool.description !== undefined) tool.description = translations[name];
        replaced++;
      }
    }

    if (replaced > 0) return payload;
  });

  // Step 4: parse LLM translation response and save to cache
  pi.on("message_end", async (event) => {
    if (pendingTools.length === 0) return;

    const msg = event.message;
    if (!msg || msg.role !== "assistant") return;

    const content = msg.content;
    let text = "";
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      text = content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text ?? "")
        .join("");
    }

    const match = text.match(/---I18N_START---\n([\s\S]*?)\n---I18N_END---/);
    if (!match) return;

    let saved = 0;
    for (const line of match[1].trim().split("\n")) {
      const [name, ...rest] = line.split("|||");
      const translation = rest.join("|||").trim();
      if (name && translation && pendingTools.includes(name.trim())) {
        translations[name.trim()] = translation;
        saved++;
      }
    }

    if (saved > 0) {
      saveCache(translations);
      pendingTools = [];
    }
  });
}
