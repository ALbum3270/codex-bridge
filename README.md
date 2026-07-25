# codex-bridge

Let **Claude Code read and continue existing Codex sessions**.

List your Codex threads, read any thread's full history for free, and send new prompts
into one — the reply is appended to the **original** Codex session, so it shows up in the
Codex app exactly as if you had typed it there yourself.

Zero dependencies. One file to register. Works on threads created by *any* Codex process
(VS Code extension, `codex` CLI, `codex exec`).

```
you ──> Claude Code ──> codex-bridge ──> codex app-server ──> ~/.codex/sessions/*.jsonl
                                                                    (your real threads)
```

## Why this exists

The obvious approaches don't work for *pre-existing* sessions:

| Approach | Problem |
|---|---|
| `codex mcp-server` + `codex-reply` | Only knows threads created in *its own* process — replying to a thread from another Codex instance fails with `Session not found` ([openai/codex#12596](https://github.com/openai/codex/issues/12596)) |
| `codex exec resume` | Works, but you only get the final answer — no visibility into commands run or files changed |

`codex app-server` exposes `thread/resume`, which **rehydrates a thread from disk by id**.
That is the missing piece, and it's what this bridge is built on.

## Requirements

- **Codex CLI ≥ 0.145.0** (`codex --version`)
- **Node 18+**
- No `npm install` — there are no dependencies

The bridge locates Codex's `codex.js` automatically: it follows the `codex` on your `PATH`
first (which is what version managers like nvm, fnm and volta rely on), then falls back to
the standard global install paths, preferring one whose per-platform binary is actually
present. Override with the `CODEX_JS` env var to pin a specific install.

Keep the CLI current: `codex_start` opens threads with your account's **default** model, and
a CLI older than that model rejects the turn outright (`The '<model>' model requires a newer
version of Codex`). Resumed threads hide this — they carry the model they were created with.

## Install

```bash
git clone https://github.com/ALbum3270/codex-bridge.git
```

Then register it with Claude Code — either **per project**, by adding to `.mcp.json` in
your project root:

```json
{
  "mcpServers": {
    "codex-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/codex-bridge/mcp-server.js"]
    }
  }
}
```

…or **globally**, so every session gets it:

```bash
claude mcp add --scope user codex-bridge -- node /absolute/path/to/codex-bridge/mcp-server.js
```

**Restart your Claude Code session** — MCP servers are loaded at startup.

## Tools

| Tool | What it does | Cost |
|---|---|---|
| `codex_list` | List recent threads — including `exec`/subagent sessions the Codex picker hides | free |
| `codex_read` | Read a thread's history **without resuming it** | free — no model call |
| `codex_send` | Resume a thread from disk and run one turn; returns the reply, commands executed and files changed | Codex-side tokens |
| `codex_start` | Create a **new** thread and run its first turn; returns the new thread id | Codex-side tokens |

`codex_send` and `codex_start` run with `approvalPolicy: never` and a **read-only** sandbox
by default, so unattended turns never hang on an approval prompt. Pass `write: true` for a
`workspace-write` sandbox when you want Codex to actually edit files.

A turn can end `failed` or `interrupted`, not just `completed`. Those are reported as
`!! Turn did not complete: status=… — <reason>` rather than as a successful turn that
happened to say nothing.

Threads made by `codex_start` are ordinary sessions — they land in `~/.codex/sessions`,
show up in the Codex app and in `codex_list`, and `codex_send` continues them. Pass `cwd`
explicitly; it otherwise defaults to the bridge process's working directory, which is
rarely what you want. `model` follows your Codex default unless you override it.

Because `codex_send` makes Codex reload the thread's entire history, a short prompt into a
long thread still costs real tokens. `codex_read` is free — prefer it when you only need
to *look*.

## Slash commands (optional)

Copy [`.claude/commands/codex/`](.claude/commands/codex) into your project (or
`~/.claude/commands/codex/`) to get:

- `/codex:list [limit|cwd]`
- `/codex:peek <threadId> [maxTurns]`
- `/codex:send <threadId> <prompt>` — add `--write` to allow file edits

## How it works

It's a protocol adapter between two stdio JSON-RPC dialects:

| File | Role |
|---|---|
| `appserver-client.js` | Spawns `codex app-server --stdio`, speaks its JSON-RPC, streams notifications |
| `codex-ops.js` | The four operations, built on `thread/list`, `thread/read`, `thread/resume`, `thread/start` + `turn/start` |
| `mcp-server.js` | A hand-rolled MCP server (`initialize` / `tools/list` / `tools/call`) — this is why there are no dependencies |
| `cb.js` | CLI over the same ops, so you can exercise them without restarting the MCP server: `node cb.js list \| read <id> \| send <id> "prompt" \| start "prompt" [cwd]` |
| `smoke.js` | Manual test: `node smoke.js list \| read <id> \| send <id> "prompt"` |

Two details worth knowing if you fork this:

- **Server→client requests must be answered.** `app-server` can ask *you* things
  (approvals, elicitations). If you ignore those, the turn hangs forever. The client
  auto-replies to keep unattended runs alive.
- **`sourceKinds` must be passed explicitly** to `thread/list`. Omit it and the server
  quietly returns interactive sessions only, hiding every `codex exec` and subagent thread.
- **`source` is a tagged enum, not a string.** Unit variants serialize as bare strings
  (`"cli"`, `"vscode"`), variants carrying data as single-key objects
  (`{subAgent:{other:'guardian'}}`). Interpolating it directly renders `[object Object]`
  for every subagent thread — run it through `formatSource()`.
- **Sub-agent and forked threads replay their parent's history**, so listings contain rows
  with near-identical previews that are not duplicates. `parentThreadId` / `forkedFromId`
  are what tell them apart.

## Limitations

- Cloud Codex sessions (web / cloud tasks) never touch local disk, so they're invisible here.
- One `app-server` process is spawned per call — a few hundred ms of startup, in exchange
  for no shared state between calls.
- **Approval policy is deliberately not exposed.** Turns are pinned to `never`. The client
  auto-answers server→client requests with an empty result, which is not a real approval
  decision — offering `on-request` here would just hang the turn. Exposing it means
  implementing `onServerRequest` properly first.

## License

MIT
