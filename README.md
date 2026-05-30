# pi-tool-i18n

Pi extension — translates tool descriptions, parameter descriptions, and skill descriptions into your system language.

## How it works

On the **first user message** after install/reload, the extension appends an [I18N] translation request to your input. The LLM responds with a JSON object containing all translations, which are cached to `~/.pi/agent/tool-i18n.json`.

After caching, every subsequent LLM call gets:

| What | Where it's replaced | Key format |
|---|---|---|
| Tool descriptions | `before_provider_request` → `tools[].function.description` | `toolname` |
| Parameter descriptions | `before_provider_request` → `parameters.properties.*.description` | `param:tool:param` |
| Skill descriptions | `before_agent_start` → system prompt XML | `skill:name` |

## Install

```bash
pi install npm:pi-tool-i18n
```

## Commands

| Command | What it does |
|---|---|
| `/i18n-retranslate` | Clear cache and trigger a fresh translation on next message |

## First-run timing

The first message after install/reload has English descriptions — the LLM sees the translation request and responds with JSON. **Cache is saved immediately.** Reload once more and everything is in your language.

## License

MIT
