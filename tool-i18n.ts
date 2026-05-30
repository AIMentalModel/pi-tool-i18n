import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 工具描述中文化扩展。
 *
 * - 启动时从 JSON 缓存加载已翻译的工具描述
 * - 自动发现新工具，调用 LLM 一次性翻译
 * - 在 before_provider_request 中替换英文描述为中文
 * - 缓存文件: ~/.pi/agent/tool-i18n.json
 */

const CACHE_PATH = resolve(
  process.env.HOME ?? "~",
  ".pi/agent/tool-i18n.json"
);

// 内置工具的稳定中文翻译（无需 LLM）
const BUILTIN_CN: Record<string, string> = {
  read: "读取文件内容（支持文本和图片）。大文件截断后用 offset/limit 分段读",
  write: "创建或覆盖文件，自动创建父目录",
  edit: "精确文本替换编辑文件，每次调用可包含多个替换块",
  bash: "执行 Shell 命令。输出截断到 2000 行 / 50KB",
  grep: "按内容搜索文件",
  find: "按名称查找文件",
  ls: "列出目录内容",
  web_search: "网络搜索（支持 Perplexity / Exa / Gemini），返回 AI 综合结果带来源引用",
  fetch_content: "抓取网页 / GitHub 仓库 / YouTube 视频为 markdown",
  code_search: "搜索代码示例、API 参考和文档",
  memory_write: "写入记忆文件（长期记忆 MEMORY.md / 日记 / 笔记）",
  memory_read: "读取记忆文件（长期记忆 / 日记 / 笔记 / 便签）",
  memory_search: "搜索所有记忆文件（关键词匹配文件名和内容）",
  scratchpad: "管理待办便签（添加/完成/撤销/清理/列出）",
  subagent: "委派子代理执行任务，支持单代理 / 链式 / 并行 / 异步模式",
  mcp: "MCP 协议网关，连接外部工具服务并调用其工具",
  schedule_prompt: "定时任务调度（cron / 一次性 / 相对时间 / 间隔）",
  propose_goal_draft: "目标提案（创建 /sisyphus 或 /goals 目标的草案）",
  get_goal: "获取当前会话的 pi goal（目标、状态、自动继续、使用量和本地路径）",
  board_create_task: "在看板上创建新任务",
  board_update_task: "更新看板任务",
  board_list_tasks: "列出所有看板任务（可按冲刺/状态/搜索过滤排序）",
  board_get_task: "获取单个看板任务详情",
  board_delete_task: "删除看板任务",
  board_duplicate_task: "复制看板任务",
  board_add_subtask: "为看板任务添加子任务",
  board_toggle_subtask: "切换子任务完成状态",
  board_update_subtask: "更新子任务标题或排序",
  board_delete_subtask: "删除子任务",
  board_add_comment: "为看板任务添加评论",
  board_list_comments: "列出看板任务的所有评论",
  board_delete_comment: "删除看板评论",
  board_create_sprint: "创建新冲刺（自动激活并完成上一个活跃冲刺）",
  board_list_sprints: "列出所有冲刺",
  board_complete_sprint: "完成指定冲刺并将所有任务标记为已完成",
  board_archive_sprint_tasks: "归档冲刺中所有已完成任务",
  board_get_sprint_stats: "获取冲刺统计信息",
  board_get_sprint_burndown: "获取冲刺燃尽图数据",
  board_get_workload: "获取成员工作量概览",
  board_incomplete_sprint: "重新激活已完成的冲刺",
  board_update_sprint: "更新冲刺信息",
  board_delete_sprint: "删除冲刺（如有任务则失败）",
  board_get_sprint: "获取单个冲刺详情",
  board_create_label: "创建新的彩色标签",
  board_list_labels: "列出所有标签",
  board_update_label: "更新标签名称或颜色",
  board_delete_label: "删除标签",
  board_create_person: "创建新成员",
  board_list_columns: "列出所有看板列及其设置",
  board_create_column: "创建新的看板列",
  board_update_column: "更新看板列",
  board_delete_column: "删除看板列（如列中有任务则失败）",
  board_get_board_settings: "获取看板设置（含泳道配置）",
  board_set_board_setting: "设置看板配置项",
  board_list_people: "列出所有成员",
  board_update_person: "更新成员信息",
  board_delete_person: "删除成员（其名下任务取消分配）",
  board_export_json: "导出所有看板数据为 JSON",
  board_import_json: "从 JSON 导入看板数据（替换所有现有数据）",
};

// ── 缓存读写 ──────────────────────────────────
function loadCache(): Record<string, string> {
  try {
    if (existsSync(CACHE_PATH)) {
      return JSON.parse(readFileSync(CACHE_PATH, "utf-8"));
    }
  } catch {}
  return {};
}

function saveCache(data: Record<string, string>): void {
  writeFileSync(CACHE_PATH, JSON.stringify(data, null, 2), "utf-8");
}

// ── 扩展入口 ──────────────────────────────────
export default function (pi: ExtensionAPI) {
  let translations: Record<string, string> = {};
  let pendingTools: string[] = [];
  let translateRequested = false;

  // ── 启动：加载缓存、发现未翻译工具 ──────────
  pi.on("session_start", async (_event) => {
    translations = { ...BUILTIN_CN, ...loadCache() };

    const allTools = pi.getAllTools();
    const untranslated: Array<{ name: string; description: string }> = [];

    for (const t of allTools) {
      if (!translations[t.name] && t.description) {
        untranslated.push({ name: t.name, description: t.description });
      }
    }

    if (untranslated.length > 0 && !translateRequested) {
      pendingTools = untranslated.map((t) => t.name);
      translateRequested = true;

      const toolList = untranslated
        .map((t, i) => `${i + 1}. **${t.name}**: ${t.description}`)
        .join("\n");

      // 发送翻译请求给 LLM
      pi.sendUserMessage(
        `[系统指令] 将以下工具描述翻译为简洁中文（保留技术术语的英文原名）：\n\n${toolList}\n\n` +
          `请严格按此格式回复（每行一个，不要额外文字）：\n` +
          `---I18N_START---\n` +
          untranslated.map((t) => `${t.name}|||中文翻译`).join("\n") +
          `\n---I18N_END---`,
        { deliverAs: "followUp", triggerTurn: true }
      );
    }
  });

  // ── 拦截翻译结果并保存 ──────────────────────
  pi.on("message_end", async (event) => {
    if (pendingTools.length === 0) return;

    const msg = event.message;
    if (!msg || msg.role !== "assistant") return;

    const content = msg.content;
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text ?? "")
        .join("");
    }

    const match = text.match(/---I18N_START---\n([\s\S]*?)\n---I18N_END---/);
    if (!match) return;

    const lines = match[1].trim().split("\n");
    let saved = 0;
    for (const line of lines) {
      const [name, ...rest] = line.split("|||");
      const translation = rest.join("|||").trim();
      if (name && translation && pendingTools.includes(name.trim())) {
        translations[name.trim()] = translation;
        saved++;
      }
    }

    if (saved > 0) {
      // 只保存非内置的翻译（内置的基础翻译不写回文件）
      const toSave: Record<string, string> = {};
      for (const [k, v] of Object.entries(translations)) {
        if (!(k in BUILTIN_CN)) {
          toSave[k] = v;
        }
      }
      saveCache(toSave);
      pendingTools = [];
    }
  });

  // ── 拦截 provider 请求，替换工具描述 ────────
  pi.on("before_provider_request", (event) => {
    const payload = event.payload as any;
    if (!payload?.tools?.length) return;

    let replaced = 0;
    for (const tool of payload.tools) {
      const name = tool?.function?.name ?? tool?.name;
      if (name && translations[name]) {
        if (tool.function) {
          tool.function.description = translations[name];
        } else if (tool.description !== undefined) {
          tool.description = translations[name];
        }
        replaced++;
      }
    }

    // 返回修改后的 payload（undefined 表示不改）
    if (replaced > 0) {
      return payload;
    }
  });
}
