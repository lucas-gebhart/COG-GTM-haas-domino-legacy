'use strict';

/**
 * The render harness HTTP application (plain node:http, no dependencies).
 *
 * Responsibilities kept here: security headers, request parsing with strict limits,
 * session cookie (EAMS-A/SAML stub), static assets, dispatch to the route modules,
 * generic error pages with detailed internal logging, and the audit log.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL, URLSearchParams } = require('node:url');

const dxl = require('./dxl');
const { Store } = require('./store');
const { ViewEngine } = require('./views');
const { AuditLog } = require('./audit');
const H = require('./html');
const { AppError } = require('./agents');
const personas = require('./personas');

const heraldryRoutes = require('../routes/heraldry');
const vetmedalsRoutes = require('../routes/vetmedals');
const commonRoutes = require('../routes/common');

const MAX_BODY = 2 * 1024 * 1024 + 4096;
const MAX_URL = 2048;
const SESSION_IDLE_MS = 15 * 60 * 1000;
const COOKIE = 'DomAuthSessId';

const STATIC = {
  '/domino.css': ['domino.css', 'text/css; charset=utf-8'],
  '/xsp.css': ['xsp.css', 'text/css; charset=utf-8'],
  '/twisty.js': ['twisty.js', 'text/javascript; charset=utf-8'],
  '/brand/cognition-lockup-black.svg': ['brand/cognition-lockup-black.svg', 'image/svg+xml'],
  '/favicon.ico': ['favicon.svg', 'image/svg+xml'],
  '/icons/vwicn001.gif': ['icons/notes-doc.svg', 'image/svg+xml'],
};

const SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'; base-uri 'self'",
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'X-XSS-Protection': '0',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  Server: 'Lotus-Domino',
};

class HttpRedirect {
  constructor(location, status = 303) {
    this.location = location;
    this.status = status;
  }
}

function createApp(opts = {}) {
  const repoRoot = opts.repoRoot || path.join(__dirname, '..', '..');
  const logFile = opts.logFile || path.join(__dirname, '..', 'logs', 'harness.log');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const quiet = Boolean(opts.quiet);
  const internalLog = (level, msg, extra) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(extra || {}) });
    fs.appendFileSync(logFile, `${line}\n`);
    if (!quiet && level !== 'debug') {
      console.log(line);
    }
  };

  const store = Store.open({
    dataDir: opts.dataDir,
    exportDir: opts.exportDir || path.join(repoRoot, 'export', 'dxl'),
    log: (m, x) => internalLog('info', m, x),
  });
  const designs = {
    'heraldry.nsf': dxl.loadDesign(path.join(repoRoot, 'nsf', 'heraldry.nsf')),
    'vetmedals.nsf': dxl.loadDesign(path.join(repoRoot, 'nsf', 'vetmedals.nsf')),
  };
  const nowFn = opts.now || (() => new Date());
  const engines = {
    'heraldry.nsf': new ViewEngine(designs['heraldry.nsf'], store.db('heraldry.nsf'), { now: nowFn }),
    'vetmedals.nsf': new ViewEngine(designs['vetmedals.nsf'], store.db('vetmedals.nsf'), { now: nowFn }),
  };
  const audit = new AuditLog(opts.auditFile);
  const sessions = new Map();

  const app = {
    store,
    designs,
    engines,
    audit,
    sessions,
    repoRoot,
    now: nowFn,
    log: internalLog,
    personas,
  };

  function getSession(req) {
    const cookies = parseCookies(req.headers.cookie || '');
    const sid = cookies[COOKIE];
    if (!sid || !/^[a-f0-9]{48}$/.test(sid)) {
      return null;
    }
    const s = sessions.get(sid);
    if (!s) {
      return null;
    }
    if (Date.now() - s.lastSeen > SESSION_IDLE_MS) {
      sessions.delete(sid);
      return null;
    }
    s.lastSeen = Date.now();
    return s;
  }

  app.login = (res, personaId, ip) => {
    const persona = personas.byId(personaId);
    if (!persona) {
      audit.write('authentication_failure', { user: String(personaId).slice(0, 64), ip, reason: 'unknown_identity' });
      return null;
    }
    const sid = crypto.randomBytes(24).toString('hex');
    sessions.set(sid, { id: sid, user: persona, lastSeen: Date.now(), created: Date.now() });
    res.setHeader('Set-Cookie', `${COOKIE}=${sid}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_IDLE_MS / 1000}`);
    audit.write('authentication_success', { user: persona.name, roles: persona.roles, ip, mechanism: 'EAMS-A SAML stub' });
    return persona;
  };

  app.logout = (req, res, ip) => {
    const s = getSession(req);
    if (s) {
      sessions.delete(s.id);
      audit.write('logout', { user: s.user.name, ip });
    }
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
  };

  const routers = [commonRoutes, heraldryRoutes, vetmedalsRoutes];

  async function handle(req, res) {
    const started = Date.now();
    const ip = (req.socket && req.socket.remoteAddress) || '';
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
      res.setHeader(k, v);
    }
    try {
      if (!req.url || req.url.length > MAX_URL) {
        throw new AppError('Request URI too long', 414);
      }
      if (!['GET', 'HEAD', 'POST'].includes(req.method)) {
        res.setHeader('Allow', 'GET, HEAD, POST');
        throw new AppError('Method not allowed', 405);
      }
      const url = new URL(req.url, 'http://localhost');
      const pathname = decodePath(url.pathname);
      if (STATIC[pathname]) {
        return serveStatic(res, STATIC[pathname]);
      }
      const session = getSession(req);
      const user = session ? session.user : personas.ANONYMOUS;
      let body = {};
      if (req.method === 'POST') {
        body = await readBody(req);
      }
      const query = queryObject(url.searchParams);
      const ctx = {
        app,
        req,
        res,
        method: req.method,
        pathname,
        url,
        query,
        body,
        user,
        session,
        ip,
        now: nowFn(),
        redirect: (loc, status) => new HttpRedirect(loc, status),
      };
      let result = null;
      for (const r of routers) {
        result = await r.dispatch(ctx);
        if (result !== undefined && result !== null) {
          break;
        }
      }
      if (result === undefined || result === null) {
        throw new AppError('Not found', 404);
      }
      send(res, result, req.method === 'HEAD');
      internalLog('debug', 'request', { method: req.method, path: pathname, status: res.statusCode, ms: Date.now() - started, user: user.name });
    } catch (err) {
      if (err instanceof HttpRedirect) {
        send(res, err, req.method === 'HEAD');
        internalLog('debug', 'request', { method: req.method, path: safe(req.url), status: res.statusCode, ms: Date.now() - started, redirect: err.location });
        return;
      }
      const status = err instanceof AppError ? err.status : 500;
      if (status >= 500) {
        internalLog('error', 'unhandled', { method: req.method, path: safe(req.url), error: err && err.message ? err.message : String(err), stack: err && err.stack });
        audit.write('server_error', { path: safe(req.url), ip });
      } else {
        internalLog('warn', 'client_error', { method: req.method, path: safe(req.url), status, error: err.message });
        if (status === 403) {
          audit.write('authorization_failure', { path: safe(req.url), ip, reason: err.message.slice(0, 200) });
        }
        if (status === 400) {
          audit.write('validation_failure', { path: safe(req.url), ip, reason: err.message.slice(0, 200) });
        }
      }
      if (res.headersSent) {
        res.end();
        return;
      }
      const userMessage = status >= 500 ? 'An error occurred while processing your request. The incident has been logged.' : (err.userMessage || http.STATUS_CODES[status]);
      const html = H.page({
        title: `HTTP Web Server: ${statusText(status)}`,
        db: null,
        user: null,
        appTitle: 'HAAS',
        content: `<div class="dominoErrorPage"><h2>Error ${status}</h2><p>${H.esc(statusText(status))} - ${H.esc(userMessage)}</p><p><a href="/">Return to the home page</a></p></div>`,
      });
      res.statusCode = status;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(html);
    }
  }

  app.handler = (req, res) => {
    handle(req, res).catch((e) => {
      internalLog('error', 'fatal', { error: e.message, stack: e.stack });
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      }
      res.end('An error occurred.');
    });
  };

  app.listen = (port, host) => new Promise((resolve) => {
    const server = http.createServer(app.handler);
    server.listen(port, host || '127.0.0.1', () => resolve(server));
    app.server = server;
  });

  app.close = () => {
    store.flush();
    if (app.server) {
      return new Promise((resolve) => app.server.close(resolve));
    }
    return Promise.resolve();
  };

  return app;
}

function statusText(status) {
  switch (status) {
    case 400: return 'Bad Request';
    case 403: return 'You are not authorized to perform that operation';
    case 404: return 'Item Not Found Exception';
    case 405: return 'Method Not Allowed';
    case 413: return 'Payload Too Large';
    case 414: return 'Request URI Too Long';
    default: return 'Internal Server Error';
  }
}

function safe(s) {
  return String(s || '').slice(0, 300);
}

function decodePath(p) {
  try {
    return decodeURIComponent(p).replace(/\/{2,}/g, '/');
  } catch {
    throw new AppError('Bad request', 400);
  }
}

function queryObject(params) {
  const out = {};
  for (const [k, v] of params) {
    if (k.length > 64 || v.length > 1024) {
      throw new AppError('Query parameter too long', 400);
    }
    if (out[k] === undefined) {
      out[k] = v;
    }
  }
  return out;
}

function parseCookies(header) {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new AppError('Payload too large', 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const ct = String(req.headers['content-type'] || '');
      const raw = Buffer.concat(chunks);
      try {
        if (ct.startsWith('multipart/form-data')) {
          resolve(parseMultipart(raw, ct));
        } else if (ct.startsWith('application/x-www-form-urlencoded') || ct === '') {
          resolve(formObject(new URLSearchParams(raw.toString('utf8'))));
        } else {
          reject(new AppError('Unsupported media type', 400));
        }
      } catch (e) {
        reject(e instanceof AppError ? e : new AppError('Malformed request body', 400));
      }
    });
    req.on('error', reject);
  });
}

function formObject(params) {
  const out = {};
  let n = 0;
  for (const [k, v] of params) {
    n += 1;
    if (n > 200 || k.length > 64) {
      throw new AppError('Too many form fields', 400);
    }
    if (!/^[A-Za-z0-9_$.-]+$/.test(k)) {
      throw new AppError('Invalid form field name', 400);
    }
    if (out[k] === undefined) {
      out[k] = v.length > 5000 ? v.slice(0, 5000) : v;
    }
  }
  return out;
}

/** Minimal multipart/form-data parser for the agent file-upload form (single small file). */
function parseMultipart(raw, contentType) {
  const m = /boundary=("?)([^";]+)\1/.exec(contentType);
  if (!m) {
    throw new AppError('Malformed multipart body', 400);
  }
  const boundary = Buffer.from(`--${m[2]}`);
  const out = {};
  let pos = raw.indexOf(boundary);
  let parts = 0;
  while (pos >= 0) {
    const next = raw.indexOf(boundary, pos + boundary.length);
    if (next < 0) {
      break;
    }
    parts += 1;
    if (parts > 20) {
      throw new AppError('Too many multipart parts', 400);
    }
    const part = raw.subarray(pos + boundary.length + 2, next - 2);
    const sep = part.indexOf('\r\n\r\n');
    if (sep >= 0) {
      const headers = part.subarray(0, sep).toString('utf8');
      const content = part.subarray(sep + 4);
      const nm = /name="([^"]{1,64})"/.exec(headers);
      const fn = /filename="([^"]{0,200})"/.exec(headers);
      if (nm && /^[A-Za-z0-9_$.-]+$/.test(nm[1])) {
        if (fn) {
          out[nm[1]] = { filename: path.basename(fn[1]).slice(0, 80), content: content.toString('utf8'), size: content.length };
        } else {
          out[nm[1]] = content.toString('utf8').slice(0, 5000);
        }
      }
    }
    pos = next;
  }
  return out;
}

function serveStatic(res, [file, type]) {
  const full = path.join(__dirname, '..', 'public', file);
  if (!fs.existsSync(full)) {
    throw new AppError('Not found', 404);
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.end(fs.readFileSync(full));
}

function send(res, result, headOnly) {
  if (result instanceof HttpRedirect) {
    res.statusCode = result.status;
    res.setHeader('Location', result.location);
    res.end();
    return;
  }
  const preset = res.statusCode >= 400 ? res.statusCode : 0;
  if (typeof result === 'string') {
    res.statusCode = preset || 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(headOnly ? undefined : result);
    return;
  }
  res.statusCode = result.status || preset || 200;
  res.setHeader('Content-Type', result.type || 'text/html; charset=utf-8');
  res.end(headOnly ? undefined : result.body);
}

module.exports = { createApp, HttpRedirect, SECURITY_HEADERS, COOKIE };
