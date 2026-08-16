---
name: terminal-workflow
description: Drive Whale from the terminal — one-shot `run`, interactive `chat`, the `serve` gateway, and the read-only diagnostics (`doctor`, `status`, `skills`, `version`).
whenToUse: When the user wants to run Whale from the command line or asks how to operate this agent.
---

# Whale terminal workflow

Whale is a profile of the DeepSeek Harness, launched as
`dsh --profile whale <subcommand>`.

## Commands

- `dsh --profile whale run "task"` — one task, print the reply, exit.
- `dsh --profile whale chat` — interactive terminal conversation (default).
- `dsh --profile whale serve --port 4173` — start the HTTP gateway + channels.
- `dsh --profile whale web-ui start [--port N]` — start the gateway silently in the background and open the local web chat UI; `web-ui stop` / `web-ui status` manage it.
- `dsh --profile whale doctor` — runtime diagnostics.
- `dsh --profile whale status` — registered channels and gateway status.
- `dsh --profile whale skills` — interactive menu: list installed, or find popular/related skills.
- `dsh --profile whale skills list` — list installed skills (tagged `[user]`/`[shipped]`).
- `dsh --profile whale skills find [query]` — search GitHub for SKILL.md repos (ranked by stars): popular by default, or search by keyword.
- `dsh --profile whale skills install <path>` — install a skill or a pack (a folder of skill folders) into `$DSH_HOME/skills/`.
- `dsh --profile whale skills uninstall <name>` — remove a user-installed skill.
- `dsh --profile whale models` — interactive model config: choose a provider (the DSH vendor list), enter its API key, then pick one of that provider's models. `models list` prints the current catalog; `models use <provider> <model>` / `models wechat <model>` are quick non-interactive shortcuts.
- `dsh --profile whale help` — show help.

## Gateway API

- `POST /v1/message` with `{ "text": "...", "session": "optional" }` -> `{ "reply": "..." }`
- `GET /v1/channels` -> registered channels
- `POST /v1/channels/wechat/webhook` -> WeChat ClawBot inbound

## Notes

- One `chat` session keeps one persistent agent; each gateway conversation key
  keeps its own agent session.
- Gateway conversations are cached with LRU + TTL eviction (`WHALE_MAX_CONVERSATIONS`,
  `WHALE_CONVERSATION_TTL_MINUTES`). Evicted sessions are flushed to disk and
  resumed from the same deterministic session id when the conversation returns,
  so context survives eviction and gateway restarts.
- Skills ship under `whale/skills/` (shipped) and are registered through the
  base `skill-filesystem` provider via `customSkillDirs`; user skills live in
  `$DSH_HOME/skills/` and are installed with `skills install` (a "合集" is just a
  folder containing multiple skill folders).
