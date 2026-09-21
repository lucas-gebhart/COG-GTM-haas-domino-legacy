'use strict';

const { AppError } = require('../lib/agents');
const { hasRole } = require('../lib/personas');

const UNID_RE = /^[A-F0-9]{32}$/i;
const NAME_RE = /^[A-Za-z0-9_$().\- ]{1,64}$/;

/** Domino URL command: the first query key of the form ?OpenView, ?OpenDocument, ?Login ... */
function dominoCommand(query) {
  for (const k of Object.keys(query)) {
    if (/^(Open|Edit|Create|Save|Delete|Login|Logout|Read|Run)[A-Za-z]*$/.test(k) && query[k] === '') {
      return k.toLowerCase();
    }
  }
  return '';
}

/** Match /<db>/<rest...>; returns { db, parts } or null. */
function splitDbPath(pathname) {
  const m = /^\/(heraldry\.nsf|vetmedals\.nsf)(?:\/(.*))?$/.exec(pathname);
  if (!m) {
    return null;
  }
  const rest = m[2] || '';
  return { db: m[1], rest, parts: rest ? rest.split('/') : [] };
}

class Router {
  constructor() {
    this.routes = [];
  }

  add(method, test, handler) {
    this.routes.push({ method, test, handler });
    return this;
  }

  get(test, handler) {
    return this.add('GET', test, handler);
  }

  post(test, handler) {
    return this.add('POST', test, handler);
  }

  async dispatch(ctx) {
    const method = ctx.method === 'HEAD' ? 'GET' : ctx.method;
    for (const r of this.routes) {
      if (r.method !== method && r.method !== 'ANY') {
        continue;
      }
      const params = r.test(ctx);
      if (params) {
        return r.handler(ctx, params === true ? {} : params);
      }
    }
    return null;
  }
}

function requireLogin(ctx) {
  if (ctx.user.anonymous) {
    const back = `${ctx.pathname}${ctx.url.search || ''}`;
    throw ctx.redirect(`/names.nsf?Login&RedirectTo=${encodeURIComponent(back)}`);
  }
}

function requireRole(ctx, ...roles) {
  requireLogin(ctx);
  if (!hasRole(ctx.user, ...roles)) {
    throw new AppError(`Requires one of ${roles.join(', ')}`, 403, 'You are not authorized to perform that operation');
  }
}

function cleanUnid(v) {
  const s = String(v || '').trim().toUpperCase();
  if (!UNID_RE.test(s)) {
    throw new AppError('Invalid document identifier', 400);
  }
  return s;
}

function cleanName(v) {
  const s = String(v || '').trim();
  if (!NAME_RE.test(s)) {
    throw new AppError('Invalid design element name', 400);
  }
  return s;
}

/** Whitelist-trim a free-text form value: strip control chars, enforce length. */
function cleanText(v, max = 255) {
  if (v === undefined || v === null) {
    return '';
  }
  // eslint-disable-next-line no-control-regex
  return String(v).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim().slice(0, max);
}

function cleanCode(v, max = 32) {
  const s = cleanText(v, max).toUpperCase();
  return s.replace(/[^A-Z0-9_. /-]/g, '');
}

function cleanInt(v, min, max, fallback) {
  const n = Number.parseInt(String(v || ''), 10);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, n));
}

module.exports = {
  Router,
  dominoCommand,
  splitDbPath,
  requireLogin,
  requireRole,
  cleanUnid,
  cleanName,
  cleanText,
  cleanCode,
  cleanInt,
  UNID_RE,
};
