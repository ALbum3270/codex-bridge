'use strict';
// Smoke test: exercise list -> read -> (optional) send against a real thread.
// Usage:
//   node smoke.js list
//   node smoke.js read <threadId>
//   node smoke.js send <threadId> "prompt"
const ops = require('./codex-ops');

async function main() {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === 'list') {
    const rows = await ops.listThreads({ limit: 8 });
    console.log('count=', rows.length);
    for (const r of rows.slice(0, 8)) {
      console.log(`${r.id.slice(0, 8)} | ${r.source} | ${(r.preview || '').slice(0, 30)} | ${r.status}`);
    }
  } else if (cmd === 'read') {
    const res = await ops.readThread(a, { maxTurns: 3 });
    console.log('thread:', JSON.stringify(res.thread, null, 0));
    console.log('turns returned:', res.turns.length);
    for (const t of res.turns) {
      for (const rec of t.records) {
        console.log(`  [${rec.kind}${rec.role ? '/' + rec.role : ''}] ${(rec.text || '').replace(/\s+/g, ' ').slice(0, 70)}`);
      }
    }
  } else if (cmd === 'send') {
    const res = await ops.sendToThread(a, b, {
      write: false, model: 'gpt-5.5', effort: 'low',
      onEvent: (ev) => console.log('EVENT', ev.type, (ev.text || '').slice(0, 60)),
    });
    console.log('=== RESULT ===');
    console.log('turnId:', res.turnId);
    console.log('messages:', res.messages.map((m) => `[${m.phase}] ${m.text}`).join('\n---\n'));
    console.log('commands:', res.commands.length, 'fileChanges:', res.fileChanges.length, 'errors:', res.errors.length);
  } else {
    console.log('usage: node smoke.js list | read <id> | send <id> "prompt"');
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error('ERR', e.message); process.exit(1); });
