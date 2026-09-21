#!/usr/bin/env node
'use strict';

/**
 * HAAS render harness entry point.
 *
 *   npm start            -> http://localhost:8088/
 *   PORT=9000 npm start  -> alternate port
 *
 * Serves the synthetic Domino/XPages application from the DXL/XSP design under nsf/ and
 * the seeded document store under harness/data/ (created from export/dxl on first start).
 */

const path = require('node:path');
const { createApp } = require('./lib/app');

const port = Number(process.env.PORT) || 8088;
const host = process.env.HOST || '127.0.0.1';

const app = createApp({
  repoRoot: path.join(__dirname, '..'),
  dataDir: path.join(__dirname, 'data'),
  auditFile: path.join(__dirname, 'logs', 'audit.jsonl'),
  logFile: path.join(__dirname, 'logs', 'harness.log'),
  quiet: process.env.HARNESS_QUIET === '1',
});

app.listen(port, host).then(() => {
  const counts = Object.fromEntries(['heraldry.nsf', 'vetmedals.nsf'].map((n) => [n, app.store.db(n).documents.length]));
  console.log(`HAAS render harness listening on http://localhost:${port}/  (${JSON.stringify(counts)})`);
  console.log('Rendering harness - synthetic Domino/XPages application, not an HCL Domino server');
});

function shutdown() {
  app.close().then(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
