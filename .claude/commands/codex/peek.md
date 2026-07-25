---
description: Read a Codex thread's conversation history (no resume, no token cost)
argument-hint: "<threadId> [maxTurns]"
allowed-tools: mcp__codex-bridge__codex_read
---

Call the `codex_read` tool from the codex-bridge MCP server to read a Codex thread's history WITHOUT resuming it (this is free — no Codex model call).

Parse `$ARGUMENTS`:
- First token = `threadId` (a UUID, or a short prefix the user pasted — if it is a prefix, first run `codex_list` to resolve it to a full id).
- Optional second token = `maxTurns` (default 20).

After reading, summarize for the user what that Codex session has been about and what its latest state is. Do not dump the entire raw history unless asked — give a useful digest, and offer `/codex:send <id> <prompt>` to continue it.
