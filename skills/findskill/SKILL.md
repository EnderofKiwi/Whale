---
name: findskill
description: Discover AI agent skills by searching GitHub for SKILL.md repos, ranked by star count, then install a chosen one. Use whenever the user asks to find, search, recommend, or install skills, or when a task would benefit from a specialized skill.
whenToUse: When the user wants to discover popular skills, search for a skill by keyword, or install a found skill; when a task needs a specialized skill.
---

# findskill

Whale discovers skills the same way the findskill skill does: search GitHub for
SKILL.md repos and rank by star count (stars = the popularity signal).

## Commands

- `whale skills find` — list popular skill repos (ranked by GitHub stars).
- `whale skills find <keywords>` — search skill repos by keyword.
- `whale skills list` — list skills currently installed in Whale.
- `whale skills install <path>` — install a local skill folder or a pack
  (a folder of skill folders) into `$DSH_HOME/skills/`.
- `whale skills uninstall <name>` — remove a user-installed skill.

Run these through the `pwsh` tool. If `whale` is not on PATH, use
`whale.ps1` from the package's `bin/` (or `dsh --profile whale`) instead.

## Workflow

1. When the user wants skills, run `whale skills find` (popular) or
   `whale skills find "<query>"` (search).
2. Present the results: repo name, stars (★), description, GitHub URL.
3. If the user picks one, clone/download it and install via
   `whale skills install <path>`.

## Notes

- Backend: GitHub search API (`api.github.com/search/repositories`), ranked by
  `sort=stars`. Set `GITHUB_TOKEN` to raise the anonymous rate limit (10 search/hour).
- GitHub may be unreachable (blocked/proxy). If `whale skills find` fails with a
  connection/TLS error, tell the user to fix their proxy/VPN or set GITHUB_TOKEN,
  and fall back to local install.
