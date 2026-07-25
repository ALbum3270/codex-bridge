'use strict';
// Minimal JSON-RPC client for `codex app-server` over stdio.
// Zero external deps. Spawns the app-server as a child, speaks newline-delimited
// JSON-RPC, and exposes request() + notification streaming.

const { spawn } = require('node:child_process');
const readline = require('node:readline');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

// Codex ships its real executable as a per-platform optional dependency; a
// global install whose optional deps failed leaves a codex.js that exists and
// throws "Missing optional dependency @openai/codex-<platform>-<arch>". Existence
// alone is therefore not proof an install works.
function hasPlatformBinary(codexJs) {
  const pkgRoot = path.resolve(path.dirname(codexJs), '..');
  const want = `codex-${process.platform}-${process.arch}`; // codex-linux-x64, codex-darwin-arm64, ...
  return fs.existsSync(path.join(pkgRoot, 'node_modules', '@openai', want));
}

// The `codex` on PATH is the install the user actually runs, which version
// managers (nvm, fnm, volta) put in a per-version directory no static list can
// predict. Follow it to its real file, and only take it if it is the JS entry
// point — a native binary is not something we can hand to `node`.
function codexJsFromPath() {
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const bin = path.join(dir, 'codex' + ext);
      if (!fs.existsSync(bin)) continue;
      try {
        const real = fs.realpathSync(bin);
        if (real.endsWith('.js')) return real;
      } catch { /* unreadable link, keep looking */ }
      return null; // found codex, but it is not a JS entry — let the PATH fallback spawn it
    }
  }
  return null;
}

function resolveCodexJs() {
  if (process.env.CODEX_JS && fs.existsSync(process.env.CODEX_JS)) return process.env.CODEX_JS;

  const fromPath = codexJsFromPath();
  if (fromPath) return fromPath;

  const candidates = [
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    '/usr/local/lib/node_modules/@openai/codex/bin/codex.js',
    path.join(os.homedir(), '.npm-global', 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
  ].filter((c) => c && fs.existsSync(c));

  // Prefer a candidate that can actually run. Falling back to one that merely
  // exists keeps the old behaviour when the check is wrong (npm may hoist the
  // platform package somewhere this does not look).
  return candidates.find(hasPlatformBinary) || candidates[0] || null;
}

// app-server sends requests *to* the client, and ignoring one hangs the turn.
// A blank reply is not an answer either: every response type has required
// fields, so `{}` is a malformed answer the server may still act on. Answer
// each kind explicitly instead, and for the ones a headless bridge genuinely
// cannot serve, return a JSON-RPC error so the server fails fast rather than
// proceeding on a fabricated result.
//
// Note approvalPolicy 'never' only suppresses the approval family; user-input,
// elicitation, auth refresh and client-side tool calls are not gated by it.
function defaultServerReply(method) {
  switch (method) {
    // Approval family. ReviewDecision has no "denied" variant — `timed_out` is
    // the honest one here (nobody was watching), and unlike `abort` it declines
    // this single command without tearing down the whole turn.
    case 'execCommandApproval':
    case 'applyPatchApproval':
      return { result: { decision: 'timed_out' } };
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { result: { decision: 'decline' } };
    // Required field is the granted profile, not a decision: grant nothing.
    case 'item/permissions/requestApproval':
      return { result: { permissions: {} } };
    // Questions aimed at a human. Decline rather than stall.
    case 'mcpServer/elicitation/request':
      return { result: { action: 'decline' } };
    case 'item/tool/requestUserInput':
      return { result: { answers: {} } };
    // Anything else — auth token refresh, attestation, client-side tool calls —
    // needs a real client. Saying so beats inventing an empty success.
    default:
      return {
        error: {
          code: -32601,
          message: `codex-bridge cannot service ${method}: it is a headless client with no user to ask`,
        },
      };
  }
}

class AppServer {
  constructor(opts = {}) {
    this.nextId = 1;
    this.pending = new Map();       // id -> {resolve, reject}
    this.notifHandlers = new Set(); // fn(method, params)
    this.serverRequestHandler = opts.onServerRequest || null;
    this.debug = !!opts.debug;
    this.proc = null;
    this._buf = '';
  }

  start() {
    const codexJs = resolveCodexJs();
    let cmd, args;
    if (codexJs) { cmd = process.execPath; args = [codexJs, 'app-server', '--stdio']; }
    else { cmd = 'codex'; args = ['app-server', '--stdio']; } // PATH fallback
    this.proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc.stderr.on('data', (d) => { if (this.debug) process.stderr.write('[appsrv] ' + d); });
    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on('line', (line) => this._onLine(line));
    // Callers waiting on notifications rather than an RPC reply (a turn running
    // to completion) get no signal from rejected pending requests — they need
    // to know the process is gone. Resolves with the exit code.
    this.exited = new Promise((resolve) => { this._onExit = resolve; });
    this.proc.on('exit', (code) => {
      for (const [, p] of this.pending) p.reject(new Error('app-server exited, code=' + code));
      this.pending.clear();
      this._onExit(code);
    });
    return this;
  }

  _onLine(line) {
    line = line.trim();
    if (!line) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
      return;
    }
    if (msg.method && msg.id !== undefined) {
      // Server -> client request (approval, elicitation, ...). Answer it so
      // turns never hang; onServerRequest may override, returning undefined to
      // fall through to the default.
      let answer;
      if (this.serverRequestHandler) {
        const custom = this.serverRequestHandler(msg.method, msg.params);
        if (custom !== undefined) answer = { result: custom };
      }
      this._write({ jsonrpc: '2.0', id: msg.id, ...(answer || defaultServerReply(msg.method)) });
      return;
    }
    if (msg.method) { for (const fn of this.notifHandlers) fn(msg.method, msg.params || {}); }
  }

  _write(obj) { this.proc.stdin.write(JSON.stringify(obj) + '\n'); }

  request(method, params, timeoutMs = 600000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this._write({ jsonrpc: '2.0', id, method, params: params || {} });
      if (timeoutMs) {
        setTimeout(() => {
          if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout: ${method}`)); }
        }, timeoutMs);
      }
    });
  }

  onNotification(fn) { this.notifHandlers.add(fn); return () => this.notifHandlers.delete(fn); }

  async initialize() {
    return this.request('initialize', {
      clientInfo: { name: 'codex-bridge', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
  }

  stop() { try { this.proc && this.proc.kill(); } catch { /* ignore */ } }
}

module.exports = { AppServer, resolveCodexJs, defaultServerReply };
