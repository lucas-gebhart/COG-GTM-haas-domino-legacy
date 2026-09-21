'use strict';

/**
 * JavaScript ports of the application logic that lives in the Domino design:
 *
 *   - form save with @Formula input translation / validation / computed fields
 *     (what NotesUIDocument.Save + ComputeWithForm do on the server)
 *   - ReleaseToVendor, CancelRequest                    (heraldry.nsf agents)
 *   - (AdvanceStage) / HAASAwards.AdvanceCase            (vetmedals.nsf)
 *   - NightlyAging                                        (vetmedals.nsf agent)
 *   - ImportAuthorizationFile                             (vetmedals.nsf agent)
 *
 * The formulas themselves are read from the DXL at run time; only the LotusScript parts
 * are re-expressed here, following the .lss sources line for line where practical.
 */

const F = require('./formula');
const { findForm } = require('./views');

// HAASCommon.lss constants
const STATUS = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  REVIEW: 'Under Review',
  APPROVED: 'Approved',
  RELEASED: 'Released to Vendor',
  PRODUCTION: 'In Production',
  SHIPPED: 'Shipped',
  COMPLETE: 'Complete',
  CANCELLED: 'Cancelled',
};
const MSG_RELEASED_NOMODIFY = 'This request has been released to the vendor and can no longer be modified or cancelled. Contact TACOM Clothing & Heraldry PSID for assistance. (Error 4091)';
const MSG_CANCELLED = 'This request has been cancelled.';

// HAASAwards.lss constants
const STAGE = {
  AUTHORIZED: 'Authorized',
  ENGRAVING: 'Engraving',
  ASSEMBLY: 'Assembly/QC',
  WAREHOUSE: 'Warehouse',
  SHIPPED: 'Shipped',
  CLOSED: 'Closed',
  HOLD: 'On Hold',
  CANCELLED: 'Cancelled',
};
const STAGE_ORDER = [STAGE.AUTHORIZED, STAGE.ENGRAVING, STAGE.ASSEMBLY, STAGE.WAREHOUSE, STAGE.SHIPPED, STAGE.CLOSED];
const ENGRAVED_AWARDS = '|MEDAL OF HONOR|DISTINGUISHED SERVICE CROSS|DISTINGUISHED SERVICE MEDAL|SILVER STAR|LEGION OF MERIT|DISTINGUISHED FLYING CROSS|SOLDIER\'S MEDAL|BRONZE STAR MEDAL|PURPLE HEART|MERITORIOUS SERVICE MEDAL|AIR MEDAL|ARMY COMMENDATION MEDAL|ARMY ACHIEVEMENT MEDAL|GOOD CONDUCT MEDAL|';
const AGING_AMBER_DEFAULT = 60;
const AGING_RED_DEFAULT = 75;
const MAX_LINE_LEN = 400;
const MAX_RECORDS = 5000;

class AppError extends Error {
  constructor(message, status = 400, userMessage = message) {
    super(message);
    this.status = status;
    this.userMessage = userMessage;
  }
}

function pad(n, width) {
  return String(n).padStart(width, '0');
}

function stamp(now) {
  const d = now || new Date();
  const mm = pad(d.getMonth() + 1, 2);
  const dd = pad(d.getDate(), 2);
  return `${mm}/${dd}/${d.getFullYear()} ${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}`;
}

function isoNow(now) {
  return (now || new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function isoDate(now) {
  return isoNow(now).slice(0, 10);
}

function commonName(user) {
  const m = /CN=([^/]+)/.exec(user || '');
  return m ? m[1] : (user || 'Anonymous');
}

function text(doc, name) {
  const v = doc.items[name];
  if (v === undefined || v === null) {
    return '';
  }
  return Array.isArray(v) ? String(v[0] === undefined ? '' : v[0]) : String(v);
}

function appendStatusHistory(doc, from, to, who, now) {
  const entry = `${stamp(now)} | ${from || '(new)'} -> ${to} | ${commonName(who)}`;
  const hist = [].concat(doc.items.StatusHistory || []).filter((x) => x !== '');
  hist.push(entry);
  return hist.slice(-50);
}

function daysBetween(fromIso, now) {
  const d = F.parseDateValue(fromIso);
  if (!d) {
    return null;
  }
  const a = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const b = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((b - a) / 86400000);
}

/* ------------------------------------------------------------------------------------------
 * Form save: input translation, validation and computed fields from the DXL <form>
 * ---------------------------------------------------------------------------------------- */

const MAX_TEXT_LEN = 255;
const MAX_RICHTEXT_LEN = 2000;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

/**
 * Apply the form's field formulas to `items` (the posted values) the way the Domino server
 * does on a web POST: translate each editable field, validate it, then compute the
 * computed fields.  Returns { ok, errors[], items }.
 */
function computeWithForm(engine, form, doc, opts = {}) {
  const errors = [];
  const isNew = Boolean(opts.isNew);
  const base = { isNewDoc: isNew, isEditing: true, isSaving: true, userName: opts.userName || 'Anonymous', roles: opts.roles || [] };
  const editable = form.fields.filter((f) => f.kind === 'editable');
  // Default values for new documents
  if (isNew) {
    for (const f of editable) {
      if ((doc.items[f.name] === undefined || doc.items[f.name] === '') && f.defaultValue) {
        const v = engine.eval(f.defaultValue, doc, base);
        if (!(v instanceof F.FormulaErrorValue)) {
          doc.items[f.name] = v;
        }
      }
    }
  }
  for (const f of editable) {
    if (opts.only && !opts.only.includes(f.name)) {
      continue;
    }
    if (f.inputTranslation) {
      const v = engine.eval(f.inputTranslation, doc, { ...base, fieldName: f.name });
      if (!(v instanceof F.FormulaErrorValue) && !(v instanceof F.Failure)) {
        doc.items[f.name] = v;
      }
    }
    if (f.type === 'number' && doc.items[f.name] !== undefined && doc.items[f.name] !== '') {
      const n = Number(doc.items[f.name]);
      if (Number.isFinite(n)) {
        doc.items[f.name] = n;
      }
    }
  }
  for (const f of editable) {
    if (opts.only && !opts.only.includes(f.name)) {
      continue;
    }
    const raw = doc.items[f.name];
    if (typeof raw === 'string') {
      const limit = f.type === 'richtext' ? MAX_RICHTEXT_LEN : MAX_TEXT_LEN;
      if (CONTROL_CHARS.test(raw)) {
        errors.push(`${f.name} contains characters that are not allowed.`);
        continue;
      }
      if (raw.length > limit) {
        errors.push(`${f.name} exceeds the ${limit} character limit.`);
        continue;
      }
    }
    if (f.inputValidation) {
      const r = engine.eval(f.inputValidation, doc, { ...base, fieldName: f.name });
      if (r instanceof F.Failure) {
        errors.push(r.message);
      }
    }
  }
  if (errors.length) {
    return { ok: false, errors };
  }
  for (const f of form.fields) {
    const compose = f.kind === 'computedwhencomposed';
    if (!(f.kind === 'computed' || (compose && isNew)) || !f.value) {
      continue;
    }
    if (opts.skipComputed && opts.skipComputed.includes(f.name)) {
      continue;
    }
    const v = engine.eval(f.value, doc, base);
    if (!(v instanceof F.FormulaErrorValue) && !(v instanceof F.Failure)) {
      doc.items[f.name] = v instanceof Date ? isoNow(v) : v;
    }
  }
  return { ok: true, errors: [] };
}

/* ------------------------------------------------------------------------------------------
 * heraldry.nsf: DD Form 1348-6 requests
 * ---------------------------------------------------------------------------------------- */

function isReleased(db, doc) {
  const released = db.profileValue('ReleasedStatuses', [STATUS.RELEASED, STATUS.PRODUCTION, STATUS.SHIPPED, STATUS.COMPLETE, STATUS.CANCELLED]);
  const st = text(doc, 'Status').trim();
  if ([].concat(released).includes(st)) {
    return true;
  }
  return text(doc, 'ReleasedDate').trim() !== '';
}

function nextDocumentNumber(db, dodaac, now, user) {
  // Mirrors the Request.DocumentNumber computed formula: DODAAC + year digit + julian day + serial
  const serial = db.nextSerial('NextRequestSerial', { user });
  const jan1 = new Date(now.getFullYear(), 0, 1);
  const julian = Math.floor((now - jan1) / 86400000) + 1;
  return `${dodaac.toUpperCase()}${String(now.getFullYear()).slice(-1)}${pad(julian, 3)}${pad(serial, 4).slice(-4)}`;
}

const REQUEST_FIELDS = ['DODAAC', 'UIC', 'UnitName', 'RPD', 'SignalCode', 'FundCode', 'ProjectCode', 'SupplementaryAddress', 'RequestType',
  'RequiredDeliveryDate', 'ShipToDODAAC', 'ShipToName', 'ShipToAddress1', 'ShipToAddress2', 'ShipToCity', 'ShipToState', 'ShipToZIP', 'Justification'];
const LINE_FIELDS = ['ItemKey', 'NSN', 'ExceptionData', 'UnitOfIssue', 'Quantity'];

/**
 * Create a Request plus its first RequestLine from posted form values.
 * Returns { ok, errors } or { ok: true, doc, line }.
 */
function createRequest(ctx, values) {
  const { design, db, engine, user, now } = ctx;
  const form = findForm(design, 'Request');
  const lineForm = findForm(design, 'RequestLine');
  const items = {};
  for (const k of REQUEST_FIELDS) {
    items[k] = values[k] === undefined ? '' : values[k];
  }
  items.Status = STATUS.SUBMITTED;
  const draft = { unid: '', items: { Form: 'Request', ...items } };
  const r = computeWithForm(engine, form, draft, { isNew: true, userName: user.name, roles: user.roles, skipComputed: ['DocumentNumber', 'LineCount', 'TotalValue', 'JustificationText'] });
  const lineDraft = { unid: '', items: { Form: 'RequestLine' } };
  for (const k of LINE_FIELDS) {
    lineDraft.items[k] = values[k] === undefined ? '' : values[k];
  }
  lineDraft.items.LineStatus = 'Open';
  const lr = computeWithForm(engine, lineForm, lineDraft, { isNew: true, userName: user.name, roles: user.roles, skipComputed: ['ParentDocNumber', 'LineNumber', 'LineDocNumber', 'LookupKey', 'DocReaders'] });
  const errors = r.errors.concat(lr.errors);
  if (errors.length) {
    return { ok: false, errors, draft: draft.items, lineDraft: lineDraft.items };
  }
  const docNo = nextDocumentNumber(db, text(draft, 'DODAAC'), now, user.name);
  const ts = isoNow(now);
  const created = db.create('Request', {
    ...draft.items,
    DocumentNumber: docNo,
    JustificationText: String(draft.items.Justification || '').slice(0, 2000),
    LineCount: 1,
    TotalValue: Number(lineDraft.items.ExtendedPrice) || 0,
    EnteredDate: ts,
    EnteredBy: user.name,
    SubmittedDate: ts,
    VendorKey: '',
    VendorName: '',
    ReleasedDate: '',
    ReleasedBy: '',
    EstimatedShipDate: '',
    CancelReason: '',
    CancelledDate: '',
    CancelledBy: '',
    StatusHistory: [`${stamp(now)} | (new) -> Draft | ${commonName(user.name)}`, `${stamp(now)} | Draft -> Submitted | ${commonName(user.name)}`],
    LastModifiedBy: user.name,
    LastModifiedDate: ts,
    StatusInquiryKey: `${docNo}|${text(draft, 'DODAAC').toUpperCase()}|${text(draft, 'UIC').toUpperCase()}`,
  }, { user: user.name, clock: () => now });
  const line = db.create('RequestLine', {
    ...lineDraft.items,
    ParentDocNumber: docNo,
    LineNumber: 1,
    LineDocNumber: `${docNo}-01`,
    UnitPrice: Number(lineDraft.items.UnitPrice) || 0,
    ExtendedPrice: Number(lineDraft.items.ExtendedPrice) || 0,
    VendorKey: '',
    EnteredBy: user.name,
    LookupKey: `${docNo}|01`,
    DocReaders: created.items.DocReaders,
  }, { user: user.name, parent: created.unid, clock: () => now });
  return { ok: true, doc: created, line };
}

/** ModifyRequest.xsp save: editable header fields only, blocked once released. */
function modifyRequest(ctx, doc, values) {
  const { design, db, engine, user, now } = ctx;
  if (text(doc, 'Status') === STATUS.CANCELLED) {
    return { ok: false, errors: [MSG_CANCELLED], blocked: true };
  }
  if (isReleased(db, doc)) {
    return { ok: false, errors: [MSG_RELEASED_NOMODIFY], blocked: true };
  }
  const form = findForm(design, 'Request');
  const editable = ['UnitName', 'RPD', 'SignalCode', 'FundCode', 'ProjectCode', 'SupplementaryAddress', 'RequestType', 'RequiredDeliveryDate',
    'ShipToDODAAC', 'ShipToName', 'ShipToAddress1', 'ShipToAddress2', 'ShipToCity', 'ShipToState', 'ShipToZIP', 'Justification'];
  const draft = { unid: doc.unid, items: { ...doc.items } };
  for (const k of editable) {
    if (values[k] !== undefined) {
      draft.items[k] = values[k];
    }
  }
  const r = computeWithForm(engine, form, draft, { isNew: false, userName: user.name, roles: user.roles, only: editable, skipComputed: form.fields.filter((f) => f.kind !== 'editable').map((f) => f.name) });
  if (!r.ok) {
    return { ok: false, errors: r.errors, draft: draft.items };
  }
  const changed = {};
  for (const k of editable) {
    if (JSON.stringify(draft.items[k]) !== JSON.stringify(doc.items[k])) {
      changed[k] = draft.items[k];
    }
  }
  const from = text(doc, 'Status');
  const to = from === STATUS.DRAFT ? STATUS.SUBMITTED : from;
  db.update(doc, {
    ...changed,
    Status: to,
    JustificationText: String(draft.items.Justification || '').slice(0, 2000),
    LastModifiedBy: user.name,
    LastModifiedDate: isoNow(now),
    StatusHistory: appendStatusHistory(doc, from, `${to} (modified: ${Object.keys(changed).join(', ') || 'no field changes'})`, user.name, now),
  }, { user: user.name, clock: () => now });
  return { ok: true, doc, changed: Object.keys(changed) };
}

/** ModifyRequest.xsp line edit: quantity only, blocked once released; re-extends the line and the parent TotalValue. */
function modifyRequestLine(ctx, doc, line, quantity) {
  const { design, db, engine, user, now } = ctx;
  if (text(doc, 'Status') === STATUS.CANCELLED) {
    return { ok: false, errors: [MSG_CANCELLED], blocked: true };
  }
  if (isReleased(db, doc)) {
    return { ok: false, errors: [MSG_RELEASED_NOMODIFY], blocked: true };
  }
  if (!line || line.form !== 'RequestLine' || line.parent !== doc.unid) {
    return { ok: false, errors: ['The line item does not belong to this request.'] };
  }
  const form = findForm(design, 'RequestLine');
  const draft = { unid: line.unid, items: { ...line.items, Quantity: quantity } };
  const r = computeWithForm(engine, form, draft, {
    isNew: false,
    userName: user.name,
    roles: user.roles,
    only: ['Quantity'],
    skipComputed: form.fields.filter((f) => f.name !== 'ExtendedPrice').map((f) => f.name),
  });
  if (!r.ok) {
    return { ok: false, errors: r.errors };
  }
  const before = Number(line.items.Quantity) || 0;
  const after = Number(draft.items.Quantity) || 0;
  db.update(line, {
    Quantity: after,
    ExtendedPrice: Number(draft.items.ExtendedPrice) || 0,
  }, { user: user.name, clock: () => now });
  const total = db.responses(doc.unid, 'RequestLine').reduce((sum, l) => sum + (Number(l.items.ExtendedPrice) || 0), 0);
  const from = text(doc, 'Status');
  db.update(doc, {
    TotalValue: Number(total.toFixed(2)),
    LastModifiedBy: user.name,
    LastModifiedDate: isoNow(now),
    StatusHistory: appendStatusHistory(doc, from, `${from} (modified: line ${text(line, 'LineNumber') || '?'} quantity ${before} -> ${after})`, user.name, now),
  }, { user: user.name, clock: () => now });
  return { ok: true, doc, line, before, after };
}

/** ReleaseToVendor.lss ReleaseOne() */
function releaseToVendor(ctx, doc, vendorKey) {
  const { db, user, now } = ctx;
  if (isReleased(db, doc)) {
    return { ok: false, errors: [`${text(doc, 'DocumentNumber')}: already released / closed`], blocked: true };
  }
  const key = String(vendorKey || text(doc, 'VendorKey') || '').trim().toUpperCase();
  if (!key) {
    return { ok: false, errors: ['A vendor must be assigned before the request can be released.'] };
  }
  const vendor = db.findOne('Vendor', 'VendorKey', key);
  if (!vendor) {
    // The deleted-but-referenced vendor wart: the agent keeps going with the key only.
    ctx.log && ctx.log('ReleaseToVendor', `WARNING vendor ${key} not found in Vendors view - releasing with key only`);
  } else if (text(vendor, 'Active') !== 'Yes') {
    return { ok: false, errors: [`Vendor ${key} (${text(vendor, 'VendorName')}) is not active.`] };
  }
  const lead = vendor ? Number(vendor.items.LeadTimeDays) || 60 : 60;
  const est = new Date(now.getTime() + lead * 86400000);
  const from = text(doc, 'Status');
  const readers = [...new Set([].concat(doc.items.DocReaders || []).concat(key))];
  db.update(doc, {
    Status: STATUS.RELEASED,
    VendorKey: key,
    VendorName: vendor ? text(vendor, 'VendorName') : '',
    ReleasedDate: isoNow(now),
    ReleasedBy: user.name,
    EstimatedShipDate: isoDate(est),
    LockedForModification: '1',
    DocReaders: readers,
    DocAuthors: ['[TACOM]', '[Admin]', `Vendor-${key}`],
    LastModifiedBy: user.name,
    LastModifiedDate: isoNow(now),
    StatusHistory: appendStatusHistory(doc, from, STATUS.RELEASED, user.name, now),
  }, { user: user.name, clock: () => now });
  for (const line of db.responses(doc.unid, 'RequestLine')) {
    db.update(line, { LineStatus: 'Released', VendorKey: key, DocReaders: readers }, { user: user.name, clock: () => now });
  }
  return { ok: true, doc, vendor };
}

/** CancelRequest.lss CancelOne() */
function cancelRequest(ctx, doc, reason) {
  const { db, user, now } = ctx;
  if (text(doc, 'Status') === STATUS.CANCELLED) {
    return { ok: false, errors: [MSG_CANCELLED], blocked: true };
  }
  if (isReleased(db, doc)) {
    return { ok: false, errors: [MSG_RELEASED_NOMODIFY], blocked: true };
  }
  const cancelReason = String(reason || '').trim().slice(0, 255);
  if (!cancelReason) {
    return { ok: false, errors: ['A cancellation reason is required.'] };
  }
  const from = text(doc, 'Status');
  db.update(doc, {
    Status: STATUS.CANCELLED,
    CancelledDate: isoNow(now),
    CancelledBy: user.name,
    CancelReason: cancelReason,
    LastModifiedBy: user.name,
    LastModifiedDate: isoNow(now),
    StatusHistory: appendStatusHistory(doc, from, STATUS.CANCELLED, user.name, now),
  }, { user: user.name, clock: () => now });
  for (const line of db.responses(doc.unid, 'RequestLine')) {
    db.update(line, { LineStatus: STATUS.CANCELLED }, { user: user.name, clock: () => now });
  }
  return { ok: true, doc };
}

/** StatusInquiry.xsp / HAASStatus.jss lookup by document number (+ optional DODAAC) */
function statusInquiry(db, documentNumber, dodaac) {
  const key = String(documentNumber || '').trim().toUpperCase();
  const dd = String(dodaac || '').trim().toUpperCase();
  if (!key) {
    return { ok: false, errors: ['Enter a document number (block 1-2 of the DD Form 1348-6) or SES flag number.'] };
  }
  const candidates = db.all('Request').concat(db.all('SESFlagRequest'));
  const hits = candidates.filter((d) => {
    const num = (text(d, 'DocumentNumber') || text(d, 'SESFlagNumber')).toUpperCase();
    return num === key && (!dd || text(d, 'DODAAC').toUpperCase() === dd);
  });
  if (hits.length === 0) {
    return { ok: false, errors: ['No request was found for that document number. Check the number and DODAAC and try again, or contact the Heraldry customer service desk.'] };
  }
  return { ok: true, hits, canModify: hits.map((d) => !isReleased(db, d) && text(d, 'Status') !== STATUS.CANCELLED) };
}

/* ------------------------------------------------------------------------------------------
 * vetmedals.nsf: awards case workflow (HAASAwards.lss)
 * ---------------------------------------------------------------------------------------- */

function isValidStageTransition(from, to) {
  const f = from.trim();
  const t = to.trim();
  if (f === t) {
    return false;
  }
  if (t === STAGE.CANCELLED) {
    return f !== STAGE.SHIPPED && f !== STAGE.CLOSED;
  }
  if (t === STAGE.HOLD) {
    return f !== STAGE.SHIPPED && f !== STAGE.CLOSED && f !== STAGE.CANCELLED;
  }
  switch (f) {
    case STAGE.AUTHORIZED: return t === STAGE.ENGRAVING || t === STAGE.ASSEMBLY;
    case STAGE.ENGRAVING: return t === STAGE.ASSEMBLY;
    case STAGE.ASSEMBLY: return t === STAGE.WAREHOUSE || t === STAGE.ENGRAVING;
    case STAGE.WAREHOUSE: return t === STAGE.SHIPPED;
    case STAGE.SHIPPED: return t === STAGE.CLOSED;
    case STAGE.HOLD: return t !== STAGE.CLOSED;
    default: return false;
  }
}

function nextStage(current, engravingRequired) {
  switch (current.trim()) {
    case STAGE.AUTHORIZED: return engravingRequired ? STAGE.ENGRAVING : STAGE.ASSEMBLY;
    case STAGE.ENGRAVING: return STAGE.ASSEMBLY;
    case STAGE.ASSEMBLY: return STAGE.WAREHOUSE;
    case STAGE.WAREHOUSE: return STAGE.SHIPPED;
    case STAGE.SHIPPED: return STAGE.CLOSED;
    default: return '';
  }
}

function isEngravable(awardName) {
  return ENGRAVED_AWARDS.includes(`|${String(awardName || '').trim().toUpperCase()}|`);
}

function caseHasEngravableLines(db, caseDoc) {
  if (text(caseDoc, 'EngravingRequired') === 'Yes') {
    return true;
  }
  return db.findAll('AwardLine', 'ParentCaseNumber', text(caseDoc, 'CaseNumber')).some((l) => text(l, 'Engrave') === 'Yes');
}

function roleMayAdvance(roles, fromStage) {
  const has = (r) => roles.includes(r);
  if (has('[TACOM]') || has('[Admin]')) {
    return true;
  }
  switch (fromStage) {
    case STAGE.AUTHORIZED: return has('[CSR]') || has('[Engraver]');
    case STAGE.ENGRAVING: return has('[Engraver]');
    case STAGE.ASSEMBLY: return has('[Assembler]');
    case STAGE.WAREHOUSE: return has('[Warehouse]');
    case STAGE.SHIPPED: return has('[CSR]') || has('[Warehouse]');
    default: return false;
  }
}

function createEngravingJob(db, caseDoc, user, now) {
  const serial = db.nextSerial('NextEngravingSerial', { user });
  const lines = db.findAll('AwardLine', 'ParentCaseNumber', text(caseDoc, 'CaseNumber')).filter((l) => text(l, 'Engrave') === 'Yes');
  const items = lines.map((l) => `${text(l, 'AwardName')} :: ${text(l, 'EngravingText')}`);
  return db.create('EngravingJob', {
    JobNumber: `ENG-${now.getFullYear()}-${pad(serial, 5)}`,
    CaseNumber: text(caseDoc, 'CaseNumber'),
    VeteranName: `${text(caseDoc, 'VeteranLastName')}, ${text(caseDoc, 'VeteranFirstName')}`,
    Priority: text(caseDoc, 'Priority'),
    JobStatus: 'Queued',
    QueuedDate: isoNow(now),
    StartedDate: '',
    CompletedDate: '',
    Font: 'Block',
    Machine: '',
    ReworkCount: 0,
    Items: items,
    EngravingText: lines.length ? text(lines[lines.length - 1], 'EngravingText') : '',
    Engraver: '',
    Notes: '',
    DocReaders: caseDoc.items.DocReaders || [],
  }, { user, clock: () => now });
}

function createShipmentRecord(db, caseDoc, user, now) {
  const serial = db.nextSerial('NextShipmentSerial', { user });
  const suffix = pad(Math.abs(hashCode(`${text(caseDoc, 'CaseNumber')}|${serial}`)) % 100000000, 8);
  return db.create('ShipmentRecord', {
    ShipmentNumber: `SHP-${now.getFullYear()}-${pad(serial, 6)}`,
    CaseNumber: text(caseDoc, 'CaseNumber'),
    ShipToName: text(caseDoc, 'ShipToName'),
    ShipToStreet: text(caseDoc, 'ShipToStreet'),
    ShipToCity: text(caseDoc, 'ShipToCity'),
    ShipToState: text(caseDoc, 'ShipToState'),
    ShipToZIP: text(caseDoc, 'ShipToZIP'),
    Carrier: 'USPS Priority',
    TrackingNumber: `9405${pad(serial, 10)}${suffix}`,
    ShipStatus: 'Shipped',
    PickedDate: isoNow(now),
    ShippedDate: isoNow(now),
    DeliveredDate: '',
    Partial: 'No',
    PieceCount: Number(caseDoc.items.LineCount) || 0,
    ShippedBy: user,
    Contents: `${Number(caseDoc.items.LineCount) || 0} award line(s) for case ${text(caseDoc, 'CaseNumber')}`,
    ExceptionNote: '',
    DocReaders: caseDoc.items.DocReaders || [],
  }, { user, clock: () => now });
}

function hashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return h;
}

/** HAASAwards.AdvanceCase(): moves a case one stage forward, creating side documents. */
function advanceCase(ctx, caseDoc) {
  const { db, user, now } = ctx;
  const cur = text(caseDoc, 'Stage');
  if (!roleMayAdvance(user.roles, cur)) {
    return { ok: false, errors: [`Your role cannot advance a case from '${cur}'.`], forbidden: true };
  }
  const nxt = nextStage(cur, caseHasEngravableLines(db, caseDoc));
  if (!nxt || !isValidStageTransition(cur, nxt)) {
    return { ok: false, errors: [`Case ${text(caseDoc, 'CaseNumber')} could not be advanced from '${cur}'. See the agent log.`] };
  }
  const items = {};
  const side = [];
  const who = user.name;
  switch (nxt) {
    case STAGE.ENGRAVING: {
      const job = createEngravingJob(db, caseDoc, who, now);
      items.EngravingJobNumber = text(job, 'JobNumber');
      items.EngravingDate = isoNow(now);
      side.push(job);
      break;
    }
    case STAGE.ASSEMBLY: {
      items.AssemblyDate = isoNow(now);
      const job = db.findOne('EngravingJob', 'JobNumber', text(caseDoc, 'EngravingJobNumber'));
      if (job && text(job, 'JobStatus') !== 'Complete') {
        db.update(job, { JobStatus: 'Complete', CompletedDate: isoNow(now), Engraver: text(job, 'Engraver') || who }, { user: who, clock: () => now });
      }
      break;
    }
    case STAGE.WAREHOUSE:
      items.WarehouseDate = isoNow(now);
      if (!text(caseDoc, 'QCResult')) {
        items.QCResult = 'Pass';
      }
      if (!text(caseDoc, 'PickBin')) {
        items.PickBin = `${'ABCD'[Math.abs(hashCode(text(caseDoc, 'CaseNumber'))) % 4]}-${pad(1 + Math.abs(hashCode(text(caseDoc, 'CaseNumber'))) % 24, 2)}-${1 + Math.abs(hashCode(`${text(caseDoc, 'CaseNumber')}x`)) % 8}`;
      }
      break;
    case STAGE.SHIPPED:
      items.ShippedDate = isoNow(now);
      if (!text(caseDoc, 'TrackingNumber')) {
        const shp = createShipmentRecord(db, caseDoc, who, now);
        items.TrackingNumber = text(shp, 'TrackingNumber');
        side.push(shp);
      }
      break;
    case STAGE.CLOSED:
      items.ClosedDate = isoNow(now);
      items.AgingFlag = '';
      break;
    default:
      break;
  }
  const lineStatus = nxt === STAGE.CLOSED ? 'Shipped' : nxt;
  for (const line of db.findAll('AwardLine', 'ParentCaseNumber', text(caseDoc, 'CaseNumber'))) {
    db.update(line, { LineStatus: lineStatus }, { user: who, clock: () => now });
  }
  db.update(caseDoc, {
    ...items,
    Stage: nxt,
    StageDate: isoNow(now),
    DaysInStage: 0,
    StatusHistory: appendStatusHistory(caseDoc, cur, nxt, who, now),
    LastModifiedBy: who,
    LastModifiedDate: isoNow(now),
  }, { user: who, clock: () => now });
  return { ok: true, from: cur, to: nxt, doc: caseDoc, side };
}

/** NightlyAging.lss */
function nightlyAging(ctx) {
  const { db, user, now } = ctx;
  const amberDays = Number(db.profileValue('AgingAmberDays', AGING_AMBER_DEFAULT));
  const redDays = Number(db.profileValue('AgingRedDays', AGING_RED_DEFAULT));
  const log = [`Start - thresholds amber>${amberDays} red>${redDays}`];
  const stats = { processed: 0, amber: 0, red: 0, cleared: 0, changed: 0, badDate: 0 };
  const redList = [];
  const started = Date.now();
  for (const doc of db.all('AwardsCase')) {
    const stage = text(doc, 'Stage');
    if (stage === STAGE.CLOSED || stage === STAGE.CANCELLED || doc.items.$Archived !== undefined) {
      continue;
    }
    stats.processed += 1;
    let entered = text(doc, 'EnteredDate');
    let daysOpen = daysBetween(entered, now);
    if (daysOpen === null) {
      entered = text(doc, 'AuthorizationDate');
      daysOpen = daysBetween(entered, now);
      stats.badDate += 1;
    }
    const oldFlag = text(doc, 'AgingFlag');
    let newFlag = oldFlag;
    if (daysOpen === null) {
      daysOpen = -1;
    } else {
      newFlag = daysOpen > redDays ? 'Red' : daysOpen > amberDays ? 'Amber' : '';
    }
    const stageDate = text(doc, 'StageDate') || entered;
    const daysInStage = daysBetween(stageDate, now);
    const items = { DaysOpen: daysOpen, DaysInStage: daysInStage === null ? -1 : daysInStage, AgingLastEval: isoNow(now) };
    if (newFlag !== oldFlag) {
      items.AgingFlag = newFlag;
      items.StatusHistory = appendStatusHistory(doc, `AgingFlag=${oldFlag || '(none)'}`, `AgingFlag=${newFlag || '(none)'}`, 'NightlyAging', now);
      stats.changed += 1;
    }
    if (newFlag === 'Red') {
      stats.red += 1;
      if (redList.length < 200) {
        redList.push(`${text(doc, 'CaseNumber')}  ${daysOpen}d  ${stage}  ${text(doc, 'VeteranLastName')}, ${text(doc, 'VeteranFirstName')}`);
      }
    } else if (newFlag === 'Amber') {
      stats.amber += 1;
    } else if (oldFlag !== '') {
      stats.cleared += 1;
    }
    // Legacy behaviour: every open case is saved, which is why $UpdatedBy fills with the agent signer.
    db.update(doc, items, { user: 'CN=HAAS-APP01/O=TACOM', clock: () => now });
  }
  const profile = db.profile();
  if (profile) {
    db.update(profile, { AgingLastRun: isoNow(now) }, { user: user.name, clock: () => now });
  }
  log.push(`Done - processed ${stats.processed}, amber ${stats.amber}, red ${stats.red}, cleared ${stats.cleared}, changed ${stats.changed}, unparseable dates ${stats.badDate}, ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (stats.red > 0 || stats.amber > 0) {
    log.push(`Aging report mailed to ${db.profileValue('AgingReportTo', 'TACOM-CHPSID-Awards-CSR')}: ${stats.red} red, ${stats.amber} amber (mail routing is stubbed in the harness)`);
  }
  return { ok: true, stats, redList, log };
}

/* ------------------------------------------------------------------------------------------
 * ImportAuthorizationFile.lss
 * ---------------------------------------------------------------------------------------- */

function relationshipFromCode(code) {
  switch (String(code || '').trim().toUpperCase()) {
    case 'SE': case '': return 'Self';
    case 'SP': return 'Spouse';
    case 'SO': return 'Son';
    case 'DA': return 'Daughter';
    case 'PA': return 'Parent';
    case 'SI': return 'Sibling';
    case 'GC': return 'Grandchild';
    default: return 'Other NOK';
  }
}

function priorityFromCode(code) {
  switch (String(code || '').trim().toUpperCase()) {
    case 'E': return 'Expedite';
    case 'C': return 'Congressional';
    default: return 'Routine';
  }
}

function eraFromDates(dFrom, dTo) {
  if (!dTo) {
    return '';
  }
  const y = dTo.getFullYear();
  if (y <= 1946) return 'World War II';
  if (y <= 1955) return 'Korea';
  if (y <= 1975) return 'Vietnam';
  if (y <= 1990) return 'Cold War';
  if (y <= 1995) return 'Gulf War';
  if (y >= 2001) return 'Global War on Terrorism';
  return 'Peacetime';
}

/** HAASCommon.ParseLegacyDate: YYYYMMDD, YYYY-MM-DD, MM/DD/YYYY */
function parseLegacyDate(s) {
  const t = String(s || '').trim();
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(t);
  if (m) {
    return validDate(+m[1], +m[2], +m[3]);
  }
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) {
    return validDate(+m[1], +m[2], +m[3]);
  }
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (m) {
    return validDate(+m[3], +m[1], +m[2]);
  }
  return null;
}

function validDate(y, mo, d) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1900) {
    return null;
  }
  const dt = new Date(y, mo - 1, d);
  return dt.getMonth() === mo - 1 ? dt : null;
}

function buildRequesterKey(last, first, zip) {
  return `${String(last).trim().toUpperCase()}|${String(first).trim().toUpperCase()}|${String(zip).trim().slice(0, 5)}`;
}

function mid(line, start, len) {
  return line.substr(start - 1, len);
}

class Importer {
  constructor(ctx, authDoc) {
    this.ctx = ctx;
    this.db = ctx.db;
    this.now = ctx.now;
    this.user = ctx.user.name;
    this.authDoc = authDoc;
    this.log = [];
    this.cases = 0;
    this.lines = 0;
    this.reqNew = 0;
    this.reqMatched = 0;
    this.rejected = 0;
    this.authDate = null;
    this.caseByRef = new Map();
    this.awardTable = new Map();
    this.created = [];
    this.loadAwardTable();
  }

  addLog(msg) {
    const t = this.now;
    this.log.push(`${pad(t.getHours(), 2)}:${pad(t.getMinutes(), 2)}:${pad(t.getSeconds(), 2)} ${msg}`);
  }

  loadAwardTable() {
    const v = this.db.profileValue('Awards', []);
    for (const row of [].concat(v)) {
      const parts = String(row).split('|');
      if (parts.length >= 4) {
        this.awardTable.set(parts[1].trim().toUpperCase(), { name: parts[0], category: parts[2], engrave: parts[3] });
      }
    }
  }

  run(content) {
    const layout = text(this.authDoc, 'SourceAgency') === 'NPRC' ? 'NPRC' : 'HRC';
    const status = layout === 'NPRC' ? this.parseNPRC(content) : this.parseHRC(content);
    this.addLog(`${text(this.authDoc, 'FileName')}: ${status} - ${this.cases} cases, ${this.lines} lines, ${this.reqNew} new requesters, ${this.reqMatched} matched, ${this.rejected} rejected`);
    this.db.update(this.authDoc, {
      ImportStatus: status,
      ImportedDate: isoNow(this.now),
      ImportedBy: this.user,
      CasesCreated: this.cases,
      LinesCreated: this.lines,
      RequestersCreated: this.reqNew,
      RequestersMatched: this.reqMatched,
      RecordsRejected: this.rejected,
      ...(this.authDate ? { AuthorizationDate: isoDate(this.authDate) } : {}),
      ImportLog: this.log,
    }, { user: this.user, clock: () => this.now });
    const profile = this.db.profile();
    if (profile) {
      this.db.update(profile, { ImportLastRun: isoNow(this.now) }, { user: this.user, clock: () => this.now });
    }
    return { status, cases: this.cases, lines: this.lines, requestersNew: this.reqNew, requestersMatched: this.reqMatched, rejected: this.rejected, log: this.log, created: this.created };
  }

  parseHRC(content) {
    let lineNo = 0;
    let headerSeen = false;
    let trailerSeen = false;
    const lines = String(content).split(/\r?\n/);
    for (let raw of lines) {
      if (lineNo >= MAX_RECORDS) {
        this.addLog(`REJECTED remaining records: file exceeds ${MAX_RECORDS} lines`);
        break;
      }
      lineNo += 1;
      if (raw.length > MAX_LINE_LEN) {
        raw = raw.slice(0, MAX_LINE_LEN);
      }
      const recType = raw.slice(0, 2);
      switch (recType) {
        case '01': {
          headerSeen = true;
          const ymd = mid(raw, 19, 8);
          this.authDate = parseLegacyDate(ymd);
          if (!this.authDate) {
            this.addLog(`WARNING header authorization date unparseable: '${ymd}'`);
          }
          this.addLog(`HRC header: batch ${mid(raw, 11, 8).trim()}, auth date ${ymd}, ${Number(mid(raw, 27, 6)) || 0} records declared`);
          break;
        }
        case '10':
          if (!headerSeen) {
            this.addLog(`REJECTED line ${lineNo}: case record before header`);
            this.rejected += 1;
          } else {
            this.createCase({
              ref: mid(raw, 3, 10).trim(),
              last: mid(raw, 13, 30).trim(),
              first: mid(raw, 43, 20).trim(),
              mi: mid(raw, 63, 1).trim(),
              svcNum: mid(raw, 64, 8).trim(),
              svcFrom: mid(raw, 72, 8),
              svcTo: mid(raw, 80, 8),
              rel: mid(raw, 88, 2).trim(),
              reqLast: mid(raw, 90, 30).trim(),
              reqFirst: mid(raw, 120, 20).trim(),
              street: mid(raw, 140, 30).trim(),
              city: mid(raw, 170, 20).trim(),
              st: mid(raw, 190, 2).trim(),
              zip: mid(raw, 192, 10).trim(),
              deceased: mid(raw, 202, 1),
              priority: mid(raw, 203, 1),
              rank: mid(raw, 204, 12).trim(),
            }, 'HRC', lineNo);
          }
          break;
        case '20':
          this.createLine(mid(raw, 3, 10).trim(), mid(raw, 13, 6).trim(), Number(mid(raw, 19, 2)) || 0, Number(mid(raw, 21, 2)) || 0, mid(raw, 23, 1), mid(raw, 24, 40).trim(), mid(raw, 64, 30).trim(), lineNo);
          break;
        case '99': {
          trailerSeen = true;
          const declCases = Number(mid(raw, 3, 6)) || 0;
          this.addLog(`HRC trailer: ${declCases} cases / ${Number(mid(raw, 9, 6)) || 0} awards declared; created ${this.cases} / ${this.lines}`);
          this.db.update(this.authDoc, { TrailerChecksum: mid(raw, 15, 8).trim(), ChecksumMatch: declCases === this.cases ? 'Yes' : 'No' }, { user: this.user, clock: () => this.now });
          if (declCases !== this.cases) {
            this.addLog('WARNING trailer case count does not match cases created');
          }
          break;
        }
        case '':
          break;
        default:
          this.addLog(`REJECTED line ${lineNo}: unknown record type '${recType}'`);
          this.rejected += 1;
      }
    }
    this.db.update(this.authDoc, { RecordCount: lineNo }, { user: this.user, clock: () => this.now });
    if (!headerSeen) {
      this.addLog('REJECTED: no 01 header record');
      return 'Rejected';
    }
    if (!trailerSeen) {
      this.addLog('WARNING: no 99 trailer record - file may be truncated');
      return 'Imported with Errors';
    }
    return this.rejected > 0 ? 'Imported with Errors' : 'Imported';
  }

  parseNPRC(content) {
    let lineNo = 0;
    let headerSeen = false;
    let trailerSeen = false;
    for (let raw of String(content).split(/\r?\n/)) {
      if (lineNo >= MAX_RECORDS) {
        break;
      }
      lineNo += 1;
      if (raw.length > MAX_LINE_LEN) {
        raw = raw.slice(0, MAX_LINE_LEN);
      }
      if (raw.trim() === '') {
        continue;
      }
      const f = raw.split('|');
      switch (f[0]) {
        case 'NPRC-AWD':
          headerSeen = true;
          if (f.length >= 5) {
            this.authDate = parseLegacyDate(f[4]);
            this.addLog(`NPRC header: version ${f[1]}, batch ${f[3]}, auth date ${f[4]}`);
          } else {
            this.addLog('WARNING short NPRC header');
          }
          break;
        case 'C':
          if (f.length < 18) {
            this.addLog(`REJECTED line ${lineNo}: case record has ${f.length} fields, expected 18`);
            this.rejected += 1;
          } else {
            this.createCase({
              ref: f[1], last: f[2], first: f[3], mi: f[4], svcNum: f[5], svcFrom: f[6], svcTo: f[7], rel: f[8], reqLast: f[9], reqFirst: f[10],
              street: f[11], city: f[12], st: f[13], zip: f[14], deceased: f[15], priority: f[16], rank: f[17],
            }, 'NPRC', lineNo);
          }
          break;
        case 'A':
          if (f.length < 8) {
            this.addLog(`REJECTED line ${lineNo}: award record has ${f.length} fields, expected 8`);
            this.rejected += 1;
          } else {
            this.createLine(f[1], f[2], Number(f[3]) || 0, Number(f[4]) || 0, f[5], f[6], f[7], lineNo);
          }
          break;
        case 'T':
          trailerSeen = true;
          if (f.length >= 3) {
            this.addLog(`NPRC trailer: ${f[1]} cases / ${f[2]} awards declared; created ${this.cases} / ${this.lines}`);
            this.db.update(this.authDoc, { ChecksumMatch: Number(f[1]) === this.cases ? 'Yes' : 'No' }, { user: this.user, clock: () => this.now });
          }
          break;
        default:
          this.addLog(`REJECTED line ${lineNo}: unknown record type '${f[0]}'`);
          this.rejected += 1;
      }
    }
    this.db.update(this.authDoc, { RecordCount: lineNo }, { user: this.user, clock: () => this.now });
    if (!headerSeen) {
      return 'Rejected';
    }
    if (!trailerSeen || this.rejected > 0) {
      return 'Imported with Errors';
    }
    return 'Imported';
  }

  createCase(r, source, lineNo) {
    const ref = String(r.ref || '').trim();
    if (!r.last.trim() || !r.first.trim()) {
      this.addLog(`REJECTED line ${lineNo} (${ref}): veteran name missing`);
      this.rejected += 1;
      return null;
    }
    if (r.last.length > 60 || r.first.length > 40) {
      this.addLog(`REJECTED line ${lineNo} (${ref}): name exceeds field length`);
      this.rejected += 1;
      return null;
    }
    if (!/^[A-Za-z0-9 .,'-]*$/.test(r.last + r.first + (r.reqLast || '') + (r.reqFirst || ''))) {
      this.addLog(`REJECTED line ${lineNo} (${ref}): name contains characters outside the allowed set`);
      this.rejected += 1;
      return null;
    }
    if (r.zip.trim() && !/^\d{5}/.test(r.zip.trim())) {
      this.addLog(`WARNING line ${lineNo} (${ref}): ZIP '${r.zip}' not 5 digits - address flagged unverified`);
    }
    if (this.caseByRef.has(ref)) {
      this.addLog(`REJECTED line ${lineNo}: duplicate case reference ${ref} in file`);
      this.rejected += 1;
      return null;
    }
    const reqLast = r.reqLast.trim() || r.last;
    const reqFirst = r.reqFirst.trim() || r.first;
    const key = buildRequesterKey(reqLast, reqFirst, r.zip);
    const rel = relationshipFromCode(r.rel);
    let reqDoc = this.db.findOne('Requester', 'LookupKey', key);
    if (!reqDoc) {
      const serial = this.db.nextSerial('NextRequesterSerial', { user: this.user });
      reqDoc = this.db.create('Requester', {
        RequesterID: `RQ${String(this.now.getFullYear()).slice(-2)}${pad(serial, 6)}`,
        LastName: reqLast,
        FirstName: reqFirst,
        MI: '',
        Suffix: '',
        Relationship: rel,
        VeteranName: rel !== 'Self' ? `${r.last}, ${r.first}` : '',
        Street: r.street,
        City: r.city,
        State: r.st.toUpperCase(),
        ZIP: r.zip,
        Phone: '',
        Email: '',
        PreferredContact: 'Mail',
        Source: source,
        CreatedDate: isoDate(this.now),
        AddressVerified: 'No',
        AddressVerifiedDate: '',
        LookupKey: key,
        DisplayName: `${reqLast}, ${reqFirst}`,
        DocReaders: ['[TACOM]', '[CSR]', '[Admin]', '[ReadOnlyAudit]', 'LocalDomainServers'],
        MergedInto: '',
      }, { user: this.user, clock: () => this.now });
      this.reqNew += 1;
      this.created.push(reqDoc);
    } else {
      this.reqMatched += 1;
    }
    const serial = this.db.nextSerial('NextCaseSerial', { user: this.user });
    const dFrom = parseLegacyDate(r.svcFrom);
    const dTo = parseLegacyDate(r.svcTo);
    const caseDoc = this.db.create('AwardsCase', {
      CaseNumber: `VMA-${this.now.getFullYear()}-${pad(serial, 6)}`,
      Stage: STAGE.AUTHORIZED,
      Source: source,
      AuthFileName: text(this.authDoc, 'FileName'),
      AuthFileLine: lineNo,
      ExternalRef: ref,
      AuthorizationDate: this.authDate ? isoDate(this.authDate) : isoDate(this.now),
      EnteredDate: isoNow(this.now),
      EnteredBy: this.user,
      Priority: priorityFromCode(r.priority),
      ServiceNumber: r.svcNum,
      VeteranLastName: r.last,
      VeteranFirstName: r.first,
      VeteranMI: (r.mi || '').slice(0, 1).toUpperCase(),
      VeteranRank: r.rank,
      Branch: 'Army',
      ServiceFrom: dFrom ? isoDate(dFrom) : '',
      ServiceTo: dTo ? isoDate(dTo) : '',
      Era: eraFromDates(dFrom, dTo),
      Deceased: String(r.deceased).toUpperCase() === 'Y' ? 'Yes' : 'No',
      RequesterKey: key,
      RequesterName: `${reqLast}, ${reqFirst}`,
      Relationship: rel,
      AssignedCSR: this.user,
      LineCount: 0,
      EngravingRequired: 'No',
      EngravingDate: '',
      EngravingJobNumber: '',
      AssemblyDate: '',
      QCResult: '',
      WarehouseDate: '',
      PickBin: '',
      ShippedDate: '',
      TrackingNumber: '',
      ClosedDate: '',
      DaysOpen: 0,
      AgingFlag: '',
      HoldReason: '',
      StageBeforeHold: '',
      ShipToName: `${reqFirst} ${reqLast}`,
      ShipToStreet: r.street,
      ShipToCity: r.city,
      ShipToState: r.st.toUpperCase(),
      ShipToZIP: r.zip,
      Remarks: '',
      StatusHistory: [`${stamp(this.now)} | (new) -> Authorized | ImportAuthorizationFile`],
      DocReaders: ['[TACOM]', '[CSR]', '[Admin]', '[ReadOnlyAudit]', 'LocalDomainServers', this.user],
      DocAuthors: ['[TACOM]', '[CSR]', '[Admin]'],
      LookupKey: `VMA-${this.now.getFullYear()}-${pad(serial, 6)}`,
      StageDate: isoNow(this.now),
    }, { user: this.user, clock: () => this.now });
    this.caseByRef.set(ref, caseDoc);
    this.cases += 1;
    this.created.push(caseDoc);
    return caseDoc;
  }

  createLine(ref, awardCode, qty, devices, engrave, engText, authority, lineNo) {
    const caseDoc = this.caseByRef.get(String(ref || '').trim());
    if (!caseDoc) {
      this.addLog(`REJECTED line ${lineNo}: award record for unknown case ${ref} (orphan)`);
      this.rejected += 1;
      return null;
    }
    const code = String(awardCode || '').trim().toUpperCase();
    const info = this.awardTable.get(code);
    let awardName;
    let category;
    if (info) {
      awardName = info.name;
      category = info.category;
    } else {
      awardName = code;
      category = '';
      this.addLog(`WARNING line ${lineNo}: unknown award code '${awardCode}' - stored as free text`);
    }
    let q = qty < 1 ? 1 : qty;
    if (q > 3) {
      this.addLog(`WARNING line ${lineNo}: quantity ${q} capped at 3`);
      q = 3;
    }
    const n = (Number(caseDoc.items.LineCount) || 0) + 1;
    const doEngrave = String(engrave).toUpperCase() === 'Y' || isEngravable(awardName);
    let eng = String(engText || '').trim();
    if (doEngrave && !eng) {
      eng = `${text(caseDoc, 'VeteranFirstName')} ${text(caseDoc, 'VeteranMI')} ${text(caseDoc, 'VeteranLastName')}`.replace(/\s+/g, ' ').toUpperCase();
    }
    const line = this.db.create('AwardLine', {
      ParentCaseNumber: text(caseDoc, 'CaseNumber'),
      ParentUNID: caseDoc.unid,
      VeteranName: `${text(caseDoc, 'VeteranLastName')}, ${text(caseDoc, 'VeteranFirstName')}`,
      LineNumber: n,
      LineKey: `${text(caseDoc, 'CaseNumber')}-${pad(n, 2)}`,
      AwardName: awardName,
      AwardCode: code,
      AwardCategory: category,
      Quantity: q,
      SetType: 'Full Size',
      Devices: [],
      DeviceCount: devices,
      Engrave: doEngrave ? 'Yes' : 'No',
      EngravingText: doEngrave ? eng.toUpperCase().slice(0, 40) : '',
      StockNumber: '',
      LineStatus: 'Authorized',
      BackorderETA: '',
      Authority: String(authority || '').slice(0, 60),
      DocReaders: caseDoc.items.DocReaders,
    }, { user: this.user, parent: caseDoc.unid, clock: () => this.now });
    const upd = { LineCount: n };
    if (doEngrave) {
      upd.EngravingRequired = 'Yes';
    }
    this.db.update(caseDoc, upd, { user: this.user, clock: () => this.now });
    this.lines += 1;
    this.created.push(line);
    return line;
  }
}

/**
 * ImportAuthorizationFile against an uploaded file. Creates (or reuses) the AuthorizationFile
 * document keyed on FileName, then parses `content`.
 */
function importAuthorizationFile(ctx, fileName, content, opts = {}) {
  const { db, user, now } = ctx;
  const name = String(fileName || '').trim();
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(name)) {
    throw new AppError('File name must be 1-80 characters: letters, digits, underscore, dot or hyphen.');
  }
  if (typeof content !== 'string' || content.length === 0) {
    throw new AppError('The authorization file is empty.');
  }
  if (content.length > 2 * 1024 * 1024) {
    throw new AppError('The authorization file exceeds the 2 MB import limit.');
  }
  if (/[^\t\r\n\x20-\x7E]/.test(content)) {
    throw new AppError('The authorization file contains characters outside the printable ASCII range expected by the HRC/NPRC layouts.');
  }
  const agency = opts.sourceAgency || (/^nprc/i.test(name) || /^NPRC-AWD\|/.test(content) ? 'NPRC' : 'HRC');
  let authDoc = db.findOne('AuthorizationFile', 'FileName', name);
  if (authDoc && text(authDoc, 'ImportStatus') === 'Imported' && !opts.force) {
    return { ok: false, status: 'Skipped', log: [`Skipped - already imported on ${text(authDoc, 'ImportedDate')}`], authDoc };
  }
  if (!authDoc) {
    authDoc = db.create('AuthorizationFile', {
      FileName: name,
      FileKey: name.toUpperCase(),
      SourceAgency: agency,
      Layout: agency === 'NPRC' ? 'NPRC-DELIM' : 'HRC-FIXED',
      TransmissionDate: isoDate(now),
      ReceivedDate: isoNow(now),
      AuthorizationDate: '',
      ImportStatus: 'Received',
      ImportedDate: '',
      ImportedBy: '',
      RecordCount: content.split(/\r?\n/).length,
      CasesCreated: 0,
      LinesCreated: 0,
      RequestersCreated: 0,
      RequestersMatched: 0,
      RecordsRejected: 0,
      TrailerChecksum: '',
      ChecksumMatch: '',
      ImportLog: [],
      DocReaders: ['[Importer]', '[Admin]', '[TACOM]', '[ReadOnlyAudit]', 'LocalDomainServers'],
    }, { user: user.name, clock: () => now });
    authDoc.files.push({ name, size: Buffer.byteLength(content) });
  }
  const importer = new Importer(ctx, authDoc);
  importer.addLog(`Extracted ${name} (${Buffer.byteLength(content)} bytes)`);
  const result = importer.run(content);
  return { ok: true, ...result, authDoc };
}

module.exports = {
  modifyRequestLine,
  AppError,
  STATUS,
  STAGE,
  STAGE_ORDER,
  MSG_RELEASED_NOMODIFY,
  MSG_CANCELLED,
  REQUEST_FIELDS,
  LINE_FIELDS,
  computeWithForm,
  createRequest,
  modifyRequest,
  releaseToVendor,
  cancelRequest,
  statusInquiry,
  isReleased,
  isValidStageTransition,
  nextStage,
  roleMayAdvance,
  caseHasEngravableLines,
  advanceCase,
  nightlyAging,
  importAuthorizationFile,
  parseLegacyDate,
  buildRequesterKey,
  eraFromDates,
  relationshipFromCode,
  priorityFromCode,
  text,
  commonName,
  daysBetween,
};
