'use strict';

/**
 * JSON-lines audit log (harness/logs/audit.jsonl).
 *
 * One entry per security-relevant event: authentication, authorization failures,
 * data access/modification (create, modify, cancel, release, stage change), agent runs
 * and admin actions (reset). Entries never contain request bodies or secrets.
 */

const fs = require('node:fs');
const path = require('node:path');

class AuditLog {
  constructor(file, opts = {}) {
    this.file = file || path.join(__dirname, '..', 'logs', 'audit.jsonl');
    this.clock = opts.clock || (() => new Date());
    this.echo = opts.echo || null;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
  }

  write(event, fields = {}) {
    const entry = {
      timestamp: this.clock().toISOString(),
      event,
      ...fields,
    };
    const line = JSON.stringify(entry);
    fs.appendFileSync(this.file, `${line}\n`);
    if (this.echo) {
      this.echo(line);
    }
    return entry;
  }

  tail(n = 50) {
    if (!fs.existsSync(this.file)) {
      return [];
    }
    const lines = fs.readFileSync(this.file, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-n).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { event: 'unparseable', raw: l.slice(0, 200) };
      }
    });
  }
}

module.exports = { AuditLog };
