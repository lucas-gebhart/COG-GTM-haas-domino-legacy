'use strict';

/**
 * Shared test helpers: boot an app on an ephemeral port with an isolated data dir and a
 * tiny cookie-carrying fetch client (the harness sets a Secure/HttpOnly session cookie which
 * Node's fetch does not store on its own).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../lib/app');

const REPO_ROOT = path.join(__dirname, '..', '..');

async function bootApp(opts = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'haas-test-'));
  const app = createApp({
    repoRoot: REPO_ROOT,
    dataDir: path.join(tmp, 'data'),
    auditFile: path.join(tmp, 'audit.jsonl'),
    logFile: path.join(tmp, 'harness.log'),
    quiet: true,
    ...opts,
  });
  const server = await app.listen(0, '127.0.0.1');
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const client = makeClient(base);
  return {
    app,
    base,
    tmp,
    client,
    async close() {
      await app.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

function makeClient(base) {
  let cookie = '';
  const jar = {
    get cookie() {
      return cookie;
    },
    async request(pathname, { method = 'GET', form, headers = {}, follow = true } = {}) {
      const init = { method, headers: { ...headers }, redirect: 'manual' };
      if (cookie) {
        init.headers.Cookie = cookie;
      }
      if (form) {
        init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        init.body = new URLSearchParams(form).toString();
      }
      let res = await fetch(base + pathname, init);
      const sc = res.headers.get('set-cookie');
      if (sc) {
        cookie = sc.split(';')[0];
        if (/Max-Age=0/.test(sc)) {
          cookie = '';
        }
      }
      const chain = [res.status];
      let location = res.headers.get('location');
      while (follow && [301, 302, 303, 307, 308].includes(res.status) && location) {
        await res.arrayBuffer();
        res = await fetch(new URL(location, base), { headers: cookie ? { Cookie: cookie } : {}, redirect: 'manual' });
        chain.push(res.status);
        location = res.headers.get('location');
      }
      const text = await res.text();
      return { res, status: res.status, chain, text, location: res.headers.get('location'), finalUrl: res.url };
    },
    get(p, o) {
      return jar.request(p, o);
    },
    post(p, form, o) {
      return jar.request(p, { ...o, method: 'POST', form });
    },
    async login(personaId) {
      const r = await jar.request('/names.nsf?Login', { method: 'POST', form: { Username: personaId, RedirectTo: '/heraldry.nsf/HeraldryHome.xsp' } });
      return r;
    },
  };
  return jar;
}

const VALID_REQUEST = {
  DODAAC: 'W45XYZ',
  UIC: 'WAHQAA',
  UnitName: '1st Battalion, 77th Armor Regiment',
  RPD: '06',
  SignalCode: 'A',
  FundCode: 'XP',
  ProjectCode: 'HER',
  SupplementaryAddress: '',
  RequestType: 'Heraldic Item',
  RequiredDeliveryDate: '2026-11-15',
  ShipToDODAAC: 'W45XYZ',
  ShipToName: 'Bldg 2270 Supply Room',
  ShipToAddress1: '2270 Warrior Way',
  ShipToAddress2: '',
  ShipToCity: 'Fort Bliss',
  ShipToState: 'TX',
  ShipToZIP: '79916',
  Justification: 'Replacement guidon for change of command ceremony; existing guidon unserviceable.',
  ItemKey: '8345-00-350-1669',
  NSN: '8345-00-350-1669',
  ExceptionData: '',
  UnitOfIssue: 'EA',
  Quantity: '2',
};

module.exports = { bootApp, makeClient, REPO_ROOT, VALID_REQUEST };
