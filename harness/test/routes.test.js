'use strict';

/**
 * Route tests: boot the harness on an ephemeral port with an isolated data directory and
 * drive every Domino-style URL the way a browser would (cookies, form posts, redirects).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { bootApp, REPO_ROOT, VALID_REQUEST } = require('./helpers');
const A = require('../lib/agents');

const BANNER = 'Rendering harness \u2014 synthetic Domino/XPages application, not an HCL Domino server';
const UNID_RE = /[A-F0-9]{32}/;

let h;
let anon;

test.before(async () => {
  h = await bootApp({ now: () => new Date(2026, 8, 1, 6, 30) });
  anon = h.client;
});

test.after(async () => {
  await h.close();
});

function auditEvents() {
  const file = path.join(h.tmp, 'audit.jsonl');
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

async function loginAs(personaId) {
  const c = require('./helpers').makeClient(h.base);
  const r = await c.login(personaId);
  assert.equal(r.chain[0], 303, `login as ${personaId} should redirect`);
  assert.ok(c.cookie.startsWith('DomAuthSessId='), 'session cookie issued');
  return c;
}

function firstUnid(html, form) {
  const re = form === 'case'
    ? /CaseView\.xsp\?documentId=([A-F0-9]{32})/
    : /\/0\/([A-F0-9]{32})\?OpenDocument/;
  const m = html.match(re);
  assert.ok(m, `expected a ${form} link in the page`);
  return m[1];
}

// --- security envelope ------------------------------------------------------------------------

test('every response carries the security headers, the harness banner and no external resources', async () => {
  const pages = ['/heraldry.nsf/HeraldryHome.xsp', '/names.nsf?Login', '/design', '/vetmedals.nsf/CasesByStage?OpenView', '/nonexistent.nsf'];
  for (const p of pages) {
    const r = await anon.get(p);
    assert.equal(r.res.headers.get('x-frame-options'), 'DENY', p);
    assert.equal(r.res.headers.get('x-content-type-options'), 'nosniff', p);
    assert.match(r.res.headers.get('content-security-policy'), /^default-src 'self'/, p);
    assert.equal(r.res.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains', p);
    assert.equal(r.res.headers.get('cache-control'), 'no-store', p);
    assert.match(r.res.headers.get('content-type'), /text\/html; charset=utf-8/, p);
    assert.ok(r.text.includes(BANNER), `${p} carries the harness banner`);
    assert.doesNotMatch(r.text, /https?:\/\/(www\.)?(ibm|hcl|hcltechsw)\.com/i, `${p} loads no vendor resources`);
    assert.doesNotMatch(r.text, /<(script|link)[^>]+(src|href)="https?:\/\//i, `${p} has no external script/css`);
  }
});

test('static assets are served with the right content types and the brand lockup is local', async () => {
  for (const [p, type] of [['/domino.css', 'text/css'], ['/xsp.css', 'text/css'], ['/twisty.js', 'text/javascript'], ['/brand/cognition-lockup-black.svg', 'image/svg+xml']]) {
    const r = await anon.get(p);
    assert.equal(r.status, 200, p);
    assert.ok(r.res.headers.get('content-type').startsWith(type), p);
    assert.equal(r.res.headers.get('x-content-type-options'), 'nosniff', p);
  }
  const home = await anon.get('/heraldry.nsf/HeraldryHome.xsp');
  assert.match(home.text, /src="\/brand\/cognition-lockup-black\.svg"/);
  assert.match(home.text, /href="\/domino\.css"/);
});

test('unknown paths, bad UNIDs and bad methods return generic Domino-style errors', async () => {
  const r404 = await anon.get('/heraldry.nsf/NoSuchView?OpenView');
  assert.equal(r404.status, 404);
  assert.match(r404.text, /HTTP Web Server: .*Not Found/i);
  assert.doesNotMatch(r404.text, /at .*\.js:\d+/, 'no stack trace leaks');

  const bad = await anon.get('/heraldry.nsf/0/not-a-unid?OpenDocument');
  assert.equal(bad.status, 400);
  assert.doesNotMatch(bad.text, /not-a-unid/, 'input is not reflected');

  const gone = await anon.get(`/heraldry.nsf/0/${'0'.repeat(32)}?OpenDocument`);
  assert.equal(gone.status, 404);

  const put = await fetch(`${h.base}/heraldry.nsf/HeraldryHome.xsp`, { method: 'PUT' });
  assert.ok([404, 405].includes(put.status));
  await put.text();

  const tooLong = await anon.get(`/heraldry.nsf/HeraldryHome.xsp?x=${'a'.repeat(3000)}`);
  assert.ok([400, 414].includes(tooLong.status));
});

test('HTML output is escaped: reflected form values and query strings cannot inject markup', async () => {
  const c = await loginAs('sfc-okonkwo');
  const evil = '<img src=x onerror=alert(1)>"';
  const r = await c.post('/heraldry.nsf/Request?CreateDocument', { ...VALID_REQUEST, UnitName: evil, DODAAC: 'BAD' });
  assert.equal(r.status, 400);
  assert.ok(!r.text.includes(evil), 'raw payload is not echoed');
  assert.ok(r.text.includes('&lt;img src=x onerror=alert(1)&gt;'), 'payload is escaped');

  const q = await c.get(`/heraldry.nsf/StatusInquiry.xsp?DocumentNumber=${encodeURIComponent('<b>x</b>')}`);
  assert.equal(q.status, 200);
  assert.ok(!q.text.includes('<b>x</b>'));
});

// --- authentication & session ---------------------------------------------------------------------

test('names.nsf?Login stub: lists personas, issues a Secure/HttpOnly cookie, rejects unknown identities', async () => {
  const page = await anon.get('/names.nsf?Login');
  assert.equal(page.status, 200);
  assert.match(page.text, /EAMS-A/);
  assert.match(page.text, /DOMRELAYSTATE/);
  assert.match(page.text, /name="Username" value="sfc-okonkwo"/);
  assert.doesNotMatch(page.text, /type="password"/, 'no password field anywhere');

  const c = require('./helpers').makeClient(h.base);
  const ok = await c.request('/names.nsf?Login', { method: 'POST', form: { Username: 'whitcombe', RedirectTo: '/design' }, follow: false });
  assert.equal(ok.status, 303);
  assert.equal(ok.location, '/design');
  const sc = ok.res.headers.get('set-cookie');
  assert.match(sc, /^DomAuthSessId=[a-f0-9]{48}; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=900$/);

  const fresh = () => require('./helpers').makeClient(h.base);
  const badId = await fresh().request('/names.nsf?Login', { method: 'POST', form: { Username: 'nobody-here' }, follow: false });
  assert.equal(badId.status, 200);
  assert.match(badId.text, /Authentication failed/);

  const inj = await fresh().request('/names.nsf?Login', { method: 'POST', form: { Username: '../etc' }, follow: false });
  assert.equal(inj.status, 400);

  const open = await fresh().request('/names.nsf?Login', { method: 'POST', form: { Username: 'whitcombe', RedirectTo: 'https://evil.example/x' }, follow: false });
  assert.equal(open.location, '/heraldry.nsf/HeraldryHome.xsp', 'open redirect is neutralised');

  const ev = auditEvents();
  assert.ok(ev.some((e) => e.event === 'authentication_success' && e.user && /Whitcombe/.test(e.user)));
  assert.ok(ev.some((e) => e.event === 'authentication_failure' && e.reason === 'unknown_identity'));
});

test('anonymous users are redirected to login for protected pages and role gates return 403', async () => {
  const r = await anon.request('/heraldry.nsf/Request?OpenForm', { follow: false });
  assert.equal(r.status, 303);
  assert.match(r.location, /^\/names\.nsf\?Login&RedirectTo=%2Fheraldry\.nsf%2FRequest%3FOpenForm/);

  const s4 = await loginAs('sfc-okonkwo');
  const agents = await s4.post('/agents/run', { agent: 'NightlyAging' });
  assert.equal(agents.status, 403);
  assert.match(agents.text, /Error 403/);
  assert.doesNotMatch(agents.text, /\[Admin\]/, 'required roles are not disclosed to the caller');

  const audit = await s4.get('/audit');
  assert.equal(audit.status, 403);

  const vendorOnly = await s4.post('/heraldry.nsf/VendorQueue.xsp', { unid: '0'.repeat(32), action: 'acknowledge' });
  assert.equal(vendorOnly.status, 403);

  const engraverOnly = await s4.post('/vetmedals.nsf/EngravingQueue.xsp', { unid: '0'.repeat(32), action: 'start' });
  assert.equal(engraverOnly.status, 403);

  const ev = auditEvents().filter((e) => e.event === 'authorization_failure');
  assert.ok(ev.length >= 4);
});

test('sessions expire after 15 idle minutes and logout clears the cookie', async () => {
  const c = await loginAs('vasquez-holm');
  const ok = await c.get('/heraldry.nsf/Request?OpenForm');
  assert.equal(ok.status, 200);

  const sid = c.cookie.split('=')[1];
  const s = h.app.sessions.get(sid);
  assert.ok(s);
  s.lastSeen = Date.now() - (15 * 60 * 1000 + 1000);
  const expired = await c.request('/heraldry.nsf/Request?OpenForm', { follow: false });
  assert.equal(expired.status, 303);
  assert.match(expired.location, /names\.nsf\?Login/);
  assert.equal(h.app.sessions.has(sid), false, 'expired session is discarded');

  const c2 = await loginAs('vasquez-holm');
  const out = await c2.request('/names.nsf?Logout', { follow: false });
  assert.equal(out.status, 302);
  assert.match(out.res.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal(c2.cookie, '');
  const after = await c2.request('/heraldry.nsf/Request?OpenForm', { follow: false });
  assert.equal(after.status, 303);
  assert.ok(auditEvents().some((e) => e.event === 'logout'));
});

// --- heraldry.nsf GET routes -----------------------------------------------------------------------

test('GET every required heraldry.nsf page', async () => {
  const root = await anon.request('/', { follow: false });
  assert.equal(root.status, 302);
  assert.equal(root.location, '/heraldry.nsf/HeraldryHome.xsp');

  const home = await anon.get('/heraldry.nsf/HeraldryHome.xsp');
  assert.equal(home.status, 200);
  assert.match(home.text, /Heraldry &amp; Awards Automation System|Heraldry/);
  assert.match(home.text, /StatusInquiry\.xsp/);
  assert.match(home.text, /SESFlag\.xsp/);
  assert.match(home.text, /Request\?OpenForm/);

  const view = await anon.get('/heraldry.nsf/RequestsByStatus?OpenView&Count=100');
  assert.equal(view.status, 200);
  assert.match(view.text, /<table[^>]*class="dominoView"[^>]*border="1"/);
  assert.match(view.text, /twisty/i);
  assert.match(view.text, /\(Not Categorized\)/, 'orphaned RequestLines surface as an uncategorised top-level group, as on a real Domino server');
  const collapsed = await anon.get('/heraldry.nsf/RequestsByStatus?OpenView&CollapseView&Count=100');
  assert.match(collapsed.text, /Released to Vendor/, 'every free-text Status value is its own category');
  assert.match(collapsed.text, /Submitted/);
  assert.match(collapsed.text, /Cancelled/);
  assert.match(collapsed.text, />canceled</, 'legacy free-text status variants are preserved as separate categories');
  const released = await anon.get(`/heraldry.nsf/RequestsByStatus?OpenView&RestrictToCategory=${encodeURIComponent(A.STATUS.RELEASED)}&Count=50`);
  const unid = firstUnid(released.text, 'document');
  assert.ok(unid, 'restricting to a category lists its Request documents');
  assert.equal(h.app.store.db('heraldry.nsf').get(unid).form, 'Request');

  const doc = await anon.get(`/heraldry.nsf/0/${unid}?OpenDocument`);
  assert.equal(doc.status, 200);
  assert.match(doc.text, /DODAAC/);
  assert.match(doc.text, /Document Number|DocumentNumber/);
  assert.match(doc.text, /RequestLine|Line/);

  const inquiry = await anon.get('/heraldry.nsf/StatusInquiry.xsp');
  assert.equal(inquiry.status, 200);
  assert.match(inquiry.text, /name="DocumentNumber"/);

  const vq = await anon.request('/heraldry.nsf/VendorQueue.xsp', { follow: false });
  assert.ok([200, 303].includes(vq.status));

  const design = await anon.get('/design');
  assert.equal(design.status, 200);
  assert.match(design.text, /heraldry\.nsf/);
  assert.match(design.text, /vetmedals\.nsf/);
  assert.match(design.text, /ImportAuthorizationFile/);
  assert.match(design.text, /NightlyAging/);
  assert.match(design.text, /HeraldryHome\.xsp/);
  assert.match(design.text, /\[Vendor\]/);
  const formDetail = await anon.get('/design/heraldry.nsf/form/Request');
  assert.equal(formDetail.status, 200);
  assert.match(formDetail.text, /DODAAC/);
  const agentDetail = await anon.get('/design/vetmedals.nsf/agent/NightlyAging');
  assert.equal(agentDetail.status, 200);
  assert.match(agentDetail.text, /On Error GoTo|NotesSession/);
  const bogus = await anon.get('/design/heraldry.nsf/form/DoesNotExist');
  assert.equal(bogus.status, 404);

  const s4 = await loginAs('sfc-okonkwo');
  const form = await s4.get('/heraldry.nsf/Request?OpenForm');
  assert.equal(form.status, 200);
  assert.match(form.text, /DD Form 1348-6/);
  assert.match(form.text, /name="DODAAC"/);
  assert.match(form.text, /name="RPD"/);
  assert.match(form.text, /name="Justification"/);
  const modifyReleased = await s4.get(`/heraldry.nsf/ModifyRequest.xsp?documentId=${unid}`);
  assert.equal(modifyReleased.status, 403, 'opening a released request in ModifyRequest.xsp shows the legacy block page');
  assert.match(modifyReleased.text, /Error 4091/);
  const openUnid = h.app.store.db('heraldry.nsf').all('Request').find((d) => A.text(d, 'Status') === A.STATUS.SUBMITTED).unid;
  const modify = await s4.get(`/heraldry.nsf/ModifyRequest.xsp?documentId=${openUnid}`);
  assert.equal(modify.status, 200);
  assert.match(modify.text, /Save Changes/);
  const ses = await s4.get('/heraldry.nsf/SESFlag.xsp');
  assert.equal(ses.status, 200);
  assert.match(ses.text, /Senior Executive Service/);
  assert.match(ses.text, /name="ExecutiveName"/);

  const vendor = await loginAs('halvorsen');
  const vqv = await vendor.get('/heraldry.nsf/VendorQueue.xsp');
  assert.equal(vqv.status, 200);
  assert.match(vqv.text, /Released to Vendor|In Production|No open work/);
});

test('views support categories, collapse/expand, paging and RestrictToCategory', async () => {
  const collapsed = await anon.get('/heraldry.nsf/RequestsByStatus?OpenView&CollapseView');
  assert.equal(collapsed.status, 200);
  const expanded = await anon.get('/heraldry.nsf/RequestsByStatus?OpenView&ExpandView&Count=50');
  assert.equal(expanded.status, 200);
  const visibleDocRows = (t) => (t.match(/<tr class="(?:docRow|respRow)[^"]*"(?![^>]*hidden)/g) || []).length;
  assert.equal(visibleDocRows(collapsed.text), 0, 'a collapsed view shows only category rows');
  assert.ok(visibleDocRows(expanded.text) >= 50, 'expanded view renders document rows');
  assert.match(collapsed.text, /categories \(\d+ documents\)/, 'collapsed views page by category, like Domino');
  assert.match(collapsed.text, /Released to Vendor/);
  assert.match(collapsed.text, /Submitted/);
  const restricted = await anon.get(`/heraldry.nsf/RequestsByStatus?OpenView&RestrictToCategory=${encodeURIComponent(A.STATUS.RELEASED)}`);
  assert.equal(restricted.status, 200);
  assert.doesNotMatch(restricted.text, />Cancelled<\/a>/);
  for (const v of ['RequestsByUnit', 'RequestsByDODAAC', 'OpenVendorWork', 'SESFlagQueue', 'HeraldicCatalog', 'StatusInquiry']) {
    const r = await anon.get(`/heraldry.nsf/${v}?OpenView&Count=10`);
    assert.equal(r.status, 200, v);
  }
  const paged = await anon.get('/heraldry.nsf/RequestsByStatus?OpenView&Start=31&Count=30&ExpandView');
  assert.equal(paged.status, 200);
  const badStart = await anon.get('/heraldry.nsf/RequestsByStatus?OpenView&Start=-5&Count=99999');
  assert.equal(badStart.status, 200, 'out-of-range paging parameters fall back to defaults');
});

// --- heraldry.nsf workflow ---------------------------------------------------------------------------

test('DD1348-6 request: validation failures render Domino-style, success creates Request + RequestLine', async () => {
  const s4 = await loginAs('sfc-okonkwo');
  const bad = await s4.post('/heraldry.nsf/Request?CreateDocument', { ...VALID_REQUEST, DODAAC: 'W45', UIC: 'X12345', RPD: '99', Quantity: '500' });
  assert.equal(bad.status, 400);
  assert.match(bad.text, /DODAAC/);
  assert.match(bad.text, /UIC/);
  assert.match(bad.text, /RPD|priority/i);
  assert.match(bad.text, /Quantity|quantity/);
  assert.match(bad.text, /value="W45"/, 'the form is re-rendered with the entered values');

  const created = await s4.request('/heraldry.nsf/Request?CreateDocument', { method: 'POST', form: { ...VALID_REQUEST, UnitName: 'Route Test Battery' }, follow: false });
  assert.equal(created.status, 303);
  assert.match(created.location, /^\/heraldry\.nsf\/0\/[A-F0-9]{32}\?OpenDocument&Saved=1$/);
  const unid = created.location.match(UNID_RE)[0];
  const doc = await s4.get(created.location);
  assert.equal(doc.status, 200);
  assert.match(doc.text, /Route Test Battery/);
  assert.match(doc.text, /W45XYZ\d{8}/, 'MILSTRIP document number rendered');
  assert.match(doc.text, /Submitted/);
  assert.match(doc.text, /8345-?00-?350-?1669/, 'line item rendered on the document');
  assert.match(doc.text, /Guidon, Infantry/, 'ItemDescription looked up from the HeraldicCatalog view');
  assert.match(doc.text, /\$64\.57/, 'UnitPrice looked up from the HeraldicCatalog view');
  assert.match(doc.text, /\$129\.14/, 'ExtendedPrice = Quantity * UnitPrice');

  const stored = h.app.store.db('heraldry.nsf').get(unid);
  assert.equal(stored.form, 'Request');
  assert.equal(h.app.store.db('heraldry.nsf').responses(unid, 'RequestLine').length, 1);

  const ev = auditEvents();
  assert.ok(ev.some((e) => e.event === 'validation_failure' && e.form === 'Request'));
  assert.ok(ev.some((e) => e.event === 'document_create' && e.unid === unid && e.form === 'Request'));
});

test('modify -> status inquiry -> release to vendor -> modify/cancel blocked with legacy error text', async () => {
  const s4 = await loginAs('sfc-okonkwo');
  const created = await s4.request('/heraldry.nsf/Request?CreateDocument', { method: 'POST', form: { ...VALID_REQUEST, UnitName: 'Lifecycle Route Unit' }, follow: false });
  const unid = created.location.match(UNID_RE)[0];
  const db = h.app.store.db('heraldry.nsf');
  const docNo = A.text(db.get(unid), 'DocumentNumber');

  const mod = await s4.request(`/heraldry.nsf/ModifyRequest.xsp?documentId=${unid}`, { method: 'POST', form: { Justification: 'Changed by route test', RPD: '03' }, follow: false });
  assert.equal(mod.status, 303);
  assert.equal(A.text(db.get(unid), 'Justification'), 'Changed by route test');
  assert.equal(A.text(db.get(unid), 'RPD'), '03');
  const badMod = await s4.post(`/heraldry.nsf/ModifyRequest.xsp?documentId=${unid}`, { RPD: '42' });
  assert.equal(badMod.status, 400);

  const found = await anon.post('/heraldry.nsf/StatusInquiry.xsp', { DocumentNumber: docNo, DODAAC: 'W45XYZ' });
  assert.equal(found.status, 200);
  assert.match(found.text, new RegExp(docNo));
  assert.match(found.text, /Submitted/);
  assert.match(found.text, /ModifyRequest\.xsp\?documentId=/, 'modifiable request offers the Modify link');
  const missing = await anon.post('/heraldry.nsf/StatusInquiry.xsp', { DocumentNumber: 'W45XYZ00000000', DODAAC: '' });
  assert.equal(missing.status, 200);
  assert.match(missing.text, /No request was found/);
  const byGet = await anon.get(`/heraldry.nsf/StatusInquiry.xsp?DocumentNumber=${docNo}`);
  assert.match(byGet.text, new RegExp(docNo));

  const notTacom = await s4.post(`/heraldry.nsf/0/${unid}?ReleaseToVendor`, { VendorKey: 'V001' });
  assert.equal(notTacom.status, 403, 'only [TACOM]/[Admin] release to vendor');

  const tacom = await loginAs('whitcombe');
  const vendorKey = A.text(db.all('Vendor').find((v) => A.text(v, 'Active') !== 'No' && A.text(v, 'Status') !== 'Inactive') || db.all('Vendor')[0], 'VendorKey');
  const rel = await tacom.request(`/heraldry.nsf/0/${unid}?ReleaseToVendor`, { method: 'POST', form: { VendorKey: vendorKey }, follow: false });
  assert.equal(rel.status, 303, rel.text.slice(0, 300));
  assert.equal(A.text(db.get(unid), 'Status'), A.STATUS.RELEASED);
  const released = await tacom.get(rel.location);
  assert.match(released.text, /released to/i);

  const blocked = await s4.post(`/heraldry.nsf/ModifyRequest.xsp?documentId=${unid}`, { Justification: 'too late' });
  assert.ok([200, 403].includes(blocked.status));
  assert.ok(blocked.text.includes('Error 4091'), 'legacy error text shown');
  assert.ok(blocked.text.includes('can no longer be modified or cancelled'));
  assert.equal(A.text(db.get(unid), 'Justification'), 'Changed by route test', 'no change applied');

  const cancelBlocked = await s4.post(`/heraldry.nsf/0/${unid}?CancelRequest`, { CancelReason: 'changed my mind' });
  assert.ok([200, 403].includes(cancelBlocked.status));
  assert.ok(cancelBlocked.text.includes('Error 4091'));
  assert.equal(A.text(db.get(unid), 'Status'), A.STATUS.RELEASED);

  const inquiryAfter = await anon.post('/heraldry.nsf/StatusInquiry.xsp', { DocumentNumber: docNo });
  assert.match(inquiryAfter.text, /Released to Vendor/);
  assert.doesNotMatch(inquiryAfter.text, /ModifyRequest\.xsp\?documentId=/, 'released request no longer offers Modify');

  const modifyPage = await s4.get(`/heraldry.nsf/ModifyRequest.xsp?documentId=${unid}`);
  assert.ok(modifyPage.text.includes('Error 4091'), 'ModifyRequest.xsp itself shows the block');

  const vendor = await loginAs('halvorsen');
  const queue = await vendor.get(`/heraldry.nsf/VendorQueue.xsp?vendor=${encodeURIComponent(vendorKey)}`);
  assert.equal(queue.status, 200);
  const otherVendor = await vendor.get('/heraldry.nsf/VendorQueue.xsp?vendor=V999');
  assert.ok([200, 403].includes(otherVendor.status));

  const ack = await tacom.request('/heraldry.nsf/VendorQueue.xsp', { method: 'POST', form: { unid, action: 'acknowledge' }, follow: false });
  assert.equal(ack.status, 303, ack.text.slice(0, 300));
  assert.equal(A.text(db.get(unid), 'Status'), A.STATUS.PRODUCTION);
  const badTracking = await tacom.post('/heraldry.nsf/VendorQueue.xsp', { unid, action: 'acknowledge' });
  assert.equal(badTracking.status, 400, 'acknowledging twice is not a valid transition');
  const ship = await tacom.request('/heraldry.nsf/VendorQueue.xsp', { method: 'POST', form: { unid, action: 'ship', Tracking: '1Z999AA10123456784' }, follow: false });
  assert.equal(ship.status, 303);
  assert.equal(A.text(db.get(unid), 'Status'), A.STATUS.SHIPPED);
  assert.equal(A.text(db.get(unid), 'VendorTracking'), '1Z999AA10123456784');

  const ev = auditEvents();
  assert.ok(ev.some((e) => e.event === 'document_modify' && e.unid === unid));
  assert.ok(ev.some((e) => e.event === 'request_release' && e.unid === unid));
  assert.ok(ev.some((e) => e.event === 'authorization_failure' && e.unid === unid && e.action === 'modify'));
  assert.ok(ev.some((e) => e.event === 'status_inquiry'));
  assert.ok(ev.filter((e) => e.event === 'request_status_change' && e.unid === unid).length === 2);
});

test('cancel before release works, needs a reason, and freezes the request', async () => {
  const s4 = await loginAs('sfc-okonkwo');
  const created = await s4.request('/heraldry.nsf/Request?CreateDocument', { method: 'POST', form: { ...VALID_REQUEST, UnitName: 'Cancel Route Unit' }, follow: false });
  const unid = created.location.match(UNID_RE)[0];
  const db = h.app.store.db('heraldry.nsf');

  const noReason = await s4.post(`/heraldry.nsf/0/${unid}?CancelRequest`, { CancelReason: '' });
  assert.equal(noReason.status, 400);
  assert.equal(A.text(db.get(unid), 'Status'), A.STATUS.SUBMITTED);

  const ok = await s4.request(`/heraldry.nsf/0/${unid}?CancelRequest`, { method: 'POST', form: { CancelReason: 'Ceremony postponed indefinitely' }, follow: false });
  assert.equal(ok.status, 303);
  assert.equal(A.text(db.get(unid), 'Status'), A.STATUS.CANCELLED);
  const page = await s4.get(ok.location);
  assert.match(page.text, /Cancelled/);

  const again = await s4.post(`/heraldry.nsf/ModifyRequest.xsp?documentId=${unid}`, { Justification: 'reopen?' });
  assert.ok(again.text.includes('cancelled') || again.text.includes('Cancelled'));
  assert.ok(auditEvents().some((e) => e.event === 'request_cancel' && e.unid === unid));
});

test('SES flag request: validation, creation, approval by [SESApprover]', async () => {
  const s4 = await loginAs('sfc-okonkwo');
  const bad = await s4.post('/heraldry.nsf/SESFlag.xsp?action=create', { ExecutiveName: '', ExecutiveTier: 'Tier 2', Quantity: '9', DODAAC: 'W45XYZ', UIC: 'WAHQAA' });
  assert.equal(bad.status, 400);
  const good = {
    ExecutiveName: 'Dr. Synthetic Example',
    ExecutiveTitle: 'Deputy to the Commanding General',
    ExecutiveTier: 'Tier 2',
    Organization: 'U.S. Army Tank-automotive and Armaments Command',
    FlagType: 'SES Positional Color (Indoor)',
    Quantity: '1',
    DODAAC: 'W45XYZ',
    UIC: 'WAHQAA',
    ShipToAddress: '6501 E 11 Mile Rd, Warren, MI 48397',
    Justification: 'New SES appointment effective 1 October; positional color required for office display.',
  };
  const created = await s4.request('/heraldry.nsf/SESFlag.xsp?action=create', { method: 'POST', form: good, follow: false });
  assert.equal(created.status, 303, created.text.slice(0, 400));
  assert.match(created.location, /Saved=SES-2026-\d{4}/);
  const num = decodeURIComponent(created.location.split('Saved=')[1]);
  const db = h.app.store.db('heraldry.nsf');
  const doc = db.findOne('SESFlagRequest', 'SESFlagNumber', num);
  assert.ok(doc);
  assert.equal(A.text(doc, 'Status'), 'Submitted');

  const inquiry = await anon.post('/heraldry.nsf/StatusInquiry.xsp', { DocumentNumber: num });
  assert.match(inquiry.text, new RegExp(num), 'SES flag numbers are searchable in status inquiry');

  const denied = await s4.post('/heraldry.nsf/SESFlag.xsp?action=approve', { unid: doc.unid });
  assert.equal(denied.status, 403);
  const approver = await loginAs('whitcombe');
  const approved = await approver.request('/heraldry.nsf/SESFlag.xsp?action=approve', { method: 'POST', form: { unid: doc.unid }, follow: false });
  assert.equal(approved.status, 303, approved.text.slice(0, 300));
  assert.equal(A.text(db.get(doc.unid), 'Status'), 'Approved');
  const queue = await approver.get('/heraldry.nsf/SESFlagQueue?OpenView&ExpandView');
  assert.match(queue.text, new RegExp(num));
});

// --- vetmedals.nsf GET routes -----------------------------------------------------------------------

test('GET every required vetmedals.nsf page', async () => {
  const root = await anon.request('/vetmedals.nsf', { follow: false });
  assert.equal(root.status, 302);

  const stage = await anon.get('/vetmedals.nsf/CasesByStage?OpenView');
  assert.equal(stage.status, 200);
  assert.match(stage.text, /Authorized/);
  assert.match(stage.text, /Engraving/);
  assert.match(stage.text, /class="dominoView"/);
  assert.match(stage.text, /\(Not Categorized\)/, 'orphaned AwardLines sort first as an uncategorised group');
  const expanded = await anon.get('/vetmedals.nsf/CasesByStage?OpenView&ExpandView&Count=300');
  assert.equal(expanded.status, 200);
  const vet = h.app.store.db('vetmedals.nsf');
  const caseUnid = [...expanded.text.matchAll(/\/vetmedals\.nsf\/0\/([A-F0-9]{32})\?OpenDocument/g)].map((m) => m[1]).find((u) => vet.get(u) && vet.get(u).form === 'AwardsCase');
  assert.ok(caseUnid, 'CasesByStage links to AwardsCase documents');

  const cv = await anon.get(`/vetmedals.nsf/CaseView.xsp?documentId=${caseUnid}`);
  assert.equal(cv.status, 200);
  assert.match(cv.text, /Case Number|CaseNumber/);
  assert.match(cv.text, /Award/);
  assert.match(cv.text, /Stage/);
  assert.match(cv.text, /Status history|StatusHistory/i);
  const cvMissing = await anon.get(`/vetmedals.nsf/CaseView.xsp?documentId=${'F'.repeat(32)}`);
  assert.equal(cvMissing.status, 404);
  const cvNoId = await anon.request('/vetmedals.nsf/CaseView.xsp', { follow: false });
  assert.ok([200, 302, 303].includes(cvNoId.status));

  const eq = await anon.get('/vetmedals.nsf/EngravingQueue.xsp');
  assert.equal(eq.status, 200);
  assert.match(eq.text, /Queued|In Progress/);
  const eqDone = await anon.get('/vetmedals.nsf/EngravingQueue.xsp?status=complete');
  assert.equal(eqDone.status, 200);

  const wp = await anon.get('/vetmedals.nsf/WarehousePick?OpenView');
  assert.equal(wp.status, 200);
  assert.match(wp.text, /Warehouse/);
  assert.match(wp.text, /Pick|Bin/);

  const csr = await anon.get('/vetmedals.nsf/CSRLookup.xsp');
  assert.equal(csr.status, 200);
  assert.match(csr.text, /name="q"/);
  const csrHit = await anon.get('/vetmedals.nsf/CSRLookup.xsp?q=Bronze');
  assert.equal(csrHit.status, 200);
  const csrCase = await anon.get(`/vetmedals.nsf/CSRLookup.xsp?q=${encodeURIComponent(A.text(h.app.store.db('vetmedals.nsf').get(caseUnid), 'CaseNumber'))}`);
  assert.match(csrCase.text, /CaseView\.xsp\?documentId=/);
  const csrJunk = await anon.get(`/vetmedals.nsf/CSRLookup.xsp?q=${encodeURIComponent('<script>alert(1)</script>')}`);
  assert.equal(csrJunk.status, 200);
  assert.doesNotMatch(csrJunk.text, /<script>alert/);

  for (const v of ['CasesByAuthDate', 'AgingCases', 'AssemblyQueue', 'ShipConfirm', 'CSRLookup', 'EngravingQueue']) {
    const r = await anon.get(`/vetmedals.nsf/${v}?OpenView&Count=10`);
    assert.equal(r.status, 200, v);
  }
  const doc = await anon.get(`/vetmedals.nsf/0/${caseUnid}?OpenDocument`);
  assert.equal(doc.status, 200);
  assert.match(doc.text, /\$UpdatedBy|Updated By/i);
});

// --- vetmedals.nsf workflow ---------------------------------------------------------------------------

test('awards case: advance through every stage with role gates, side documents and audit trail', async () => {
  const db = h.app.store.db('vetmedals.nsf');
  const kase = db.all('AwardsCase').find((d) => A.text(d, 'Stage') === A.STAGE.AUTHORIZED && A.caseHasEngravableLines(db, d));
  assert.ok(kase, 'an Authorized case with an engravable line exists in the seed');
  const url = `/vetmedals.nsf/CaseView.xsp?documentId=${kase.unid}&action=advance`;

  const warehouse = await loginAs('ferreira-lund');
  const denied = await warehouse.post(url, {});
  assert.equal(denied.status, 403, 'Warehouse cannot advance an Authorized case');
  assert.match(denied.text, /Your role cannot advance/);

  const csr = await loginAs('vasquez-holm');
  const toEngraving = await csr.request(url, { method: 'POST', form: {}, follow: false });
  assert.equal(toEngraving.status, 303, toEngraving.text.slice(0, 300));
  assert.match(toEngraving.location, /Advanced=Engraving/);
  assert.equal(A.text(db.get(kase.unid), 'Stage'), A.STAGE.ENGRAVING);
  const jobNo = A.text(db.get(kase.unid), 'EngravingJobNumber');
  assert.ok(jobNo, 'EngravingJob side document created');
  const job = db.findOne('EngravingJob', 'JobNumber', jobNo);
  assert.equal(A.text(job, 'JobStatus'), 'Queued');
  const banner = await csr.get(toEngraving.location);
  assert.match(banner.text, /Case advanced to Engraving/);

  const assembler = await loginAs('kowalczyk');
  const assemblerDenied = await assembler.post(url, {});
  assert.equal(assemblerDenied.status, 403, 'an Assembler cannot advance from Engraving (only [Engraver], or supervisory [TACOM]/[Admin], per the DocAuthors formula)');

  const engraver = await loginAs('amundsen');
  const start = await engraver.request('/vetmedals.nsf/EngravingQueue.xsp', { method: 'POST', form: { unid: job.unid, action: 'start', Machine: 'Laser-2' }, follow: false });
  assert.equal(start.status, 303, start.text.slice(0, 300));
  assert.equal(A.text(db.get(job.unid), 'JobStatus'), 'In Progress');
  assert.equal(A.text(db.get(job.unid), 'Machine'), 'Laser-2');
  const complete = await engraver.request('/vetmedals.nsf/EngravingQueue.xsp', { method: 'POST', form: { unid: job.unid, action: 'complete', Proof: '1' }, follow: false });
  assert.equal(complete.status, 303);
  assert.equal(A.text(db.get(job.unid), 'JobStatus'), 'Complete');
  assert.equal(A.text(db.get(kase.unid), 'Stage'), A.STAGE.ASSEMBLY, 'completing the job moves the case to Assembly/QC');

  const engraverDenied = await engraver.post(url, {});
  assert.equal(engraverDenied.status, 403, 'an Engraver cannot advance from Assembly/QC');
  const toWarehouse = await assembler.request(url, { method: 'POST', form: {}, follow: false });
  assert.equal(toWarehouse.status, 303);
  assert.equal(A.text(db.get(kase.unid), 'Stage'), A.STAGE.WAREHOUSE);
  assert.equal(A.text(db.get(kase.unid), 'QCResult'), 'Pass');
  assert.ok(A.text(db.get(kase.unid), 'PickBin'));

  const wp = await anon.get('/vetmedals.nsf/WarehousePick?OpenView&ExpandView&Count=500');
  assert.match(wp.text, new RegExp(A.text(kase, 'CaseNumber')), 'case appears on the pick list');

  const toShipped = await warehouse.request(url, { method: 'POST', form: {}, follow: false });
  assert.equal(toShipped.status, 303);
  assert.equal(A.text(db.get(kase.unid), 'Stage'), A.STAGE.SHIPPED);
  const tracking = A.text(db.get(kase.unid), 'TrackingNumber');
  assert.ok(tracking, 'ShipmentRecord created with a tracking number');
  assert.ok(db.findOne('ShipmentRecord', 'TrackingNumber', tracking));

  const toClosed = await csr.request(url, { method: 'POST', form: {}, follow: false });
  assert.equal(toClosed.status, 303);
  assert.equal(A.text(db.get(kase.unid), 'Stage'), A.STAGE.CLOSED);
  assert.equal(A.text(db.get(kase.unid), 'AgingFlag'), '');
  for (const line of db.findAll('AwardLine', 'ParentCaseNumber', A.text(kase, 'CaseNumber'))) {
    assert.equal(A.text(line, 'LineStatus'), 'Shipped');
  }

  const past = await csr.post(url, {});
  assert.equal(past.status, 400, 'closed cases cannot advance');

  const view = await csr.get(`/vetmedals.nsf/CaseView.xsp?documentId=${kase.unid}`);
  assert.match(view.text, /Closed/);
  assert.match(view.text, new RegExp(tracking));
  const history = db.get(kase.unid).items.StatusHistory;
  assert.ok(history.length >= 5, 'status history records every transition');

  const changes = auditEvents().filter((e) => e.event === 'case_stage_change' && e.unid === kase.unid);
  assert.deepEqual(changes.map((e) => e.to), [A.STAGE.ENGRAVING, A.STAGE.ASSEMBLY, A.STAGE.WAREHOUSE, A.STAGE.SHIPPED, A.STAGE.CLOSED]);
});

test('case notes and hold require [CSR]; notes appear on CaseView', async () => {
  const db = h.app.store.db('vetmedals.nsf');
  const kase = db.all('AwardsCase').find((d) => A.text(d, 'Stage') === A.STAGE.ENGRAVING);
  const engraver = await loginAs('amundsen');
  const denied = await engraver.post(`/vetmedals.nsf/CaseView.xsp?documentId=${kase.unid}&action=note`, { Summary: 'x' });
  assert.equal(denied.status, 403);

  const csr = await loginAs('vasquez-holm');
  const empty = await csr.post(`/vetmedals.nsf/CaseView.xsp?documentId=${kase.unid}&action=note`, { Summary: '' });
  assert.equal(empty.status, 400);
  const note = await csr.request(`/vetmedals.nsf/CaseView.xsp?documentId=${kase.unid}&action=note`, { method: 'POST', form: { Summary: 'Veteran called re: engraving spelling', NoteType: 'Phone Call', ContactName: 'Synthetic Caller', Body: 'Confirmed spelling of last name.' }, follow: false });
  assert.equal(note.status, 303, note.text.slice(0, 300));
  const page = await csr.get(note.location);
  assert.match(page.text, /Veteran called re: engraving spelling/);
  assert.equal(db.findAll('CaseNote', 'ParentCaseNumber', A.text(kase, 'CaseNumber')).some((n) => A.text(n, 'Summary') === 'Veteran called re: engraving spelling'), true);

  const hold = await csr.request(`/vetmedals.nsf/CaseView.xsp?documentId=${kase.unid}&action=hold`, { method: 'POST', form: { HoldReason: 'Address returned undeliverable' }, follow: false });
  assert.equal(hold.status, 303, hold.text.slice(0, 300));
  assert.equal(A.text(db.get(kase.unid), 'Stage'), A.STAGE.HOLD);
  const release = await csr.request(`/vetmedals.nsf/CaseView.xsp?documentId=${kase.unid}&action=release`, { method: 'POST', form: {}, follow: false });
  assert.equal(release.status, 303);
  assert.equal(A.text(db.get(kase.unid), 'Stage'), A.STAGE.ENGRAVING, 'hold release returns to prior stage');

  const unknown = await csr.post(`/vetmedals.nsf/CaseView.xsp?documentId=${kase.unid}&action=zap`, {});
  assert.equal(unknown.status, 400);
});

// --- agents menu -------------------------------------------------------------------------------------

test('Agents menu: NightlyAging and ImportAuthorizationFile run from the web with role gates and audit', async () => {
  const s4 = await loginAs('sfc-okonkwo');
  const denied = await s4.get('/agents');
  assert.ok([200, 403].includes(denied.status));

  const admin = await loginAs('whitcombe');
  const menu = await admin.get('/agents');
  assert.equal(menu.status, 200);
  assert.match(menu.text, /NightlyAging/);
  assert.match(menu.text, /ImportAuthorizationFile/);
  assert.match(menu.text, /HRC_AWD_\d{8}_\d\.txt/);
  assert.match(menu.text, /nprc_awd_\d{8}_b\d+\.dat/);

  const aging = await admin.post('/agents/run', { agent: 'NightlyAging' });
  assert.equal(aging.status, 200);
  assert.match(aging.text, /Done - processed \d+/);
  assert.match(aging.text, /AgingCases\?OpenView/);
  const vet = h.app.store.db('vetmedals.nsf');
  assert.ok(vet.all('AwardsCase').some((d) => A.text(d, 'AgingFlag') === 'Red'));
  const agingView = await admin.get('/vetmedals.nsf/AgingCases?OpenView&ExpandView&Count=20');
  assert.equal(agingView.status, 200);
  assert.match(agingView.text, /RED - over 75 days/);

  const samples = fs.readdirSync(path.join(REPO_ROOT, 'export', 'authorization-files')).filter((f) => /\.(txt|dat)$/.test(f)).sort();
  const before = vet.all('AwardsCase').length;
  const imp = await admin.post('/agents/run', { agent: 'ImportAuthorizationFile', sample: samples[0] });
  assert.equal(imp.status, 200, imp.text.slice(0, 300));
  assert.match(imp.text, /AuthorizationFile document/);
  assert.match(imp.text, /Imported/);
  assert.ok(vet.all('AwardsCase').length > before, 'cases were created');

  const dup = await admin.post('/agents/run', { agent: 'ImportAuthorizationFile', sample: samples[0] });
  assert.equal(dup.status, 200);
  assert.match(dup.text, /already|duplicate|checksum/i, 're-importing the same file is detected');

  const traversal = await admin.post('/agents/run', { agent: 'ImportAuthorizationFile', sample: '../../package.json' });
  assert.equal(traversal.status, 400);
  const notFound = await admin.post('/agents/run', { agent: 'ImportAuthorizationFile', sample: 'nope.txt' });
  assert.equal(notFound.status, 404);
  const unknownAgent = await admin.post('/agents/run', { agent: 'DropEverything' });
  assert.equal(unknownAgent.status, 400);

  const rebuild = await admin.post('/agents/run', { agent: 'RebuildStatusInquiryIndex' });
  assert.equal(rebuild.status, 200);
  assert.match(rebuild.text, /documents scanned/);
  const archive = await admin.post('/agents/run', { agent: 'ArchiveClosedCases' });
  assert.equal(archive.status, 200);
  assert.match(archive.text, /dry run/);

  const importer = await loginAs('hrc-transfer');
  const importerAging = await importer.post('/agents/run', { agent: 'NightlyAging' });
  assert.equal(importerAging.status, 403, '[Importer] may import but not run aging');
  const importerArchive = await importer.post('/agents/run', { agent: 'ArchiveClosedCases' });
  assert.equal(importerArchive.status, 403);

  const runs = auditEvents().filter((e) => e.event === 'agent_run');
  assert.ok(runs.some((e) => e.agent === 'NightlyAging' && e.red > 0));
  assert.ok(runs.some((e) => e.agent === 'ImportAuthorizationFile' && e.cases > 0));

  const auditPage = await admin.get('/audit');
  assert.equal(auditPage.status, 200);
  assert.match(auditPage.text, /agent_run/);
  assert.match(auditPage.text, /case_stage_change/);
});

test('multipart upload of an authorization file runs the importer against the uploaded content', async () => {
  const admin = await loginAs('whitcombe');
  const dir = path.join(REPO_ROOT, 'export', 'authorization-files');
  const nprc = fs.readdirSync(dir).filter((f) => /^nprc_awd_.*\.dat$/.test(f)).sort()[0];
  assert.ok(nprc, 'an NPRC sample file is shipped');
  const content = fs.readFileSync(path.join(dir, nprc), 'utf8').replace(/^(NPRC-AWD\|v2\|)\d{4}-\d{2}-\d{2}\|B\d+/m, '$12026-09-01|B99');
  const boundary = '----haasTestBoundary';
  const body = [
    `--${boundary}\r\nContent-Disposition: form-data; name="agent"\r\n\r\nImportAuthorizationFile\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="force"\r\n\r\n1\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="upload"; filename="nprc_awd_20260901_b99.dat"\r\nContent-Type: text/plain\r\n\r\n${content}\r\n`,
    `--${boundary}--\r\n`,
  ].join('');
  const res = await fetch(`${h.base}/agents/run`, { method: 'POST', headers: { Cookie: admin.cookie, 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body });
  const text = await res.text();
  assert.equal(res.status, 200, text.slice(0, 300));
  assert.match(text, /nprc_awd_20260901_b99\.dat/);
  assert.match(text, /Imported|Rejected/);
});

// --- persistence ---------------------------------------------------------------------------------------

test('changes made through routes survive a flush and reopen of the store', async () => {
  const db = h.app.store.db('heraldry.nsf');
  const created = db.all('Request').filter((d) => A.text(d, 'UnitName') === 'Route Test Battery');
  assert.equal(created.length, 1);
  h.app.store.flush();
  const { Store } = require('../lib/store');
  const reopened = Store.open({ dataDir: path.join(h.tmp, 'data'), exportDir: path.join(REPO_ROOT, 'export', 'dxl'), log: () => {} });
  const again = reopened.db('heraldry.nsf').all('Request').filter((d) => A.text(d, 'UnitName') === 'Route Test Battery');
  assert.equal(again.length, 1);
  assert.equal(again[0].unid, created[0].unid);
});
