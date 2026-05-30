import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { execSync } from "node:child_process";

const CACHE_PATH = resolve(process.env.HOME ?? "~", ".pi/agent/tool-i18n.json");
const PENDING_PATH = resolve(process.env.HOME ?? "~", ".pi/agent/i18n-pending.json");
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
  try { writeFileSync(CACHE_PATH, JSON.stringify(data, null, 2), "utf-8"); } catch {}
}

function loadJson(path: string): Record<string, unknown> {
  try { if (existsSync(path)) return JSON.parse(readFileSync(path, "utf-8")); } catch {}
  return {};
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

/** 收集未翻译条目 */
function collectUntranslated(
  tools: ToolInfo[],
  skills: Array<{ name: string; description: string }>,
  translations: Record<string, string>
): { tools: Record<string, string>; skills: Record<string, string>; params: Record<string, string> } {
  const ut: Record<string, string> = {};
  const us: Record<string, string> = {};
  const up: Record<string, string> = {};
  for (const t of tools) { if (t.description && !translations[t.name]) ut[t.name] = t.description; }
  for (const t of tools) { for (const p of extractParams(t)) { if (!translations[p.key]) up[p.key] = p.desc; } }
  for (const s of skills) { if (!translations[`skill:${s.name}`]) us[`skill:${s.name}`] = s.description; }
  return { tools: ut, skills: us, params: up };
}

/** 写入 pending 文件 */
function writePending(ut: Record<string, string>, us: Record<string, string>, up: Record<string, string>): number {
  const pending = { tools: ut, skills: us, params: up };
  const total = Object.keys(ut).length + Object.keys(us).length + Object.keys(up).length;
  if (total === 0) {
    if (existsSync(PENDING_PATH)) unlinkSync(PENDING_PATH);
    return 0;
  }
  writeFileSync(PENDING_PATH, JSON.stringify(pending, null, 2), "utf-8");
  return total;
}

/** 合并 pending 翻译结果到 cache */
function mergePending(): number {
  if (!existsSync(PENDING_PATH)) return 0;
  const pending = loadJson(PENDING_PATH);
  if (!pending || typeof pending !== "object") return 0;

  let merged = 0;
  const translations = loadCache();

  for (const cat of ["tools", "skills", "params"] as const) {
    const obj = pending[cat];
    if (!obj || typeof obj !== "object") continue;
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof val === "string" && val.trim()) {
        translations[key] = val;
        merged++;
      }
    }
  }

  if (merged > 0) saveCache(translations);
  return merged;
}

export default function (pi: ExtensionAPI) {
  const targetLang = detectLanguage();
  let translations: Record<string, string> = {};

  // 1️⃣ 启动时加载 cache，检测缺失，写入 pending 文件
  pi.on("session_start", async () => {
    translations = { ...loadCache() };
    const allTools = pi.getAllTools();
    const skills = scanSkills();
    const missing = collectUntranslated(allTools, skills, translations);
    const total = writePending(missing.tools, missing.skills, missing.params);
  });

  // 2️⃣ before_agent_start: 如果有 pending 文件，注入简短指令
  pi.on("before_agent_start", async (_event, ctx) => {
    if (!existsSync(PENDING_PATH)) return;

    const instruction = `[I18N] 读取 \`~/.pi/agent/i18n-pending.json\`，将其中的工具描述(tools)、技能描述(skills)、参数描述(params)翻译为 ${targetLang}。技术术语保留英文（如 API、CLI、SDK 等）。翻译后写回同一文件覆盖。`;

    return {
      message: { customType: "i18n-translate", content: instruction, display: false },
    };
  });

  // 3️⃣ before_agent_start: 替换 skill 描述到系统提示词
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

  // 4️⃣ provider 请求前替换已有翻译
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

  // 5️⃣ message_end: LLM 完成翻译后，读取文件合并到 cache
  pi.on("message_end", async (_event, ctx) => {
    if (!existsSync(PENDING_PATH)) return;

    const merged = mergePending();
    if (merged > 0) {
      try { unlinkSync(PENDING_PATH); } catch {}
      // 重新加载合并后的 cache
      translations = { ...loadCache() };

      // 检查是否还有遗漏
      const allTools = pi.getAllTools();
      const skills = scanSkills();
      const remaining = collectUntranslated(allTools, skills, translations);
      const remainTotal = writePending(remaining.tools, remaining.skills, remaining.params);

      if (ctx.ui?.notify) {
        if (remainTotal > 0) {
          ctx.ui.notify(`🌐 已保存 ${merged} 条翻译，还剩 ${remainTotal} 条等待下轮处理`, "info");
        } else {
          ctx.ui.notify(`🌐 已保存 ${merged} 条翻译，缓存完整 ✓`, "info");
        }
      }
    }
  });

  // ─── 命令 ───

  // 查看状态
  pi.registerCommand("i18n-status", {
    description: "查看翻译缓存状态",
    handler: async (_args, ctx) => {
      const cached = Object.keys(translations).length;
      const allTools = pi.getAllTools();
      const skills = scanSkills();
      const missing = collectUntranslated(allTools, skills, translations);
      const total = Object.keys(missing.tools).length + Object.keys(missing.skills).length + Object.keys(missing.params).length;
      const hasPending = existsSync(PENDING_PATH);
      ctx.ui.notify(`📊 已缓存: ${cached} 条 | 未翻译: ${total} 条${hasPending ? " | 📝 等待翻译中..." : ""}`, "info");
    },
  });

  // 清除缓存，下次全量重翻
  pi.registerCommand("i18n-clear", {
    description: "清除翻译缓存，下次发送消息时全量重翻",
    handler: async (_args, ctx) => {
      translations = {};
      try {
        if (existsSync(CACHE_PATH)) writeFileSync(CACHE_PATH, "{}", "utf-8");
        if (existsSync(PENDING_PATH)) unlinkSync(PENDING_PATH);
      } catch {}
      // 重新生成 pending
      const allTools = pi.getAllTools();
      const skills = scanSkills();
      const missing = collectUntranslated(allTools, skills, {});
      const total = writePending(missing.tools, missing.skills, missing.params);
      ctx.ui.notify(`🔄 缓存已清除，${total} 条待翻译，下次发消息时自动处理`, "info");
    },
  });

  // 手动强制翻译
  pi.registerCommand("i18n-translate", {
    description: "强制重新生成待翻译文件并触发翻译",
    handler: async (_args, ctx) => {
      const allTools = pi.getAllTools();
      const skills = scanSkills();
      const missing = collectUntranslated(allTools, skills, translations);
      const total = writePending(missing.tools, missing.skills, missing.params);
      if (total === 0) {
        ctx.ui.notify("✅ 所有描述已翻译，无需更新", "info");
      } else {
        ctx.ui.notify(`🌐 已生成 ${total} 条待翻译，下次发消息时自动处理`, "info");
      }
    },
  });
}
