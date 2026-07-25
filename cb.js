#!/usr/bin/env node
'use strict';
// Thin CLI over codex-ops so the bridge is usable without MCP restart.
//   node cb.js list [limit]
//   node cb.js read <threadId> [maxTurns]
//   node cb.js send <threadId> "prompt" [--write]
const ops = require('./codex-ops');

const ts = ops.formatWhen;
const oneline = ops.oneline;

async function main() {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === 'list') {
    const rows = await ops.listThreads({ limit: Number(a) || 20 });
    for (const r of rows) {
      const lineage = ops.formatLineage(r);
      console.log(`${r.id}  ${ts(r.updatedAt)}  ${r.source.padEnd(16)}  ${(r.cwd || '-').padEnd(20)}  ${r.name || oneline(r.preview, 50)}${lineage ? `  (↳ ${lineage})` : ''}`);
    }
    console.log(`\n(${rows.length} threads)`);
  } else if (cmd === 'read') {
    const res = await ops.readThread(a, { maxTurns: Number(b) || 20 });
    console.log(`# thread ${a}  cwd=${res.thread.cwd}  name=${res.thread.name || '-'}\n`);
    for (const t of res.turns) {
      for (const rec of t.records) {
        const tag = `${rec.kind}${rec.role ? '/' + rec.role : ''}`;
        console.log(`--- [${tag}]\n${(rec.text || '').trim()}\n`);
      }
    }
  } else if (cmd === 'send') {
    const res = await ops.sendToThread(a, b, { write: process.argv.includes('--write') });
    console.log(res.messages.map((m) => m.text).join('\n---\n'));
    console.log(`\n[commands: ${res.commands.length}, fileChanges: ${res.fileChanges.length}, errors: ${res.errors.length}]`);
  } else {
    console.log('usage: node cb.js list [limit] | read <id> [maxTurns] | send <id> "prompt" [--write]');
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error('ERR', e.message); process.exit(1); });
