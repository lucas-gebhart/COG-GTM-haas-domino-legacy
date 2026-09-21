'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../lib/store');
const A = require('../lib/agents');
const P = require('../lib/personas');
const { loadDesign } = require('../lib/dxl');
const { ViewEngine } = require('../lib/views');
const { REPO_ROOT, VALID_REQUEST } = require('./helpers');

const NOW = new Date(2026, 8, 1, 6, 30);
const AUTH_DIR = path.join(REPO_ROOT, 'export', 'authorization-files');

let tmp;
let store;
let her;
let vet;
const designs = {};
const engines = {};

function ctxFor(db, personaId, now = NOW) {
  const user = typeof personaId === 'string' ? P.byId(personaId) : personaId;
  return { db, design: designs[db.name], engine: engines[db.name], user, now, log: () => {} };
}

function pad(n, w) {
  return String(n).padStart(w, '0');
}

/** Build an HRC fixed-width case record (type 10) from named parts. */
function hrcCase({ ref, last, first, mi = '', rel = 'SE', zip = '19111', reqLast, reqFirst }) {
  const f = (s, w) => String(s || '').padEnd(w).slice(0, w);
  return `10${f(ref, 10)}${f(last, 30)}${f(first, 20)}${f(mi, 1)}${f('12345678', 8)}${'19651001'}${'19680930'}${f(rel, 2)}${f(reqLast || last, 30)}${f(reqFirst || first, 20)}${f('100 Main St', 30)}${f('Philadelphia', 20)}${f('PA', 2)}${f(zip, 10)}N${'R'}${f('SGT', 12)}`;
}

function hrcAward({ ref, code = 'ARCOM', qty = 1, devices = 0, engrave = 'Y', text = '', authority = 'HRC Awards Branch' }) {
  const f = (s, w) => String(s || '').padEnd(w).slice(0, w);
  return `20${f(ref, 10)}${f(code, 6)}${pad(qty, 2)}${pad(devices, 2)}${engrave}${f(text, 40)}${f(authority, 30)}`;
}

function hrcFile(cases, awards, opts = {}) {
  const header = `01${'20260615'}${'HRC00007'.padEnd(8)}${'20260613'}${pad(cases.length + awards.length + 2, 6)}`;
  const trailer = `99${pad(opts.declCases === undefined ? cases.length : opts.declCases, 6)}${pad(awards.length, 6)}${'A1B2C3D4'}`;
  const body = [header, ...cases, ...awards];
  if (!opts.noTrailer) {
    body.push(trailer);
  }
  return body.join('\n') + '\n';
}

test.before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'haas-agents-'));
  store = Store.open({ dataDir: path.join(tmp, 'data'), log: () => {} });
  her = store.db('heraldry.nsf');
  vet = store.db('vetmedals.nsf');
  for (const n of ['heraldry.nsf', 'vetmedals.nsf']) {
    designs[n] = loadDesign(path.join(REPO_ROOT, 'nsf', n));
    engines[n] = new ViewEngine(designs[n], store.db(n), { now: () => NOW });
  }
});

test.after(() => {
  store.flush();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// --- store ------------------------------------------------------------------------------------

test('store: seeds both databases from the DXL export with the documented volumes', () => {
  assert.equal(her.documents.length, 3343);
  assert.equal(vet.documents.length, 16041);
  assert.equal(her.all('Request').length, 800);
  assert.equal(vet.all('AwardsCase').length, 3000);
  assert.equal(vet.all('AwardLine').length, 7000);
  assert.equal(her.profileValue('AgingAmberDays', 'x'), 'x', 'heraldry profile does not define aging thresholds');
  assert.equal(Number(vet.profileValue('AgingAmberDays', 0)), 60);
  assert.equal(Number(vet.profileValue('AgingRedDays', 0)), 75);
});

test('store: create/update stamp $UpdatedBy and $Revisions, findOne/findAll index by item', () => {
  const doc = her.create('Vendor', { VendorKey: 'TEST-V', VendorName: 'Test Vendor' }, { user: 'CN=Test/O=TACOM', clock: () => NOW });
  assert.match(doc.unid, /^[0-9A-F]{32}$/);
  assert.deepEqual(doc.updatedBy, ['CN=Test/O=TACOM']);
  assert.equal(doc.revisions.length, 1);
  assert.equal(her.get(doc.unid), doc);
  assert.equal(her.findOne('Vendor', 'VendorKey', 'TEST-V'), doc);
  her.update(doc, { VendorName: 'Renamed' }, { user: 'CN=Other/O=TACOM', clock: () => new Date(NOW.getTime() + 1000) });
  assert.equal(doc.items.VendorName, 'Renamed');
  assert.deepEqual(doc.updatedBy, ['CN=Test/O=TACOM', 'CN=Other/O=TACOM']);
  assert.equal(doc.revisions.length, 2);
  assert.equal(her.findAll('Vendor', 'VendorKey', 'TEST-V').length, 1);
  assert.equal(her.findOne('Vendor', 'VendorKey', 'NOPE'), null);
});

test('store: flush persists and a reopened store sees the change; reset removes it', () => {
  const doc = her.create('Vendor', { VendorKey: 'PERSIST-V', VendorName: 'Persist' }, { user: 'CN=Test/O=TACOM', clock: () => NOW });
  store.flush();
  const again = Store.open({ dataDir: path.join(tmp, 'data'), log: () => {} });
  const found = again.db('heraldry.nsf').get(doc.unid);
  assert.ok(found, 'document survives reopen');
  assert.equal(found.items.VendorName, 'Persist');
  assert.equal(again.db('heraldry.nsf').documents.length, her.documents.length);
  const removed = Store.reset(path.join(tmp, 'data'));
  assert.ok(removed.length >= 1, 'reset removes persisted json files');
  const fresh = Store.open({ dataDir: path.join(tmp, 'data'), log: () => {} });
  assert.equal(fresh.db('heraldry.nsf').get(doc.unid), null);
  assert.equal(fresh.db('heraldry.nsf').documents.length, 3343);
});

test('store: nextSerial is monotonic per counter', () => {
  const a = her.nextSerial('TestCounter');
  const b = her.nextSerial('TestCounter');
  assert.equal(b, a + 1);
});

// --- heraldry workflow --------------------------------------------------------------------------

test('heraldry: createRequest enforces the DD 1348-6 validations from the form', () => {
  const ctx = ctxFor(her, 'sfc-okonkwo');
  const bad = A.createRequest(ctx, { ...VALID_REQUEST, DODAAC: 'W45', UIC: 'XAHQAA', RPD: '16', Quantity: '0', ShipToZIP: '1' });
  assert.equal(bad.ok, false);
  const msgs = bad.errors.join(' | ');
  assert.match(msgs, /DODAAC/);
  assert.match(msgs, /UIC/);
  assert.match(msgs, /RPD|priority/i);
  assert.match(msgs, /Quantity/i);
  assert.match(msgs, /ZIP/);
  const missing = A.createRequest(ctx, { ...VALID_REQUEST, UnitName: '', Justification: '' });
  assert.equal(missing.ok, false);
  assert.match(missing.errors.join(' '), /Unit|required/i);
});

test('heraldry: createRequest rejects overlong and control-character input', () => {
  const ctx = ctxFor(her, 'sfc-okonkwo');
  const r = A.createRequest(ctx, { ...VALID_REQUEST, UnitName: 'x'.repeat(300) });
  assert.equal(r.ok, false);
  const r2 = A.createRequest(ctx, { ...VALID_REQUEST, Justification: 'ok\u0000bad' });
  assert.equal(r2.ok, false);
});

test('heraldry: full lifecycle create -> modify -> release -> blocked modify/cancel', () => {
  const s4 = ctxFor(her, 'sfc-okonkwo');
  const created = A.createRequest(s4, { ...VALID_REQUEST, UnitName: 'Lifecycle Test Unit' });
  assert.equal(created.ok, true, JSON.stringify(created.errors));
  const doc = created.doc;
  assert.match(doc.items.DocumentNumber, /^W45XYZ\d{4}\d{4}$/, 'MILSTRIP document number: DODAAC + Julian date + serial');
  assert.equal(doc.items.Status, A.STATUS.SUBMITTED);
  assert.equal(doc.items.DODAAC, 'W45XYZ');
  const lines = her.findAll('RequestLine', 'ParentDocNumber', doc.items.DocumentNumber);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].parent, doc.unid, 'RequestLine is a response document of the Request');
  assert.equal(A.isReleased(her, doc), false);

  const mod = A.modifyRequest(s4, doc, { ...VALID_REQUEST, Justification: 'Updated justification text', Quantity: '3' });
  assert.equal(mod.ok, true, JSON.stringify(mod.errors));
  assert.equal(doc.items.Justification, 'Updated justification text');
  assert.ok(doc.items.StatusHistory.length >= 1 || doc.items.ModifiedCount >= 1);

  const vendor = her.all('Vendor').find((v) => v.items.Active === 'Yes' || v.items.Status === 'Active') || her.all('Vendor')[0];
  const rel = A.releaseToVendor(ctxFor(her, 'whitcombe'), doc, vendor.items.VendorKey);
  assert.equal(rel.ok, true, JSON.stringify(rel.errors));
  assert.equal(doc.items.Status, A.STATUS.RELEASED);
  assert.ok(doc.items.ReleasedDate);
  assert.equal(doc.items.VendorKey, vendor.items.VendorKey);
  assert.equal(A.isReleased(her, doc), true);

  const blocked = A.modifyRequest(s4, doc, { ...VALID_REQUEST, Justification: 'should not apply' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.errors[0], A.MSG_RELEASED_NOMODIFY);
  assert.equal(doc.items.Justification, 'Updated justification text');

  const cancelBlocked = A.cancelRequest(s4, doc, 'too late');
  assert.equal(cancelBlocked.ok, false);
  assert.equal(cancelBlocked.errors[0], A.MSG_RELEASED_NOMODIFY);

  const again = A.releaseToVendor(ctxFor(her, 'whitcombe'), doc, vendor.items.VendorKey);
  assert.equal(again.ok, false, 'cannot release twice');
});

test('heraldry: cancelRequest works before release and requires a reason', () => {
  const s4 = ctxFor(her, 'sfc-okonkwo');
  const { doc } = A.createRequest(s4, { ...VALID_REQUEST, UnitName: 'Cancel Test Unit' });
  const noReason = A.cancelRequest(s4, doc, '');
  assert.equal(noReason.ok, false);
  const ok = A.cancelRequest(s4, doc, 'Duplicate of an earlier requisition');
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.equal(doc.items.Status, A.STATUS.CANCELLED);
  assert.ok(doc.items.CancelledDate);
  assert.equal(A.modifyRequest(s4, doc, VALID_REQUEST).ok, false, 'cancelled requests are frozen');
});

test('heraldry: statusInquiry finds by document number and rejects garbage', () => {
  const s4 = ctxFor(her, 'sfc-okonkwo');
  const { doc } = A.createRequest(s4, { ...VALID_REQUEST, UnitName: 'Inquiry Test Unit' });
  const hit = A.statusInquiry(her, doc.items.DocumentNumber, 'W45XYZ');
  assert.equal(hit.ok, true);
  assert.equal(hit.hits.length, 1);
  assert.equal(hit.hits[0].unid, doc.unid);
  assert.deepEqual(hit.canModify, [true]);
  const wrongDodaac = A.statusInquiry(her, doc.items.DocumentNumber, 'ZZZZZZ');
  assert.equal(wrongDodaac.ok, false);
  const miss = A.statusInquiry(her, 'W45XYZ00000000', 'W45XYZ');
  assert.equal(miss.ok, false);
  const bad = A.statusInquiry(her, '<script>', '');
  assert.equal(bad.ok, false);
});

// --- vetmedals workflow ---------------------------------------------------------------------------

test('vetmedals: stage machine helpers', () => {
  assert.equal(A.nextStage(A.STAGE.AUTHORIZED, true), A.STAGE.ENGRAVING);
  assert.equal(A.nextStage(A.STAGE.AUTHORIZED, false), A.STAGE.ASSEMBLY, 'cases without engravable lines skip Engraving');
  assert.equal(A.nextStage(A.STAGE.SHIPPED), A.STAGE.CLOSED);
  assert.ok(!A.nextStage(A.STAGE.CLOSED));
  assert.equal(A.isValidStageTransition(A.STAGE.ENGRAVING, A.STAGE.ASSEMBLY), true);
  assert.equal(A.isValidStageTransition(A.STAGE.ENGRAVING, A.STAGE.SHIPPED), false);
  assert.equal(A.isValidStageTransition(A.STAGE.CLOSED, A.STAGE.AUTHORIZED), false);
  assert.equal(A.roleMayAdvance(['[Engraver]'], A.STAGE.ENGRAVING), true);
  assert.equal(A.roleMayAdvance(['[Engraver]'], A.STAGE.WAREHOUSE), false);
  assert.equal(A.roleMayAdvance(['[Warehouse]'], A.STAGE.WAREHOUSE), true);
  assert.equal(A.roleMayAdvance(['[TACOM]'], A.STAGE.WAREHOUSE), true);
  assert.equal(A.roleMayAdvance([], A.STAGE.AUTHORIZED), false);
});

test('vetmedals: advanceCase walks Authorized -> ... -> Closed with side documents and role gates', () => {
  const kase = vet.all('AwardsCase').find((d) => d.items.Stage === A.STAGE.AUTHORIZED && d.items.EngravingRequired === 'Yes');
  assert.ok(kase, 'an Authorized case with engraving exists in the seed');
  const caseNo = kase.items.CaseNumber;

  const denied = A.advanceCase(ctxFor(vet, 'ferreira-lund'), kase);
  assert.equal(denied.ok, false);
  assert.equal(denied.forbidden, true);
  assert.equal(kase.items.Stage, A.STAGE.AUTHORIZED);

  const csr = ctxFor(vet, 'vasquez-holm');
  const r1 = A.advanceCase(csr, kase);
  assert.equal(r1.ok, true, JSON.stringify(r1.errors));
  assert.equal(kase.items.Stage, A.STAGE.ENGRAVING);
  assert.ok(kase.items.EngravingJobNumber);
  const job = vet.findOne('EngravingJob', 'JobNumber', kase.items.EngravingJobNumber);
  assert.ok(job, 'EngravingJob created');
  assert.ok(vet.findAll('AwardLine', 'ParentCaseNumber', caseNo).every((l) => l.items.LineStatus === A.STAGE.ENGRAVING));

  const plainCsr = ctxFor(vet, { name: 'CN=Plain CSR/OU=CHPSID/O=TACOM', roles: ['[CSR]'] });
  assert.equal(A.advanceCase(plainCsr, kase).ok, false, 'a CSR without [TACOM] cannot complete engraving');
  const r2 = A.advanceCase(ctxFor(vet, 'amundsen'), kase);
  assert.equal(r2.ok, true);
  assert.equal(kase.items.Stage, A.STAGE.ASSEMBLY);
  assert.equal(job.items.JobStatus, 'Complete');

  const r3 = A.advanceCase(ctxFor(vet, 'kowalczyk'), kase);
  assert.equal(r3.ok, true);
  assert.equal(kase.items.Stage, A.STAGE.WAREHOUSE);
  assert.equal(kase.items.QCResult, 'Pass');
  assert.match(kase.items.PickBin, /^[A-D]-\d{2}-\d$/);

  const r4 = A.advanceCase(ctxFor(vet, 'ferreira-lund'), kase);
  assert.equal(r4.ok, true);
  assert.equal(kase.items.Stage, A.STAGE.SHIPPED);
  assert.ok(kase.items.TrackingNumber);
  assert.ok(vet.findOne('ShipmentRecord', 'TrackingNumber', kase.items.TrackingNumber), 'ShipmentRecord created');

  const r5 = A.advanceCase(csr, kase);
  assert.equal(r5.ok, true);
  assert.equal(kase.items.Stage, A.STAGE.CLOSED);
  assert.ok(kase.items.ClosedDate);
  assert.equal(kase.items.AgingFlag, '');
  assert.equal(A.advanceCase(ctxFor(vet, 'whitcombe'), kase).ok, false, 'Closed is terminal');
  assert.ok(kase.items.StatusHistory.length >= 5);
});

// --- NightlyAging -------------------------------------------------------------------------------

test('aging: flags Amber/Red by days open, skips Closed/Cancelled, falls back to AuthorizationDate', () => {
  const who = 'CN=Test/O=TACOM';
  const mk = (items) => vet.create('AwardsCase', {
    CaseNumber: `TST-${vet.nextSerial('AgingTest')}`, Stage: A.STAGE.AUTHORIZED, AgingFlag: '', StatusHistory: [], VeteranLastName: 'Aging', VeteranFirstName: 'Test', ...items,
  }, { user: who, clock: () => NOW });
  const fresh = mk({ EnteredDate: '2026-08-20', StageDate: '2026-08-20' });
  const amber = mk({ EnteredDate: '2026-06-25', StageDate: '2026-08-01' });
  const red = mk({ EnteredDate: '2026-05-01', StageDate: '2026-05-01' });
  const closed = mk({ EnteredDate: '2020-01-01', Stage: A.STAGE.CLOSED, AgingFlag: '' });
  const cancelled = mk({ EnteredDate: '2020-01-01', Stage: A.STAGE.CANCELLED });
  const badDate = mk({ EnteredDate: 'not-a-date', AuthorizationDate: '2026-04-01' });
  const hopeless = mk({ EnteredDate: '', AuthorizationDate: '', AgingFlag: 'Amber' });
  const cleared = mk({ EnteredDate: '2026-08-25', AgingFlag: 'Red' });

  const r = A.nightlyAging(ctxFor(vet, 'whitcombe'));
  assert.equal(r.ok, true);
  assert.equal(fresh.items.AgingFlag, '');
  assert.equal(fresh.items.DaysOpen, 12);
  assert.equal(fresh.items.DaysInStage, 12);
  assert.equal(amber.items.AgingFlag, 'Amber');
  assert.equal(amber.items.DaysOpen, 68);
  assert.equal(amber.items.DaysInStage, 31);
  assert.equal(red.items.AgingFlag, 'Red');
  assert.equal(closed.items.AgingLastEval, undefined, 'Closed cases are not touched');
  assert.equal(cancelled.items.AgingLastEval, undefined, 'Cancelled cases are not touched');
  assert.equal(badDate.items.AgingFlag, 'Red', 'fallback to AuthorizationDate');
  assert.equal(hopeless.items.AgingFlag, 'Amber', 'unparseable dates keep the prior flag');
  assert.equal(hopeless.items.DaysOpen, -1);
  assert.equal(cleared.items.AgingFlag, '');
  assert.ok(cleared.items.StatusHistory.some((h) => /AgingFlag=Red -> AgingFlag=\(none\) \| NightlyAging/.test(h)), JSON.stringify(cleared.items.StatusHistory));
  assert.ok(amber.items.AgingLastEval);
  assert.ok(r.stats.processed >= 8);
  assert.ok(r.stats.red >= 2);
  assert.ok(r.stats.amber >= 1);
  assert.ok(r.stats.cleared >= 1);
  assert.ok(r.stats.badDate >= 2);
  assert.equal(r.stats.changed >= 4, true);
  assert.ok(r.redList.length > 0 && r.redList.length <= 200);
  assert.match(r.redList[0], /^\S+\s+\d+d\s+/);
  assert.equal(amber.updatedBy.at(-1), 'CN=HAAS-APP01/O=TACOM', 'agent signer stamps $UpdatedBy');
  assert.ok(r.log.some((l) => /Done - processed \d+/.test(l)), r.log.join(' / '));
});

test('aging: honours Profile thresholds', () => {
  const profile = vet.profile();
  const origAmber = profile.items.AgingAmberDays;
  const origRed = profile.items.AgingRedDays;
  vet.update(profile, { AgingAmberDays: 5, AgingRedDays: 10 }, { user: 'CN=Test/O=TACOM', clock: () => NOW });
  const doc = vet.create('AwardsCase', { CaseNumber: 'TST-THRESH', Stage: A.STAGE.AUTHORIZED, EnteredDate: '2026-08-24', AgingFlag: '', StatusHistory: [] }, { user: 'CN=Test/O=TACOM', clock: () => NOW });
  A.nightlyAging(ctxFor(vet, 'whitcombe'));
  assert.equal(doc.items.AgingFlag, 'Amber');
  vet.update(profile, { AgingAmberDays: origAmber, AgingRedDays: origRed }, { user: 'CN=Test/O=TACOM', clock: () => NOW });
});

// --- ImportAuthorizationFile ---------------------------------------------------------------------

test('importer: valid HRC fixed-width file creates cases, lines and requesters', () => {
  const content = hrcFile(
    [hrcCase({ ref: 'H100000001', last: 'Testerson', first: 'Alvin', mi: 'Q' }), hrcCase({ ref: 'H100000002', last: 'Quiggly', first: 'Bea', rel: 'DA', reqLast: 'Quiggly-Marsh', reqFirst: 'Dora' })],
    [hrcAward({ ref: 'H100000001', code: 'BSM', qty: 1, engrave: 'Y' }), hrcAward({ ref: 'H100000001', code: 'NDSM', qty: 2, engrave: 'N' }), hrcAward({ ref: 'H100000002', code: 'PH', qty: 1, text: 'BEA QUIGGLY' })],
  );
  const before = vet.all('AwardsCase').length;
  const r = A.importAuthorizationFile(ctxFor(vet, 'hrc-transfer'), 'HRC_AWD_TEST_1.txt', content);
  assert.equal(r.ok, true);
  assert.equal(r.status, 'Imported');
  assert.equal(r.cases, 2);
  assert.equal(r.lines, 3);
  assert.equal(r.rejected, 0);
  assert.equal(vet.all('AwardsCase').length, before + 2);
  assert.equal(r.authDoc.items.ImportStatus, 'Imported');
  assert.equal(r.authDoc.items.SourceAgency, 'HRC');
  assert.equal(r.authDoc.items.Layout, 'HRC-FIXED');
  assert.equal(r.authDoc.items.CasesCreated, 2);
  assert.equal(r.authDoc.items.LinesCreated, 3);
  assert.equal(r.authDoc.items.TrailerChecksum, 'A1B2C3D4');
  assert.equal(r.authDoc.items.ChecksumMatch, 'Yes');
  assert.ok(r.authDoc.items.ImportLog.some((l) => /HRC header: batch HRC00007/.test(l)));
  assert.ok(r.authDoc.files.some((f) => f.name === 'HRC_AWD_TEST_1.txt'), '$FILE attachment recorded');

  const kase = r.created.find((d) => d.form === 'AwardsCase' && d.items.VeteranLastName === 'Testerson');
  assert.ok(kase);
  assert.equal(kase.items.Stage, A.STAGE.AUTHORIZED);
  assert.equal(kase.items.VeteranMI, 'Q');
  assert.equal(kase.items.Relationship, 'Self');
  assert.equal(kase.items.EngravingRequired, 'Yes');
  assert.equal(kase.items.LineCount, 2);
  assert.equal(kase.items.AuthorizationDate, '2026-06-13');
  assert.equal(kase.items.Era, 'Vietnam');
  const lines = vet.findAll('AwardLine', 'ParentCaseNumber', kase.items.CaseNumber);
  assert.equal(lines.length, 2);
  const bsm = lines.find((l) => l.items.AwardCode === 'BSM');
  assert.equal(bsm.items.AwardName, 'Bronze Star Medal');
  assert.equal(bsm.items.EngravingText, 'ALVIN Q TESTERSON');
  assert.equal(bsm.parent, kase.unid, 'AwardLine is a response document');
  const nok = r.created.find((d) => d.form === 'AwardsCase' && d.items.VeteranLastName === 'Quiggly');
  assert.equal(nok.items.Relationship, 'Daughter');
  assert.equal(nok.items.RequesterName, 'Quiggly-Marsh, Dora');
  const reqDoc = vet.findOne('Requester', 'LookupKey', nok.items.RequesterKey);
  assert.ok(reqDoc, 'Requester document created');
  assert.equal(reqDoc.items.LastName, 'Quiggly-Marsh');

  const skip = A.importAuthorizationFile(ctxFor(vet, 'hrc-transfer'), 'HRC_AWD_TEST_1.txt', content);
  assert.equal(skip.ok, false);
  assert.equal(skip.status, 'Skipped');
});

test('importer: HRC rejects duplicates, orphans, bad names; warns on ZIP, quantity, unknown codes', () => {
  const content = hrcFile(
    [
      hrcCase({ ref: 'H200000001', last: 'Dupe', first: 'One' }),
      hrcCase({ ref: 'H200000001', last: 'Dupe', first: 'Two' }),
      hrcCase({ ref: 'H200000002', last: '', first: 'Nameless' }),
      hrcCase({ ref: 'H200000003', last: 'Bad<Name>', first: 'X' }),
      hrcCase({ ref: 'H200000004', last: 'Zipless', first: 'Zed', zip: '1A2' }),
    ],
    [
      hrcAward({ ref: 'H200000001', code: 'ARCOM', qty: 7 }),
      hrcAward({ ref: 'H999999999', code: 'ARCOM' }),
      hrcAward({ ref: 'H200000004', code: 'XYZZY', qty: 1 }),
      'ZZ this is not a record type',
      '20',
    ],
    { declCases: 5 },
  );
  const r = A.importAuthorizationFile(ctxFor(vet, 'hrc-transfer'), 'HRC_AWD_TEST_2.txt', content);
  assert.equal(r.ok, true);
  assert.equal(r.status, 'Imported with Errors');
  assert.equal(r.cases, 2, 'only Dupe/One and Zipless created');
  const log = r.log.join('\n');
  assert.match(log, /duplicate case reference H200000001/);
  assert.match(log, /veteran name missing/);
  assert.match(log, /outside the allowed set/);
  assert.match(log, /ZIP '1A2' not 5 digits/);
  assert.match(log, /quantity 7 capped at 3/);
  assert.match(log, /unknown case H999999999 \(orphan\)/);
  assert.match(log, /unknown award code 'XYZZY'/);
  assert.match(log, /unknown record type 'ZZ'/);
  assert.match(log, /trailer case count does not match/);
  assert.equal(r.authDoc.items.ChecksumMatch, 'No');
  assert.ok(r.rejected >= 5, `rejected ${r.rejected}`);
  const capped = r.created.find((d) => d.form === 'AwardLine' && d.items.AwardCode === 'ARCOM');
  assert.equal(capped.items.Quantity, 3);
  const unknown = r.created.find((d) => d.form === 'AwardLine' && d.items.AwardCode === 'XYZZY');
  assert.equal(unknown.items.AwardName, 'XYZZY');
  assert.equal(unknown.items.AwardCategory, '');
  const zipless = r.created.find((d) => d.form === 'AwardsCase' && d.items.VeteranLastName === 'Zipless');
  assert.equal(zipless.items.ShipToZIP, '1A2', 'questionable ZIP is preserved for CSR review');
  assert.equal(vet.findOne('Requester', 'LookupKey', zipless.items.RequesterKey).items.AddressVerified, 'No');
});

test('importer: HRC file without header/trailer is flagged', () => {
  const noHeader = [hrcCase({ ref: 'H300000001', last: 'Early', first: 'Bird' })].join('\n');
  const r = A.importAuthorizationFile(ctxFor(vet, 'hrc-transfer'), 'HRC_AWD_TEST_3.txt', noHeader);
  assert.equal(r.status, 'Rejected');
  assert.equal(r.cases, 0);
  assert.equal(r.authDoc.items.ImportStatus, 'Rejected');
  assert.match(r.log.join('\n'), /case record before header/);
  assert.match(r.log.join('\n'), /no 01 header record/);
  const noTrailer = hrcFile([hrcCase({ ref: 'H300000002', last: 'Late', first: 'Bird' })], [], { noTrailer: true });
  const r2 = A.importAuthorizationFile(ctxFor(vet, 'hrc-transfer'), 'HRC_AWD_TEST_4.txt', noTrailer);
  assert.match(r2.log.join('\n'), /no 99 trailer record/);
});

test('importer: valid NPRC pipe-delimited file', () => {
  const content = [
    'NPRC-AWD|v2|2026-07-01|B99|2026-06-28',
    'C|N90000001|Pipeworth|Gloria|A| 177|1951-05-08|1953-11-03|SP|Pipeworth|Harold|12 Elm St|St. Louis|MO|63150|Y|E|CPL',
    'A|N90000001|KSM|1|0|Y|G. A. PIPEWORTH|NPRC Form 13, item 6',
    'A|N90000001|GCMDL|1|2|N||NPRC Form 13, item 6',
    'T|1|2',
    '',
  ].join('\n');
  const r = A.importAuthorizationFile(ctxFor(vet, 'hrc-transfer'), 'nprc_awd_test_b99.dat', content);
  assert.equal(r.ok, true);
  assert.equal(r.status, 'Imported', r.log.join('\n'));
  assert.equal(r.cases, 1);
  assert.equal(r.lines, 2);
  assert.equal(r.authDoc.items.SourceAgency, 'NPRC');
  assert.equal(r.authDoc.items.Layout, 'NPRC-DELIM');
  assert.equal(r.authDoc.items.ChecksumMatch, 'Yes');
  const kase = r.created.find((d) => d.form === 'AwardsCase');
  assert.equal(kase.items.Relationship, 'Spouse');
  assert.equal(kase.items.Priority, 'Expedite');
  assert.equal(kase.items.Deceased, 'Yes');
  assert.equal(kase.items.Era, 'Korea');
  assert.equal(kase.items.Source, 'NPRC');
  const ksm = r.created.find((d) => d.form === 'AwardLine' && d.items.AwardCode === 'KSM');
  assert.equal(ksm.items.EngravingText, 'G. A. PIPEWORTH');
  const gc = r.created.find((d) => d.form === 'AwardLine' && d.items.AwardCode === 'GCMDL');
  assert.equal(gc.items.DeviceCount, 2);
});

test('importer: NPRC short/malformed records are rejected', () => {
  const content = [
    'NPRC-AWD|v2',
    'C|N90000002|Short',
    'C|N90000003|Fullname|Frank||100|1970-01-01|1972-01-01|SE|Fullname|Frank|1 A St|Town|TX|75001|N|R|PFC',
    'A|N90000003|ARCOM',
    'A|N90000003|ARCOM|1|0|N||NPRC Form 13',
    'Q|garbage',
    'T|9|9',
  ].join('\n');
  const r = A.importAuthorizationFile(ctxFor(vet, 'hrc-transfer'), 'nprc_awd_test_bad.dat', content);
  assert.equal(r.status, 'Imported with Errors');
  const log = r.log.join('\n');
  assert.match(log, /short NPRC header/);
  assert.match(log, /case record has 3 fields, expected 18/);
  assert.match(log, /award record has 3 fields, expected 8/);
  assert.match(log, /unknown record type 'Q'/);
  assert.equal(r.cases, 1);
  assert.equal(r.lines, 1);
  assert.equal(r.authDoc.items.ChecksumMatch, 'No');
});

test('importer: requesters are deduplicated by normalized key across files', () => {
  const ctx = ctxFor(vet, 'hrc-transfer');
  const a = A.importAuthorizationFile(ctx, 'HRC_AWD_DEDUP_A.txt', hrcFile([hrcCase({ ref: 'H400000001', last: 'Dedupe', first: 'Rita', zip: '19111-1234' })], [hrcAward({ ref: 'H400000001' })]));
  const b = A.importAuthorizationFile(ctx, 'HRC_AWD_DEDUP_B.txt', hrcFile([hrcCase({ ref: 'H400000002', last: 'DEDUPE ', first: ' rita', zip: '19111' })], [hrcAward({ ref: 'H400000002' })]));
  assert.equal(a.requestersNew, 1);
  assert.equal(b.requestersNew, 0);
  assert.equal(b.requestersMatched, 1);
  const c1 = a.created.find((d) => d.form === 'AwardsCase');
  const c2 = b.created.find((d) => d.form === 'AwardsCase');
  assert.equal(c1.items.RequesterID, c2.items.RequesterID);
  assert.equal(A.buildRequesterKey('DEDUPE ', ' rita', '19111-1234'), A.buildRequesterKey('Dedupe', 'Rita', '19111'));
  assert.notEqual(A.buildRequesterKey('Dedupe', 'Rita', '19111'), A.buildRequesterKey('Dedupe', 'Rita', '19112'));
});

test('importer: input guards on file name and content', () => {
  const ctx = ctxFor(vet, 'hrc-transfer');
  assert.throws(() => A.importAuthorizationFile(ctx, '../etc/passwd', 'x'), A.AppError);
  assert.throws(() => A.importAuthorizationFile(ctx, 'ok.txt', ''), A.AppError);
  assert.throws(() => A.importAuthorizationFile(ctx, 'ok.txt', 'a\u0001b'), A.AppError);
  assert.throws(() => A.importAuthorizationFile(ctx, 'ok.txt', 'x'.repeat(2 * 1024 * 1024 + 1)), A.AppError);
});

test('importer: the shipped sample files import and their documented defects are reported', () => {
  const ctx = ctxFor(vet, 'hrc-transfer');
  const samples = fs.readdirSync(AUTH_DIR).filter((f) => /\.(txt|dat)$/i.test(f));
  assert.ok(samples.length >= 3 && samples.length <= 5, `${samples.length} sample files`);
  // README.md table: | file | layout | case records | intentional defects |
  const readme = fs.readFileSync(path.join(AUTH_DIR, 'README.md'), 'utf8');
  const documented = new Map();
  for (const m of readme.matchAll(/^\| `([^`]+)` \| [^|]+ \| (\d+) \| ([^|]+) \|$/gm)) {
    documented.set(m[1], { cases: Number(m[2]), defects: m[3].trim() });
  }
  assert.deepEqual([...documented.keys()].sort(), samples.sort(), 'README documents exactly the shipped samples');
  for (const f of samples) {
    const r = A.importAuthorizationFile(ctx, f, fs.readFileSync(path.join(AUTH_DIR, f), 'latin1'), { force: true });
    const spec = documented.get(f);
    assert.equal(r.ok, true, f);
    assert.equal(r.cases, spec.cases, `${f} cases created`);
    assert.ok(r.lines >= r.cases, `${f} created lines`);
    if (spec.defects === 'none') {
      assert.equal(r.status, 'Imported', `${f}: ${r.log.join(' / ')}`);
      assert.equal(r.authDoc.items.ChecksumMatch, 'Yes');
      assert.equal(r.rejected, 0);
    } else {
      assert.equal(r.status, 'Imported with Errors', f);
      assert.ok(r.rejected > 0, f);
      const log = r.log.join('\n');
      if (/orphan/.test(spec.defects)) assert.match(log, /\(orphan\)/, f);
      if (/duplicate/.test(spec.defects)) assert.match(log, /duplicate case reference/, f);
      if (/unknown award code/.test(spec.defects)) assert.match(log, /unknown award code/, f);
      if (/unknown record type/.test(spec.defects)) assert.match(log, /unknown record type/, f);
      if (/qty > 3/.test(spec.defects)) assert.match(log, /capped at 3/, f);
      if (/short record/.test(spec.defects)) assert.match(log, /expected \d+/, f);
      if (/checksum/.test(spec.defects)) assert.equal(r.authDoc.items.ChecksumMatch, 'No', f);
    }
  }
});

test('helpers: parseLegacyDate, daysBetween, era, relationship, priority', () => {
  assert.equal(A.parseLegacyDate('20260613').toISOString().slice(0, 10), '2026-06-13');
  assert.equal(A.parseLegacyDate('2026-06-13').getDate(), 13);
  assert.equal(A.parseLegacyDate('06/13/2026').getMonth(), 5);
  assert.equal(A.parseLegacyDate('nope'), null);
  assert.equal(A.daysBetween('2026-08-01', NOW), 31);
  assert.equal(A.daysBetween('', NOW), null);
  assert.equal(A.eraFromDates(null, new Date(1944, 0, 1)), 'World War II');
  assert.equal(A.eraFromDates(null, new Date(1991, 0, 1)), 'Gulf War');
  assert.equal(A.relationshipFromCode('GC'), 'Grandchild');
  assert.equal(A.relationshipFromCode('??'), 'Other NOK');
  assert.equal(A.priorityFromCode('C'), 'Congressional');
  assert.equal(A.commonName('CN=Dana Whitcombe/OU=CHPSID/O=TACOM'), 'Dana Whitcombe');
});
