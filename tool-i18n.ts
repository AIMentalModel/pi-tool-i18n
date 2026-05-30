import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
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

/** Scan skill directories for descriptions */
function scanSkills(): Array<{ name: string; description: string }> {
  const skills: Array<{ name: string; description: string }> = [];
  try {
    if (!existsSync(SKILLS_DIR)) return skills;
    for (const dir of readdirSync(SKILLS_DIR)) {
      const skillPath = join(SKILLS_DIR, dir, "SKILL.md");
      if (!existsSync(skillPath)) continue;
      const content = readFileSync(skillPath, "utf-8");
      // Parse frontmatter
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

export default function (pi: ExtensionAPI) {
  const targetLang = detectLanguage();
  let translations: Record<string, string> = {};
  let pendingTools: string[] = [];
  let translateRequested = false;

  pi.on("session_start", async () => {
    translations = { ...loadCache() };
    translateRequested = false;
  });

  // Inject translation request (tools + skills) into first user message
  pi.on("input", (event) => {
    if (translateRequested) return { action: "continue" };

    const allTools = pi.getAllTools();
    const untranslated: Array<{ name: string; description: string }> = [];

    for (const t of allTools) {
      if (!t.description) continue;
      if (translations[t.name]) continue;
      untranslated.push({ name: t.name, description: t.description });
    }

    // Also check skills
    const skills = scanSkills();
    const untranslatedSkills: Array<{ name: string; description: string }> = [];
    for (const s of skills) {
      const key = `skill:${s.name}`;
      if (translations[key]) continue;
      untranslatedSkills.push(s);
    }

    if (untranslated.length === 0 && untranslatedSkills.length === 0) {
      translateRequested = true;
      return { action: "continue" };
    }

    translateRequested = true;
    pendingTools = [
      ...untranslated.map((t) => t.name),
      ...untranslatedSkills.map((s) => `skill:${s.name}`),
    ];

    const lines: string[] = [];
    if (untranslated.length > 0) {
      lines.push("### 工具描述\n" + untranslated.map((t) => `- **${t.name}**: ${t.description}`).join("\n"));
    }
    if (untranslatedSkills.length > 0) {
      lines.push("### 技能描述\n" + untranslatedSkills.map((s) => `- **skill:${s.name}**: ${s.description}`).join("\n"));
    }

    const translatePrompt =
      `\n\n[I18N] 将以下工具描述和技能描述翻译为 ${targetLang}。` +
      `技术术语（如 bash、LLM、MCP）保留英文。` +
      `回复一个 JSON 对象，键名为工具/技能名，键值为翻译。` +
      `技能键名以 "skill:" 开头。\n\n` +
      lines.join("\n\n");

    return { action: "transform", text: event.text + translatePrompt };
  });

  // Replace skill descriptions in system prompt
  pi.on("before_agent_start", (event) => {
    let sysPrompt = event.systemPrompt;
    let modified = false;

    // Replace skill descriptions in <available_skills>
    if (sysPrompt.includes("<available_skills>")) {
      for (const [key, translation] of Object.entries(translations)) {
        if (!key.startsWith("skill:")) continue;
        const skillName = key.slice(6);
        // Match <skill><name>skillName</name><description>...</description>
        const regex = new RegExp(
          `(<skill>\\s*<name>${escapeRegex(skillName)}<\\/name>\\s*<description>)([^<]+)(<\\/description>)`,
          "g"
        );
        if (regex.test(sysPrompt)) {
          sysPrompt = sysPrompt.replace(regex, `$1${translation}$3`);
          modified = true;
        }
      }
    }

    if (modified) return { systemPrompt: sysPrompt };
  });

  // Replace tool descriptions in provider payload
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

  // Parse translation response
  pi.on("message_end", async (event) => {
    if (pendingTools.length === 0) return;
    const msg = event.message;
    if (!msg || msg.role !== "assistant") return;

    const content = msg.content;
    let text = "";
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      text = content.filter((c: any) => c.type === "text").map((c: any) => c.text ?? "").join(" ");
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
      if (saved > 0) { saveCache(translations); pendingTools = []; }
    } catch {}
  });
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
