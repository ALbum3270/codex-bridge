---
description: Send a prompt into an existing Codex thread and get Codex's reply (writes back to the original session)
argument-hint: "<threadId> <prompt>   (prefix with --write to allow file edits)"
allowed-tools: mcp__codex-bridge__codex_send, mcp__codex-bridge__codex_list
---

Call the `codex_send` tool from the codex-bridge MCP server to continue an existing Codex thread. This resumes the thread from disk, runs one turn inside Codex, and appends the result to the ORIGINAL Codex session (visible in the Codex app).

Parse `$ARGUMENTS`:
- First token = `threadId` (UUID or short prefix; if a prefix, resolve it with `codex_list` first).
- If the arguments contain the flag `--write`, pass `write: true` (lets Codex edit files; default is read-only). Strip the flag from the prompt.
- Everything else = the `prompt` to send.

Cost note: Codex reloads the thread's full history each call, so a long thread costs Codex-side tokens even for a short prompt. Warn the user before sending into a very large thread.

After the tool returns, relay to the user: Codex's final reply, plus any commands it ran and files it changed. If `write` was used and files changed, remind the user those edits happened on disk in the thread's cwd.
