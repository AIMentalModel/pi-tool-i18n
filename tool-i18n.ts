import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { execSync } from "node:child_process";

const CACHE_PATH = resolve(process.env.HOME ?? "~", ".pi/agent/tool-i18n.json");
const SKILLS_DIR = resolve(process.env.HOME ?? "~", ".agents/skills");

const LANG_MAP: Record<string, string> = {
  zh: "中文 (Simplified Chinese)", ja: "日本語 (Japanese)", ko: "한국어 (Korean)",
  fr: "Français (French)", de: "Deutsch (German)", es: "Español (Spanish)",
};

function matchLang(code: string): string | null {
  for (const [p, n] of Object.entries(LANG_MAP)) { if (code.startsWith(p)) return n; }
  return null;
}

function detectLanguage(): string {
  const env = process.env.LANG ?? process.env.LC_ALL ?? process.env.LANGUAGE ?? "";
  const fromEnv = matchLang(env);
  if (fromEnv) return fromEnv;
  if (!env || /^C(\.|$)|^POSIX/.test(env)) {
    try {
      if (process.platform === "darwin") {
        const locale = execSync("defaults read -g AppleLocale 2>/dev/null || echo ''", { encoding: "utf-8", timeout: 1000 }).trim();
        const fromMac = matchLang(locale);
        if (fromMac) return fromMac;
      } else if (process.platform === "linux") {
        const out = execSync("locale 2>/dev/null | grep -i lang || cat /etc/locale.conf 2>/dev/null | grep LANG || echo ''", { encoding: "utf-8", timeout: 1000 });
        const fromLinux = matchLang(out);
        if (fromLinux) return fromLinux;
      }
    } catch {}
  }
  return "English (English)";
}

function loadCache(): Record<string, string> {
  try { if (existsSync(CACHE_PATH)) return JSON.parse(readFileSync(CACHE_PATH, "utf-8")); } catch {}
  return {};
}

function saveCache(data: Record<string, string>): void {
  writeFileSync(CACHE_PATH, JSON.stringify(data, null, 2), "utf-8");
}

function scanSkills(): Array<{ name: string; description: string }> {
  const skills: Array<{ name: string; description: string }> = [];
  try {
    if (!existsSync(SKILLS_DIR)) return skills;
    for (const dir of readdirSync(SKILLS_DIR)) {
      const skillPath = join(SKILLS_DIR, dir, "SKILL.md");
      if (!existsSync(skillPath)) continue;
      const content = readFileSync(skillPath, "utf-8");
      const nameMatch = content.match(/^---\n[\s\S]*?\bname:\s*(.+)\n[\s\S]*?\n---/);
      const descMatch = content.match(/^---\n[\s\S]*?\bdescription:\s*(?:>\s*\n)?\s*(.+?)\n[\s\S]*?\n---/);
      if (nameMatch && descMatch) {
        const name = nameMatch[1].trim();
        const desc = descMatch[1].trim().replace(/\n\s+/g, " ");
        if (desc) skills.push({ name, description: desc });
      }
    }
  } catch {}
  return skills;
}

function extractParams(tool: ToolInfo): Array<{ key: string; desc: string }> {
  const out: Array<{ key: string; desc: string }> = [];
  try {
    const params = (tool.parameters as any) ?? {};
    const props = params.properties ?? params.input_schema?.properties ?? {};
    for (const [pName, pSchema] of Object.entries(props)) {
      const desc = (pSchema as any)?.description;
      if (desc) out.push({ key: `param:${tool.name}:${pName}`, desc });
    }
  } catch {}
  return out;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export default function (pi: ExtensionAPI) {
  const targetLang = detectLanguage();
  let translations: Record<string, string> = {};
  let pendingTools: string[] = [];
  let translateRequested = false;

  pi.on("session_start", async () => {
    translations = { ...loadCache() };
    // 如果缓存中有 _initialized 标记，不再自动触发翻译
    translateRequested = !!translations["_initialized"];
  });

  pi.on("input", (event) => {
    // 只自动触发一次翻译，未覆盖的走 /i18n-retranslate
    if (translateRequested) return { action: "continue" };

    const allTools = pi.getAllTools();
    const untranslated: Array<{ name: string; description: string }> = [];
    const untranslatedParams: Array<{ key: string; desc: string }> = [];

    for (const t of allTools) {
      if (t.description && !translations[t.name]) {
        untranslated.push({ name: t.name, description: t.description });
      }
      for (const p of extractParams(t)) {
        if (!translations[p.key]) untranslatedParams.push(p);
      }
    }

    const skills = scanSkills();
    const untranslatedSkills: Array<{ name: string; description: string }> = [];
    for (const s of skills) {
      const key = `skill:${s.name}`;
      if (!translations[key]) untranslatedSkills.push(s);
    }

    if (untranslated.length === 0 && untranslatedSkills.length === 0 && untranslatedParams.length === 0) {
      translateRequested = true;
      return { action: "continue" };
    }

    translateRequested = true;
    pendingTools = [
      ...untranslated.map((t) => t.name),
      ...untranslatedSkills.map((s) => `skill:${s.name}`),
      ...untranslatedParams.map((p) => p.key),
    ];

    const lines: string[] = [];
    if (untranslated.length > 0) {
      lines.push("### 工具描述\n" + untranslated.map((t) => `- **${t.name}**: ${t.description}`).join("\n"));
    }
    if (untranslatedSkills.length > 0) {
      lines.push("### 技能描述\n" + untranslatedSkills.map((s) => `- **skill:${s.name}**: ${s.description}`).join("\n"));
    }
    if (untranslatedParams.length > 0) {
      lines.push("### 参数描述\n" + untranslatedParams.map((p) => `- **${p.key}**: ${p.desc}`).join("\n"));
    }

    const translatePrompt =
      `\n\n[I18N] 将以下工具描述、技能描述和参数描述翻译为 ${targetLang}。` +
      `技术术语保留英文。回复 JSON 对象，键名为条目名，键值为翻译。` +
      `技能键名以 "skill:" 开头，参数键名以 "param:" 开头。\n\n` +
      lines.join("\n\n");

    return { action: "transform", text: event.text + translatePrompt };
  });

  pi.on("before_agent_start", (event) => {
    let sysPrompt = event.systemPrompt;
    let modified = false;

    if (sysPrompt.includes("<available_skills>")) {
      for (const [key, translation] of Object.entries(translations)) {
        if (!key.startsWith("skill:")) continue;
        const skillName = key.slice(6);
        const regex = new RegExp(`(<skill>\\s*<name>${escapeRegex(skillName)}<\\/name>\\s*<description>)([^<]+)(<\\/description>)`, "g");
        if (regex.test(sysPrompt)) {
          sysPrompt = sysPrompt.replace(regex, `$1${translation}$3`);
          modified = true;
        }
      }
    }

    if (modified) return { systemPrompt: sysPrompt };
  });

  pi.registerCommand("i18n-retranslate", {
    description: "清除翻译缓存，下次发消息时重新翻译所有工具/技能/参数描述",
    handler: async (_args, ctx) => {
      translations = {};
      pendingTools = [];
      translateRequested = false;
      try { existsSync(CACHE_PATH) && writeFileSync(CACHE_PATH, "{}"); } catch {}
      ctx.ui.notify("🔄 翻译缓存已清除，下条消息将重新翻译", "info");
    },
  });

  pi.on("before_provider_request", (event) => {
    const payload = event.payload as any;
    if (!payload?.tools?.length) return;
    let replaced = 0;

    for (const tool of payload.tools) {
      const fn = tool.function ?? tool;
      const name = fn.name ?? tool.name;
      if (!name) continue;

      if (translations[name] && fn.description !== undefined) {
        fn.description = translations[name];
        replaced++;
      }

      const props = fn.parameters?.properties;
      if (props && typeof props === "object") {
        for (const [pName, pSchema] of Object.entries(props)) {
          const key = `param:${name}:${pName}`;
          if (translations[key] && (pSchema as any).description) {
            (pSchema as any).description = translations[key];
            replaced++;
          }
        }
      }
    }

    if (replaced > 0) return payload;
  });

  pi.on("message_end", async (event) => {
    if (pendingTools.length === 0) return;
    const msg = event.message;
    if (!msg || msg.role !== "assistant") return;

    let text = "";
    if (typeof msg.content === "string") text = msg.content;
    else if (Array.isArray(msg.content)) {
      text = (msg.content as any[])
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text ?? "")
        .join(" ");
    }

    const jsonMatch = text.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) return;

    try {
      const parsed = JSON.parse(jsonMatch[0]);
      let saved = 0;
      for (const [name, translation] of Object.entries(parsed)) {
        if (typeof translation === "string" && translation && pendingTools.includes(name)) {
          translations[name] = translation;
          saved++;
        }
      }
      if (saved > 0) {
        translations["_initialized"] = "1";
        saveCache(translations);
        pendingTools = [];
      }
    } catch {}
  });
}
