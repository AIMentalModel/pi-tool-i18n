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
      const ps = pSchema as any;
      if (ps.description) out.push({ key: `param:${tool.name}:${pName}`, desc: ps.description });
      if (ps.properties && ps.type === "object") {
        for (const [subName, subSchema] of Object.entries(ps.properties)) {
          const ss = subSchema as any;
          if (ss.description) out.push({ key: `param:${tool.name}:${pName}:${subName}`, desc: ss.description });
        }
      }
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
    translateRequested = false;
  });

  pi.on("before_agent_start", async () => {
    if (translateRequested) return;

    const allTools = pi.getAllTools();
    const untranslated: Array<{ name: string; description: string }> = [];
    const untranslatedParams: Array<{ key: string; desc: string }> = [];

    for (const t of allTools) {
      if (t.description && !translations[t.name]) untranslated.push({ name: t.name, description: t.description });
      for (const p of extractParams(t)) if (!translations[p.key]) untranslatedParams.push(p);
    }

    const skills = scanSkills();
    const untranslatedSkills: Array<{ name: string; description: string }> = [];
    for (const s of skills) { if (!translations[`skill:${s.name}`]) untranslatedSkills.push(s); }

    if (!untranslated.length && !untranslatedSkills.length && !untranslatedParams.length) {
      translateRequested = true;
      return;
    }

    translateRequested = true;
    pendingTools = [
      ...untranslated.map((t) => t.name),
      ...untranslatedSkills.map((s) => `skill:${s.name}`),
      ...untranslatedParams.map((p) => p.key),
    ];

    const lines: string[] = [];
    if (untranslated.length) lines.push("### 工具描述\n" + untranslated.map((t) => `- **${t.name}**: ${t.description}`).join("\n"));
    if (untranslatedSkills.length) lines.push("### 技能描述\n" + untranslatedSkills.map((s) => `- **skill:${s.name}**: ${s.description}`).join("\n"));
    if (untranslatedParams.length) lines.push("### 参数描述\n" + untranslatedParams.map((p) => `- **${p.key}**: ${p.desc}`).join("\n"));

    const prompt =
      `[I18N] 将以下工具描述、技能描述和参数描述翻译为 ${targetLang}。` +
      `技术术语保留英文。回复一个 JSON 对象，键名为条目名，键值为翻译。` +
      `技能键名以 "skill:" 开头，参数键名以 "param:" 开头。\n\n` +
      lines.join("\n\n");

    return {
      message: { customType: "i18n-translate", content: prompt, display: false },
    };
  });

  pi.on("before_agent_start", (event) => {
    let sys = event.systemPrompt;
    let mod = false;
    if (sys.includes("<available_skills>")) {
      for (const [key, tr] of Object.entries(translations)) {
        if (!key.startsWith("skill:")) continue;
        const re = new RegExp(`(<skill>\\s*<name>${escapeRegex(key.slice(6))}<\\/name>\\s*<description>)([^<]+)(<\\/description>)`, "g");
        if (re.test(sys)) { sys = sys.replace(re, `$1${tr}$3`); mod = true; }
      }
    }
    if (mod) return { systemPrompt: sys };
  });

  pi.on("before_provider_request", (event) => {
    const p = event.payload as any;
    if (!p?.tools?.length) return;
    let r = 0;
    for (const t of p.tools) {
      const fn = t.function ?? t;
      const n = fn.name ?? t.name;
      if (!n) continue;
      if (translations[n] && fn.description !== undefined) { fn.description = translations[n]; r++; }
      const props = fn.parameters?.properties;
      if (props && typeof props === "object") {
        for (const [pn, ps] of Object.entries(props)) {
          const k = `param:${n}:${pn}`;
          if (translations[k] && (ps as any).description) { (ps as any).description = translations[k]; r++; }
        }
      }
    }
    if (r > 0) return p;
  });

  pi.on("message_end", async (event) => {
    if (!pendingTools.length) return;
    const msg = event.message;
    if (!msg || msg.role !== "assistant") return;
    let text = "";
    if (typeof msg.content === "string") text = msg.content;
    else if (Array.isArray(msg.content)) {
      text = msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text ?? "").join(" ");
    }
    const jm = text.match(/\{[\s\S]*?\}/);
    if (!jm) return;
    try {
      const parsed = JSON.parse(jm[0]);
      let saved = 0;
      for (const [name, tr] of Object.entries(parsed)) {
        if (typeof tr === "string" && tr && pendingTools.includes(name)) { translations[name] = tr; saved++; }
      }
      if (saved > 0) { saveCache(translations); pendingTools = []; }
    } catch {}
  });

  pi.registerCommand("i18n-retranslate", {
    description: "清除翻译缓存，下次发消息时重新翻译所有工具/技能/参数描述",
    handler: async (_args, ctx) => {
      translations = {}; pendingTools = []; translateRequested = false;
      try { existsSync(CACHE_PATH) && writeFileSync(CACHE_PATH, "{}", "utf-8"); } catch {}
      ctx.ui.notify("🔄 翻译缓存已清除，下条消息将重新翻译", "info");
    },
  });
}
