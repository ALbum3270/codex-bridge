'use strict';
// High-level Codex operations built on the app-server client.
// Each op spawns a fresh app-server, runs, and shuts down (simple + no state leakage).

const { AppServer } = require('./appserver-client');

async function withServer(fn, opts = {}) {
  const srv = new AppServer(opts).start();
  try {
    await srv.initialize();
    return await fn(srv);
  } finally {
    srv.stop();
  }
}

// List recent threads. Returns [{id, preview, cwd, updatedAt, source, model, ...}]
async function listThreads({ limit = 30, cwd = null, allSources = true } = {}) {
  return withServer(async (srv) => {
    const params = { limit };
    if (cwd) params.cwd = cwd;
    // sourceKinds omitted defaults to interactive-only; pass empty-ish to widen.
    if (allSources) params.sourceKinds = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentOther', 'unknown'];
    const res = await srv.request('thread/list', params);
    const rows = (res && res.data) || [];
    return rows.map((t) => ({
      id: t.id,
      preview: t.preview || t.name || '',
      cwd: t.cwd,
      source: t.source,
      model: t.model || (t.modelProvider ? t.modelProvider : null),
      updatedAt: t.updatedAt,
      recencyAt: t.recencyAt,
      status: t.status && t.status.type,
    }));
  });
}

// Read a thread's history WITHOUT resuming (cheap, no model call).
// Returns {thread:{...meta}, turns:[{role, texts:[...], items:[...]}]}
async function readThread(threadId, { maxTurns = 20 } = {}) {
  return withServer(async (srv) => {
    const res = await srv.request('thread/read', { threadId, includeTurns: true });
    const th = (res && res.thread) || {};
    const turns = Array.isArray(th.turns) ? th.turns : [];
    const trimmed = turns.slice(-maxTurns).map((t) => summarizeTurn(t));
    return {
      thread: {
        id: th.id, preview: th.preview, cwd: th.cwd, source: th.source,
        model: th.model, createdAt: th.createdAt, updatedAt: th.updatedAt,
        path: th.path, status: th.status && th.status.type, turnCount: turns.length,
      },
      turns: trimmed,
    };
  });
}

function textFromContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === 'string' ? c : (c && (c.text || c.content)) || '')).join('');
  }
  if (typeof content === 'object') return content.text || '';
  return '';
}

// Normalize one app-server item into a readable record, or null to skip.
// Real item.type values: userMessage, agentMessage, reasoning, commandExecution, fileChange.
function itemToRecord(it) {
  const type = it.type;
  if (type === 'userMessage') {
    return { kind: 'message', role: 'user', text: textFromContent(it.content) };
  }
  if (type === 'agentMessage') {
    return { kind: 'message', role: 'assistant', phase: it.phase || 'final', text: it.text || '' };
  }
  if (type === 'reasoning') {
    const s = Array.isArray(it.summary) ? it.summary.map((x) => x.text || '').join('') : (it.text || textFromContent(it.summary));
    return s ? { kind: 'reasoning', text: s } : null;
  }
  if (type === 'commandExecution') {
    return { kind: 'command', text: it.command || it.commandLine || '', exit: it.exitCode };
  }
  if (type === 'fileChange') {
    const paths = (it.changes || []).map((c) => c.path).filter(Boolean);
    return { kind: 'fileChange', text: (paths.length ? paths : (it.path ? [it.path] : [])).join(', ') };
  }
  return null;
}

// Reduce a turn's items into readable records.
function summarizeTurn(turn) {
  const items = Array.isArray(turn.items) ? turn.items : [];
  const out = [];
  for (const it of items) { const r = itemToRecord(it); if (r) out.push(r); }
  return { id: turn.id, status: turn.status, records: out };
}

// Send a new prompt into an existing thread: resume from disk, start a turn,
// stream events, resolve when the turn completes.
// opts: { write:false, model, effort, onEvent }
async function sendToThread(threadId, prompt, opts = {}) {
  const { write = false, model = null, effort = null, cwd = null, onEvent = null } = opts;
  return withServer(async (srv) => {
    const collected = {
      threadId, turnId: null, reasoning: [], commands: [], fileChanges: [],
      messages: [], tokenUsage: null, errors: [],
    };

    const emit = (ev) => { if (onEvent) { try { onEvent(ev); } catch { /* ignore */ } } };

    let turnDone;
    const donePromise = new Promise((res) => { turnDone = res; });

    srv.onNotification((method, params) => {
      switch (method) {
        case 'turn/started':
          collected.turnId = params.turnId || (params.turn && params.turn.id) || collected.turnId;
          emit({ type: 'turnStarted', turnId: collected.turnId });
          break;
        case 'item/completed': {
          const item = params.item || params;
          const rec = itemToRecord(item);
          if (!rec) break;
          if (rec.kind === 'reasoning') {
            collected.reasoning.push(rec.text); emit({ type: 'reasoning', text: rec.text });
          } else if (rec.kind === 'message') {
            // skip the echoed user message; keep assistant output
            if (rec.role === 'assistant' && rec.text) {
              collected.messages.push({ phase: rec.phase, text: rec.text });
              emit({ type: 'message', phase: rec.phase, text: rec.text });
            }
          } else if (rec.kind === 'command') {
            collected.commands.push({ command: rec.text, exit: rec.exit });
            emit({ type: 'command', command: rec.text, exit: rec.exit });
          } else if (rec.kind === 'fileChange') {
            collected.fileChanges.push({ paths: rec.text ? rec.text.split(', ') : [] });
            emit({ type: 'fileChange', paths: rec.text });
          }
          break;
        }
        case 'thread/tokenUsage/updated':
          collected.tokenUsage = params.tokenUsage || params.usage || params;
          break;
        case 'error':
          collected.errors.push(params); emit({ type: 'error', error: params });
          break;
        case 'turn/completed':
          emit({ type: 'turnCompleted' });
          turnDone();
          break;
        default:
          break;
      }
    });

    // 1) resume the thread from disk (rehydrate)
    const resumeParams = { threadId };
    if (cwd) resumeParams.cwd = cwd;
    await srv.request('thread/resume', resumeParams);

    // 2) start a turn (non-interactive: never ask, sandbox scoped by `write`)
    const turnParams = {
      threadId,
      input: [{ type: 'text', text: prompt }],
      approvalPolicy: 'never',
      sandboxPolicy: write ? { type: 'workspaceWrite' } : { type: 'readOnly', networkAccess: false },
    };
    if (model) turnParams.model = model;
    if (effort) turnParams.effort = effort;
    const startRes = await srv.request('turn/start', turnParams);
    if (startRes && (startRes.turnId || (startRes.turn && startRes.turn.id))) {
      collected.turnId = startRes.turnId || startRes.turn.id;
    }

    // 3) wait for completion (with a hard cap)
    const cap = new Promise((_, rej) => setTimeout(() => rej(new Error('turn timed out')), 900000));
    await Promise.race([donePromise, cap]);

    return collected;
  });
}

module.exports = { listThreads, readThread, sendToThread };
