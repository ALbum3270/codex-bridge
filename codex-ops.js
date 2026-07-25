'use strict';
// High-level Codex operations built on the app-server client.
// Each op spawns a fresh app-server, runs, and shuts down (simple + no state leakage).

const { AppServer } = require('./appserver-client');

// `source` arrives as a serde-tagged enum: unit variants come through as bare
// strings ("cli", "vscode"), variants carrying data as single-key objects
// ({subAgent:{other:'guardian'}}). Flatten to a readable string so callers can
// interpolate it directly.
function formatSource(src) {
  if (src == null) return 'unknown';
  if (typeof src === 'string') return src;
  if (typeof src !== 'object') return String(src);
  const keys = Object.keys(src);
  if (keys.length === 0) return 'unknown';
  if (keys.length > 1) return JSON.stringify(src);
  const tag = keys[0];
  const inner = formatSource(src[tag]);
  if (tag === 'other') return inner;            // {other:'guardian'} -> guardian
  return inner && inner !== 'unknown' ? `${tag}:${inner}` : tag;
}

// Collapse whitespace to one line and cap length. Previews can run to several
// KB (they replay whole turns), so every render site must bound them.
function oneline(s, n = 80) {
  const flat = (s || '').replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n - 1) + '…' : flat;
}

// Human-readable lineage for a mapped thread, or '' when it stands alone.
// Sub-agent and forked threads replay their parent's history, so they show up
// in listings with near-identical previews; this is what tells them apart.
function formatLineage(t) {
  const parts = [];
  if (t.parentThreadId) parts.push(`child of ${t.parentThreadId}`);
  if (t.forkedFromId && t.forkedFromId !== t.parentThreadId) parts.push(`forked from ${t.forkedFromId}`);
  return parts.join(', ');
}

// Unix seconds -> "YYYY-MM-DD HH:MM" in local time. Empty string if absent.
function formatWhen(unixSeconds) {
  if (!unixSeconds) return '';
  const d = new Date(unixSeconds * 1000);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

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
      name: t.name || null,
      preview: t.preview || t.name || '',
      cwd: t.cwd,
      source: formatSource(t.source),
      sourceRaw: t.source,
      // Lineage: parentThreadId = spawned by that thread (sub-agent),
      // forkedFromId = branched off it. Explains near-duplicate rows.
      parentThreadId: t.parentThreadId || null,
      forkedFromId: t.forkedFromId || null,
      model: t.model || null,
      modelProvider: t.modelProvider || null,
      updatedAt: t.updatedAt,
      recencyAt: t.recencyAt || t.updatedAt,
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
    // Guard maxTurns <= 0: slice(-0) is slice(0), which would return every
    // turn instead of none. 0 means "metadata only".
    const trimmed = (maxTurns > 0 ? turns.slice(-maxTurns) : []).map((t) => summarizeTurn(t));
    return {
      thread: {
        id: th.id, name: th.name || null, preview: th.preview, cwd: th.cwd,
        source: formatSource(th.source), sourceRaw: th.source,
        parentThreadId: th.parentThreadId || null, forkedFromId: th.forkedFromId || null,
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
// opts: { write:false, model, effort, cwd, onEvent }
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

module.exports = { listThreads, readThread, sendToThread, formatSource, formatWhen, formatLineage, oneline };
