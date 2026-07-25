---
description: List recent Codex sessions (threads), including ones the Codex picker hides
argument-hint: "[limit or cwd filter — optional]"
allowed-tools: mcp__codex-bridge__codex_list
---

Call the `codex_list` tool from the codex-bridge MCP server to list recent Codex threads.

Arguments (optional): `$ARGUMENTS`
- If a number is given, pass it as `limit`.
- If a path is given, pass it as `cwd` to filter by working directory.
- If empty, use the default (limit 30).

Present the results as a compact table: short id (first 8 chars), source, time, and preview. Point out that any of these ids can be used with `/codex:peek <id>` to read history or `/codex:send <id> <prompt>` to continue the conversation.
