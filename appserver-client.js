'use strict';
// Minimal JSON-RPC client for `codex app-server` over stdio.
// Zero external deps. Spawns the app-server as a child, speaks newline-delimited
// JSON-RPC, and exposes request() + notification streaming.

const { spawn } = require('node:child_process');
const readline = require('node:readline');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

function resolveCodexJs() {
  if (process.env.CODEX_JS && fs.existsSync(process.env.CODEX_JS)) return process.env.CODEX_JS;
  const candidates = [
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    '/usr/local/lib/node_modules/@openai/codex/bin/codex.js',
    path.join(os.homedir(), '.npm-global', 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
  ];
  for (const c of candidates) { if (c && fs.existsSync(c)) return c; }
  return null;
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
    this.proc.on('exit', (code) => {
      for (const [, p] of this.pending) p.reject(new Error('app-server exited, code=' + code));
      this.pending.clear();
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
      // Server -> client request (e.g. approval). Answer it so turns never hang.
      const reply = this.serverRequestHandler ? this.serverRequestHandler(msg.method, msg.params) : {};
      this._write({ jsonrpc: '2.0', id: msg.id, result: reply || {} });
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

module.exports = { AppServer, resolveCodexJs };
