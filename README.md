# pi-tool-i18n

Pi extension — 将工具描述、参数描述和技能描述翻译为系统语言，让 LLM 用目标语言思考。

## 运行机制

### V4（当前版本）：文件落盘

```
session_start: 加载 cache → 扫描缺失 → 写入 i18n-pending.json
before_agent_start: 如果有 pending 文件 → 注入指令让 LLM read→翻译→write
message_end: 读取文件合并到 cache → 删除 pending → notify 进度
```

LLM 用 `read` + `write` 工具直接操作文件，**不受回复截断限制，JSON 解析失败率为零**。

| 替换位置 | 事件 | 键名格式 |
|---|---|---|
| 工具描述 | `before_provider_request` → `tools[].function.description` | `toolname` |
| 参数描述 | `before_provider_request` → `parameters.properties.*.description` | `param:tool:param` |
| 技能描述 | `before_agent_start` → 系统提示词 XML | `skill:name` |

### 文件结构

```
~/.pi/agent/
├── tool-i18n.json          # 翻译缓存（573 条）
└── i18n-pending.json       # 待翻译条目（翻译完成后自动删除）
```

## 安装

```bash
pi install npm:pi-tool-i18n
```

## 命令

| 命令 | 说明 |
|---|---|
| `/i18n-status` | 查看已缓存 / 未翻译数量 |
| `/i18n-translate` | 手动生成 pending 文件并触发翻译 |
| `/i18n-clear` | 清除缓存，下次自动全量重翻 |

## 首次使用

安装后发第一条消息 → LLM 自动读取 pending 文件 → 翻译 → 写回 → 缓存完成。之后永远不再触发 I18N 请求。

新增工具后 `/reload` → 自动增量翻译（只有新增的 2-3 条）。

## License

MIT
