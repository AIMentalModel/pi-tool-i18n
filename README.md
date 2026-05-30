# pi-tool-i18n

Pi extension — auto-translate core tool descriptions to your system language.

- Detects locale from `$LANG` / `$LC_ALL`
- Translates the 18 core tools (read, bash, edit, write, etc.) via LLM
- Caches results to `~/.pi/agent/tool-i18n.json`
- Skips niche / board tools

## Install

```bash
pi install npm:pi-tool-i18n
```

On first run it'll detect your language and ask the LLM to translate core tool descriptions. Subsequent sessions use the cache.

## License

MIT
