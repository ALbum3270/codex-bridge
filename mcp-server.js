'use strict';
// Zero-dependency MCP server (stdio JSON-RPC) exposing Codex session tools to
// Claude Code. Wraps codex-ops, which talks to `codex app-server`.
//
// Tools:
//   codex_list  { limit?, cwd? }                    -> recent Codex threads
//   codex_read  { threadId, maxTurns? }             -> thread history (no resume, no token cost)
//   codex_send  { threadId, prompt, write?, model?, effort? }
//                                                    -> resume + new turn, returns Codex output

const ops = require('./codex-ops');

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'codex-bridge', version: '0.1.0' };

const TOOLS = [
  {
    name: 'codex_list',
    description:
      'List recent Codex CLI/IDE sessions (threads) from local storage, including sessions the Codex picker hides (exec/subagent). Returns id, name, preview, cwd, source, last-activity time, status, and lineage. Sub-agent and forked threads replay their parent\'s history, so several rows sharing near-identical previews is normal — the "child of / forked from" line says which thread each came from. Read-only, no token cost.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max threads to return (default 30).' },
        cwd: { type: 'string', description: 'Optional: only threads whose session cwd exactly matches this path.' },
      },
    },
  },
  {
    name: 'codex_read',
    description:
      'Read a Codex thread\'s conversation history by thread id WITHOUT resuming it. Rehydrates from disk (works on threads created by any other Codex process). No model call, no token cost. Returns thread metadata (including lineage: which thread it was forked from or spawned by) plus user/assistant messages, reasoning, commands and file changes.',
    inputSchema: {
      type: 'object',
      required: ['threadId'],
      properties: {
        threadId: { type: 'string', description: 'Codex thread/session id (UUID).' },
        maxTurns: { type: 'number', description: 'How many most-recent turns to return (default 20). Pass 0 for thread metadata only (lineage, cwd, turn count) with no turn bodies.' },
      },
    },
  },
  {
    name: 'codex_send',
    description:
      'Send a new prompt into an existing Codex thread: resumes it from disk, runs one turn in Codex, and returns Codex\'s reasoning, executed commands, file changes and final answer. The turn is appended to the ORIGINAL thread (visible in the Codex app). Costs Codex-side tokens (it reloads full history). Default sandbox is read-only; pass write:true to allow file edits.',
    inputSchema: {
      type: 'object',
      required: ['threadId', 'prompt'],
      properties: {
        threadId: { type: 'string', description: 'Codex thread/session id (UUID) to continue.' },
        prompt: { type: 'string', description: 'The message/instruction to send to Codex.' },
        write: { type: 'boolean', description: 'Allow Codex to modify files (workspace-write sandbox). Default false (read-only).' },
        model: { type: 'string', description: 'Optional model override, e.g. "gpt-5.5".' },
        effort: { type: 'string', description: 'Optional reasoning effort: low | medium | high | xhigh.' },
      },
    },
  },
];

// ---- MCP wire protocol over stdio (newline-delimited JSON-RPC) ----
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line) handleLine(line);
  }
});

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyError(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }
function log(...a) { process.stderr.write('[codex-bridge] ' + a.join(' ') + '\n'); }

async function handleLine(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;

  // notifications (no id) — ack silently
  if (id === undefined) return;

  try {
    if (method === 'initialize') {
      return reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    if (method === 'tools/list') {
      return reply(id, { tools: TOOLS });
    }
    if (method === 'ping') {
      return reply(id, {});
    }
    if (method === 'tools/call') {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      const text = await callTool(name, args);
      return reply(id, { content: [{ type: 'text', text }] });
    }
    return replyError(id, -32601, 'Method not found: ' + method);
  } catch (e) {
    log('error in', method, e && e.message);
    // Tool errors: surface as tool content with isError so Claude sees them.
    if (method === 'tools/call') {
      return reply(id, { content: [{ type: 'text', text: 'ERROR: ' + (e && e.message) }], isError: true });
    }
    return replyError(id, -32603, (e && e.message) || 'internal error');
  }
}

async function callTool(name, args) {
  if (name === 'codex_list') {
    const rows = await ops.listThreads({ limit: args.limit ?? 30, cwd: args.cwd || null });
    const lines = rows.map((r) => {
      const when = ops.formatWhen(r.recencyAt);
      const status = r.status ? `  ${r.status}` : '';
      const lineage = ops.formatLineage(r);
      const name = r.name ? `"${r.name}"  ` : '';
      return `${r.id}  [${r.source}]  ${when}${status}` +
        (lineage ? `\n    ↳ ${lineage}` : '') +
        `\n    ${name}${ops.oneline(r.preview, 80)}  (cwd: ${r.cwd || '?'})`;
    });
    return `Found ${rows.length} Codex thread(s):\n\n` + lines.join('\n');
  }

  if (name === 'codex_read') {
    if (!args.threadId) throw new Error('threadId is required');
    const res = await ops.readThread(args.threadId, { maxTurns: args.maxTurns ?? 20 });
    const t = res.thread;
    const lineage = ops.formatLineage(t);
    let out = `Thread ${t.id}${t.name ? ` "${t.name}"` : ''}\n  preview: ${ops.oneline(t.preview, 160)}\n  cwd: ${t.cwd}\n  source: ${t.source}  status: ${t.status}  totalTurns: ${t.turnCount}\n`;
    if (lineage) out += `  lineage: ${lineage}\n`;
    out += `  rollout: ${t.path}\n\n--- last ${res.turns.length} turn(s) ---\n`;
    for (const turn of res.turns) {
      for (const rec of turn.records) {
        if (rec.kind === 'message') out += `\n[${rec.role}${rec.phase ? '/' + rec.phase : ''}]\n${rec.text}\n`;
        else if (rec.kind === 'reasoning') out += `\n[reasoning]\n${rec.text}\n`;
        else if (rec.kind === 'command') out += `\n[command exit=${rec.exit}] ${rec.text}\n`;
        else if (rec.kind === 'fileChange') out += `\n[fileChange] ${rec.text}\n`;
      }
    }
    return out;
  }

  if (name === 'codex_send') {
    if (!args.threadId) throw new Error('threadId is required');
    if (!args.prompt) throw new Error('prompt is required');
    const res = await ops.sendToThread(args.threadId, args.prompt, {
      write: !!args.write,
      model: args.model || null,
      effort: args.effort || null,
    });
    let out = `Sent to thread ${res.threadId} (turn ${res.turnId || '?'}).\n`;
    if (res.commands.length) {
      out += `\nCommands executed (${res.commands.length}):\n` +
        res.commands.map((c) => `  $ ${c.command}  (exit ${c.exit})`).join('\n') + '\n';
    }
    if (res.fileChanges.length) {
      out += `\nFiles changed (${res.fileChanges.length}):\n` +
        res.fileChanges.map((f) => '  ' + (f.paths || []).join(', ')).join('\n') + '\n';
    }
    if (res.errors.length) {
      out += `\nErrors (${res.errors.length}):\n` + res.errors.map((e) => '  ' + JSON.stringify(e).slice(0, 200)).join('\n') + '\n';
    }
    const finalMsgs = res.messages.filter((m) => m.phase === 'final_answer' || m.phase === 'final');
    const shown = (finalMsgs.length ? finalMsgs : res.messages).map((m) => m.text);
    out += `\n=== Codex reply ===\n${shown.join('\n\n') || '(no message)'}`;
    return out;
  }

  throw new Error('Unknown tool: ' + name);
}

log('ready, tools: ' + TOOLS.map((t) => t.name).join(', '));
