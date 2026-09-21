#!/usr/bin/env node
'use strict';

/**
 * npm run reset - discard the local document store and audit/harness logs so the next
 * start re-seeds both databases from export/dxl/*.dxl.
 */

const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('./lib/store');

const dataDir = path.join(__dirname, 'data');
const logsDir = path.join(__dirname, 'logs');

const removed = Store.reset(dataDir);
for (const f of ['audit.jsonl', 'harness.log']) {
  const p = path.join(logsDir, f);
  if (fs.existsSync(p)) {
    fs.unlinkSync(p);
    removed.push(p);
  }
}
for (const p of removed) {
  console.log(`removed ${path.relative(process.cwd(), p)}`);
}
if (!process.argv.includes('--no-seed')) {
  const store = Store.open({ dataDir, exportDir: path.join(__dirname, '..', 'export', 'dxl'), log: () => {} });
  store.flush();
  for (const n of ['heraldry.nsf', 'vetmedals.nsf']) {
    console.log(`${n}: ${store.db(n).documents.length} documents re-seeded from export/dxl`);
  }
}
