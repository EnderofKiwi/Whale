# Whale

Whale is an AI agent built on the DeepSeek Harness (DSH): terminal commands, an
interactive chat, an HTTP gateway with channels (WeChat first), skills, and
cross-session persistent memory.

## Features

- Terminal chat and one-shot tasks
- HTTP gateway + channels (`whale serve`), including a WeChat ClawBot channel
- Local web UI (`whale web-ui start`)
- Skills: list / find / install (`whale skills`)
- Persistent memory: the agent automatically remembers preferences and facts
  across sessions via the `memory` tool
- Runtime diagnostics (`whale doctor` / `whale status`)

## Install

npm (recommended):

```powershell
npm install -g whale-agent
```

GitHub (no npm account needed):

```powershell
npx --yes github:EnderofKiwi/Whale setup
```

After installing, run `whale` once — the first run guides you through choosing a
model provider and entering your API key.

## Usage

```powershell
whale chat              # interactive terminal conversation
whale run "task"        # one-shot task
whale serve --port 4173 # gateway + channels (WeChat)
whale web-ui start      # local web UI (background gateway + browser)
whale skills            # list / find / install skills
whale doctor            # runtime diagnostics
```

You can also drive the underlying profile directly:

```powershell
dsh --profile whale run "task"
dsh --profile whale chat
```

## Configuration

- Model: `whale models` (default `deepseek-v4-pro`, reuses `DEEPSEEK_API_KEY`)
- Memory: `$DSH_HOME/memories/MEMORY.md` (agent notes) + `USER.md` (user profile)
- Skills root: `WHALE_SKILLS` env var
- WeChat (native Tencent iLink Bot API, one-time QR login on `serve`):
  - `WHALE_WECHAT_BOT_TOKEN` — pre-supply a token instead of scanning
  - `WHALE_WECHAT_TOKEN_FILE` — token persistence (default `$DSH_HOME/whale-wechat-token.json`)
  - `WHALE_WECHAT_BASE_URL` — API base (default `https://ilinkai.weixin.qq.com`)
  - `WHALE_WECHAT_MODEL` — model for WeChat replies (default `deepseek-v4-flash`)

## Layout

```
whale/
  bin/        CLI entry points (whale.js / whale.ps1 / whale.cmd)
  lib/        agent, CLI, gateway, channels, memory
  profile/    DSH profile (cordis plugin wiring)
  skills/     built-in skills
  webui/      local web UI
  scripts/    install helper
```
