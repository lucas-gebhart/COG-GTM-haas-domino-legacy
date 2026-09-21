'use strict';

/**
 * heraldry.nsf routes: HeraldryHome.xsp, Request?OpenForm, ModifyRequest.xsp,
 * StatusInquiry.xsp, SESFlag.xsp, VendorQueue.xsp, <view>?OpenView, 0/<unid>?OpenDocument
 * and the document actions (release, cancel).
 */

const H = require('../lib/html');
const A = require('../lib/agents');
const { hasRole } = require('../lib/personas');
const { render } = require('./common');
const D = require('./docview');
const {
  Router, dominoCommand, splitDbPath, requireLogin, requireRole, cleanUnid, cleanName, cleanText, cleanCode, cleanInt,
} = require('./router');

const DB = 'heraldry.nsf';
const router = new Router();

function actx(ctx) {
  return { design: ctx.app.designs[DB], db: ctx.app.store.db(DB), engine: ctx.app.engines[DB], user: ctx.user, now: ctx.now, log: (a, m) => ctx.app.log('info', a, { message: m }) };
}

function page(ctx, opts) {
  return render(ctx, { db: DB, ...opts });
}

function docLink(doc, label) {
  return `<a href="/heraldry.nsf/0/${H.attr(doc.unid)}?OpenDocument">${H.esc(label || A.text(doc, 'DocumentNumber') || A.text(doc, 'SESFlagNumber'))}</a>`;
}

function statusChip(status) {
  const cls = {
    Draft: 'stDraft', Submitted: 'stSubmitted', 'Under Review': 'stReview', Approved: 'stApproved', 'Released to Vendor': 'stReleased', 'In Production': 'stProduction', Shipped: 'stShipped', Complete: 'stComplete', Cancelled: 'stCancelled',
  }[status] || 'stOther';
  return `<span class="statusChip ${cls}">${H.esc(status || '(blank)')}</span>`;
}

/* ---------------------------------------------------------------- form field rendering from DXL */

function fieldInput(field, value, opts = {}) {
  const v = value === undefined || value === null ? '' : (Array.isArray(value) ? value.join(', ') : String(value));
  if (field.type === 'keyword' && field.keywords.length) {
    return H.select(field.name, field.keywords, v, { blank: opts.blank });
  }
  if (field.type === 'richtext') {
    return `<textarea name="${H.attr(field.name)}" id="${H.attr(field.name)}" rows="4" cols="60" maxlength="2000" class="xspInputFieldEditBox">${H.esc(v)}</textarea>`;
  }
  if (field.type === 'datetime') {
    return H.input(field.name, v, { size: 12, maxlength: 10, extra: ' placeholder="mm/dd/yyyy"' });
  }
  if (field.type === 'number') {
    return H.input(field.name, v, { size: 6, maxlength: 10 });
  }
  return H.input(field.name, v, { size: opts.size || 30, maxlength: opts.maxlength || 255 });
}

const REQUEST_LAYOUT = [
  { section: 'Block 1-3: Requisitioner (DODAAC / UIC / Unit)' },
  { cells: ['DODAAC', 'UIC'] },
  { cells: ['UnitName', 'RequestType'] },
  { section: 'Block 4-12: Requisition data' },
  { cells: ['RPD', 'SignalCode'] },
  { cells: ['FundCode', 'ProjectCode'] },
  { cells: ['SupplementaryAddress', 'RequiredDeliveryDate'] },
  { section: 'Block 13: Ship-to (if different from requisitioner)' },
  { cells: ['ShipToDODAAC', 'ShipToName'] },
  { cells: ['ShipToAddress1', 'ShipToAddress2'] },
  { cells: ['ShipToCity', 'ShipToState'] },
  { cells: ['ShipToZIP'] },
  { section: 'Block 27: Exception data / justification' },
  { single: 'Justification' },
];

const HELP = {
  DODAAC: '6-character DoD Activity Address Code, e.g. W6KJAA',
  UIC: 'Army Unit Identification Code: W + 5 alphanumerics',
  RPD: 'Requisition Priority Designator 01-15 (F/AD x UND)',
  FundCode: '2-character fund code from the Profile keyword list',
  RequiredDeliveryDate: 'mm/dd/yyyy; must be in the future',
  ShipToZIP: '5 or 9 digit ZIP',
  ItemKey: 'Stock number from the Heraldic Catalog; leave blank for non-NSN exception data',
  Quantity: 'Per-item limits are enforced from HeraldicCatalog column 5',
};

function requestFormHtml(ctx, values, lineValues, errors, opts = {}) {
  const design = ctx.app.designs[DB];
  const form = D.findForm(design, 'Request');
  const lineForm = D.findForm(design, 'RequestLine');
  const db = ctx.app.store.db(DB);
  const byName = Object.fromEntries(form.fields.map((f) => [f.name, f]));
  const lineByName = Object.fromEntries(lineForm.fields.map((f) => [f.name, f]));
  const cell = (name) => {
    const f = byName[name];
    return { label: D.humanize(name), value: fieldInput(f, values[name]), raw: true, required: Boolean(f.inputValidation && /required|@Failure/.test(f.inputValidation) && !/ShipToAddress2/.test(name)), help: HELP[name] };
  };
  const rows = REQUEST_LAYOUT.map((r) => {
    if (r.section) {
      return r;
    }
    if (r.single) {
      return { ...cell(r.single), colspan: 3 };
    }
    return { cells: r.cells.map(cell) };
  });
  const items = db.all('HeraldicItem').filter((d) => A.text(d, 'Active') !== 'No').map((d) => [A.text(d, 'StockNumber'), `${A.text(d, 'StockNumber')}  ${A.text(d, 'ItemName')} (${H.money(d.items.UnitPrice)} / ${A.text(d, 'UnitOfIssue')}, max ${A.text(d, 'MaxQtyPerRequest')})`]);
  const lineRows = [
    { section: 'Line item 1 (additional lines are added from the RequestLine form after submission)' },
    { cells: [{ label: 'Heraldic Item', value: H.select('ItemKey', items, lineValues.ItemKey || '', { blank: '(exception / non-NSN item)' }), raw: true, help: HELP.ItemKey }, { label: 'NSN', value: fieldInput(lineByName.NSN, lineValues.NSN), raw: true, help: '13-digit National Stock Number, or blank for exception data' }] },
    { cells: [{ label: 'Exception Data', value: fieldInput(lineByName.ExceptionData, lineValues.ExceptionData, { size: 40 }), raw: true }, { label: 'Unit of Issue', value: fieldInput(lineByName.UnitOfIssue, lineValues.UnitOfIssue || 'EA'), raw: true }] },
    { cells: [{ label: 'Quantity', value: fieldInput(lineByName.Quantity, lineValues.Quantity === undefined ? 1 : lineValues.Quantity), raw: true, required: true, help: HELP.Quantity }] },
  ];
  return `
${H.errorBlock(errors, 'The request could not be saved. Correct the following and resubmit (Domino @Failure):')}
<form method="post" action="${H.attr(opts.action || '/heraldry.nsf/Request?CreateDocument')}" class="dominoForm" autocomplete="off">
<div class="formHeader"><b>DD FORM 1348-6</b> &nbsp; DoD Single Line Item Requisition System Document (Manual - Long Form) &nbsp; <span class="muted">Heraldic items: non-NSN / exception data</span></div>
${H.fieldTable(rows)}
${opts.noLine ? '' : H.fieldTable(lineRows)}
<div class="formButtons">${H.button(opts.submitLabel || 'Submit Request')} ${H.button('Reset', { type: 'reset', className: 'xspButtonCommand' })} ${H.linkButton('/heraldry.nsf/HeraldryHome.xsp', 'Cancel')}</div>
<p class="muted">Fields marked <span class="req">*</span> carry an input-validation @Formula on the Request form. Validation is executed server-side from the DXL, exactly as Domino evaluates it on Save.</p>
</form>`;
}

/* ---------------------------------------------------------------- HeraldryHome.xsp */

router.get((ctx) => ctx.pathname === '/heraldry.nsf/HeraldryHome.xsp', (ctx) => {
  const db = ctx.app.store.db(DB);
  const counts = {};
  for (const d of db.all('Request')) {
    const s = A.text(d, 'Status') || '(blank)';
    counts[s] = (counts[s] || 0) + 1;
  }
  const statusOrder = [].concat(db.profileValue('StatusList', []));
  const statusRows = Object.keys(counts).sort((a, b) => (statusOrder.indexOf(a) === -1 ? 99 : statusOrder.indexOf(a)) - (statusOrder.indexOf(b) === -1 ? 99 : statusOrder.indexOf(b)))
    .map((s) => `<tr><td>${statusChip(s)}</td><td align="right"><a href="/heraldry.nsf/RequestsByStatus?OpenView&amp;RestrictToCategory=${H.attr(encodeURIComponent(s))}">${counts[s]}</a></td></tr>`).join('');
  const mine = ctx.user.anonymous ? [] : db.all('Request').filter((d) => A.text(d, 'EnteredBy') === ctx.user.name || (ctx.user.dodaac && A.text(d, 'DODAAC') === ctx.user.dodaac));
  const recent = (mine.length ? mine : db.all('Request')).slice().sort((a, b) => String(b.modified).localeCompare(String(a.modified))).slice(0, 12);
  const recentRows = recent.map((d) => `<tr><td>${docLink(d)}</td><td>${H.esc(A.text(d, 'DODAAC'))}</td><td>${H.esc(A.text(d, 'UnitName'))}</td><td>${H.esc(A.text(d, 'RequestType'))}</td><td>${statusChip(A.text(d, 'Status'))}</td><td>${H.esc(H.fmtValue(d.modified))}</td></tr>`).join('');
  const sesCount = db.all('SESFlagRequest').filter((d) => ['Submitted', 'Draft'].includes(A.text(d, 'Status'))).length;
  const content = `
<table width="100%" border="0" cellpadding="6"><tr><td valign="top" width="58%">
<div class="welcomeBox">
<p>Welcome to the <b>Heraldry Automation System</b>. Unit supply personnel (S4) use this site to submit <b>DD Form 1348-6</b> requisitions for guidons, distinguishing flags, organizational colors, streamers and insignia to the TACOM ILSC Clothing &amp; Heraldry Product Support Integration Directorate. Requests may be modified or cancelled until they are released to a vendor.</p>
<p class="muted">Access is granted through Army EAMS-A. Vendors and automation-system users have separate access. ${ctx.user.anonymous ? '<a href="/names.nsf?Login">Log in</a> to create or modify requests.' : `You are logged in as <b>${H.esc(ctx.user.name)}</b>.`}</p>
</div>
<table class="homeTiles" border="0" cellpadding="8" cellspacing="6">
<tr>
<td class="tile"><a href="/heraldry.nsf/Request?OpenForm"><b>Create a Request</b></a><br>New DD 1348-6 requisition for heraldic items.</td>
<td class="tile"><a href="/heraldry.nsf/ModifyRequest.xsp"><b>Modify / Cancel a Request</b></a><br>Change or cancel a request that has not been released to a vendor.</td>
</tr><tr>
<td class="tile"><a href="/heraldry.nsf/StatusInquiry.xsp"><b>Status Inquiry</b></a><br>Look up a request by document number and DODAAC.</td>
<td class="tile"><a href="/heraldry.nsf/SESFlag.xsp"><b>SES Flag Request</b></a><br>Positional colors and automobile flags for Senior Executive Service members.${sesCount ? ` <span class="badge">${sesCount} pending</span>` : ''}</td>
</tr><tr>
<td class="tile"><a href="/heraldry.nsf/VendorQueue.xsp"><b>Vendor Work Queue</b></a><br>Released requests by vendor (vendor and TACOM access).</td>
<td class="tile"><a href="/heraldry.nsf/HeraldicCatalog?OpenView"><b>Heraldic Catalog</b></a><br>${db.all('HeraldicItem').length} stock-numbered items with unit prices and quantity limits.</td>
</tr></table>
</td><td valign="top">
<h3>Requests by status</h3>
<table class="dominoView compact" border="1" cellpadding="3" cellspacing="0"><tr><th>Status</th><th>Count</th></tr>${statusRows}<tr class="totalRow"><td>Total</td><td align="right">${db.all('Request').length}</td></tr></table>
<p class="muted">Counts come from the RequestsByStatus view (free-text Status values appear as their own categories).</p>
</td></tr></table>
<h3>${mine.length ? 'Your recent requests' : 'Recently modified requests'}</h3>
<table class="dominoView" border="1" cellpadding="3" cellspacing="0" width="100%"><tr><th>Document Number</th><th>DODAAC</th><th>Unit</th><th>Type</th><th>Status</th><th>Last Modified</th></tr>${recentRows}</table>`;
  return page(ctx, { title: 'Heraldry Automation System - Home', content, current: 'home' });
});

/* ---------------------------------------------------------------- Request?OpenForm / ?CreateDocument */

router.get((ctx) => ctx.pathname === '/heraldry.nsf/Request' && dominoCommand(ctx.query) === 'openform', (ctx) => {
  requireLogin(ctx);
  const defaults = { DODAAC: ctx.user.dodaac || '', UIC: ctx.user.uic || '', UnitName: ctx.user.unit || '', RPD: '13', SignalCode: 'A', RequestType: 'Guidon' };
  return page(ctx, { title: 'New Request (DD Form 1348-6)', content: requestFormHtml(ctx, defaults, {}, []), breadcrumb: [{ label: 'Heraldry', href: '/heraldry.nsf/HeraldryHome.xsp' }, { label: 'Request?OpenForm' }] });
});

router.get((ctx) => ctx.pathname === '/heraldry.nsf/Request.xsp', (ctx) => ctx.redirect('/heraldry.nsf/Request?OpenForm', 302));

router.post((ctx) => ctx.pathname === '/heraldry.nsf/Request' && dominoCommand(ctx.query) === 'createdocument', (ctx) => {
  requireLogin(ctx);
  const values = {};
  for (const k of A.REQUEST_FIELDS) {
    values[k] = k === 'Justification' ? cleanText(ctx.body[k], 2000) : cleanText(ctx.body[k], 255);
  }
  for (const k of ['DODAAC', 'UIC', 'ShipToDODAAC', 'FundCode', 'ProjectCode', 'ShipToState', 'SignalCode', 'RPD']) {
    values[k] = cleanCode(values[k], 32);
  }
  const line = {};
  for (const k of A.LINE_FIELDS) {
    line[k] = cleanText(ctx.body[k], 255);
  }
  line.ItemKey = cleanCode(line.ItemKey, 20);
  line.NSN = cleanCode(line.NSN, 20);
  const r = A.createRequest(actx(ctx), { ...values, ...line });
  if (!r.ok) {
    ctx.app.audit.write('validation_failure', { user: ctx.user.name, ip: ctx.ip, db: DB, form: 'Request', errors: r.errors.slice(0, 10) });
    ctx.res.statusCode = 400;
    return page(ctx, { title: 'New Request (DD Form 1348-6)', content: requestFormHtml(ctx, values, line, r.errors) });
  }
  ctx.app.audit.write('document_create', { user: ctx.user.name, ip: ctx.ip, db: DB, form: 'Request', unid: r.doc.unid, documentNumber: A.text(r.doc, 'DocumentNumber'), lines: 1 });
  return ctx.redirect(`/heraldry.nsf/0/${r.doc.unid}?OpenDocument&Saved=1`, 303);
});

/* ---------------------------------------------------------------- ModifyRequest.xsp */

function modifyLanding(ctx, message) {
  const db = ctx.app.store.db(DB);
  const mine = ctx.user.anonymous ? [] : db.all('Request').filter((d) => (A.text(d, 'EnteredBy') === ctx.user.name || (ctx.user.dodaac && A.text(d, 'DODAAC') === ctx.user.dodaac)));
  const open = (mine.length ? mine : db.all('Request')).filter((d) => !A.isReleased(db, d)).slice(0, 25);
  const rows = open.map((d) => `<tr><td>${docLink(d)}</td><td>${H.esc(A.text(d, 'DODAAC'))}</td><td>${H.esc(A.text(d, 'UnitName'))}</td><td>${statusChip(A.text(d, 'Status'))}</td><td>${H.esc(H.fmtValue(d.items.EnteredDate))}</td><td>${H.linkButton(`/heraldry.nsf/ModifyRequest.xsp?documentId=${d.unid}`, 'Modify')}</td></tr>`).join('');
  const content = `
${message ? H.infoBlock(message) : ''}
<p>Enter the document number of the request to modify or cancel. Requests that have been <b>released to a vendor</b> can no longer be modified or cancelled (Error 4091) - contact the Clothing &amp; Heraldry customer service desk.</p>
<form method="get" action="/heraldry.nsf/ModifyRequest.xsp" class="dominoForm inlineForm">
<label>Document Number ${H.input('DocumentNumber', ctx.query.DocumentNumber || '', { size: 18, maxlength: 14 })}</label>
${H.button('Find Request')}
</form>
<h3>${mine.length ? 'Your open requests' : 'Open requests (not yet released)'}</h3>
<table class="dominoView" border="1" cellpadding="3" cellspacing="0" width="100%"><tr><th>Document Number</th><th>DODAAC</th><th>Unit</th><th>Status</th><th>Entered</th><th></th></tr>${rows}</table>`;
  return page(ctx, { title: 'Modify / Cancel Request', content });
}

function modifyForm(ctx, doc, values, errors) {
  const db = ctx.app.store.db(DB);
  const design = ctx.app.designs[DB];
  const form = D.findForm(design, 'Request');
  const byName = Object.fromEntries(form.fields.map((f) => [f.name, f]));
  const editable = ['UnitName', 'RPD', 'SignalCode', 'FundCode', 'ProjectCode', 'SupplementaryAddress', 'RequestType', 'RequiredDeliveryDate', 'ShipToDODAAC', 'ShipToName', 'ShipToAddress1', 'ShipToAddress2', 'ShipToCity', 'ShipToState', 'ShipToZIP', 'Justification'];
  const cell = (name) => (editable.includes(name)
    ? { label: D.humanize(name), value: fieldInput(byName[name], values[name]), raw: true, help: HELP[name] }
    : { label: D.humanize(name), value: `<span class="readonlyValue">${H.esc(H.fmtValue(values[name]))}</span>`, raw: true });
  const rows = REQUEST_LAYOUT.map((r) => {
    if (r.section) {
      return r;
    }
    if (r.single) {
      return { ...cell(r.single), colspan: 3 };
    }
    return { cells: r.cells.map(cell) };
  });
  const lines = db.responses(doc.unid, 'RequestLine');
  const content = `
${H.errorBlock(errors, 'The request could not be saved:')}
<div class="docHeader"><b>${H.esc(A.text(doc, 'DocumentNumber'))}</b> &nbsp; ${statusChip(A.text(doc, 'Status'))} &nbsp; <span class="muted">Entered ${H.esc(H.fmtValue(doc.items.EnteredDate))} by ${H.esc(A.commonName(A.text(doc, 'EnteredBy')))}</span></div>
<form method="post" action="/heraldry.nsf/ModifyRequest.xsp?documentId=${H.attr(doc.unid)}&amp;action=save" class="dominoForm" autocomplete="off">
${H.fieldTable(rows)}
<div class="formButtons">${H.button('Save Changes')} ${H.linkButton(`/heraldry.nsf/0/${doc.unid}?OpenDocument`, 'Close')}</div>
</form>
<h3>Line items (${lines.length})</h3>
${D.responsesTable(DB, lines, [
    { title: 'Line', item: 'LineDocNumber' }, { title: 'NSN / Item', render: (l) => H.esc(A.text(l, 'NSN') || A.text(l, 'ItemKey')) }, { title: 'Description', item: 'ItemDescription' }, { title: 'Exception Data', item: 'ExceptionData' }, { title: 'U/I', item: 'UnitOfIssue' }, { title: 'Qty', item: 'Quantity' }, { title: 'Unit Price', render: (l) => H.esc(H.money(l.items.UnitPrice)) }, { title: 'Extended', render: (l) => H.esc(H.money(l.items.ExtendedPrice)) }, { title: 'Line Status', item: 'LineStatus' },
  ])}
<h3>Cancel this request</h3>
<form method="post" action="/heraldry.nsf/0/${H.attr(doc.unid)}?CancelRequest" class="dominoForm inlineForm">
<label>Reason ${H.input('CancelReason', '', { size: 50, maxlength: 255 })}</label> ${H.button('Cancel Request', { className: 'xspButtonCommand dangerButton' })}
</form>`;
  return page(ctx, { title: `Modify Request ${A.text(doc, 'DocumentNumber')}`, content, breadcrumb: [{ label: 'Heraldry', href: '/heraldry.nsf/HeraldryHome.xsp' }, { label: 'ModifyRequest.xsp' }, { label: A.text(doc, 'DocumentNumber') }] });
}

function blockedPage(ctx, doc, messages, title) {
  ctx.res.statusCode = 403;
  const content = `
<div class="dominoErrorPage">
<table class="dominoError" border="0" cellpadding="6"><tr><td class="errIcon">&#9940;</td><td><b>Request ${H.esc(A.text(doc, 'DocumentNumber'))}</b><br>${messages.map((m) => `<div class="legacyError">${H.esc(m)}</div>`).join('')}</td></tr></table>
<p>${H.linkButton(`/heraldry.nsf/0/${doc.unid}?OpenDocument`, 'Open Request (read-only)')} ${H.linkButton('/heraldry.nsf/StatusInquiry.xsp', 'Status Inquiry')} ${H.linkButton('/heraldry.nsf/HeraldryHome.xsp', 'Home')}</p>
<p class="muted">Domino: HAASCommon.MSG_RELEASED_NOMODIFY raised from ModifyRequest.xsp querySaveDocument / CancelRequest.lss.</p>
</div>`;
  return page(ctx, { title: title || 'Request cannot be modified', content });
}

router.get((ctx) => ctx.pathname === '/heraldry.nsf/ModifyRequest.xsp', (ctx) => {
  requireLogin(ctx);
  const db = ctx.app.store.db(DB);
  let doc = null;
  if (ctx.query.documentId) {
    doc = db.get(cleanUnid(ctx.query.documentId));
    if (!doc || doc.form !== 'Request') {
      throw new A.AppError('Request not found', 404);
    }
  } else if (ctx.query.DocumentNumber) {
    const num = cleanCode(ctx.query.DocumentNumber, 14);
    doc = db.findOne('Request', 'DocumentNumber', num);
    if (!doc) {
      return modifyLanding(ctx, `No request with document number ${num} was found.`);
    }
    return ctx.redirect(`/heraldry.nsf/ModifyRequest.xsp?documentId=${doc.unid}`, 302);
  } else {
    return modifyLanding(ctx, '');
  }
  if (A.text(doc, 'Status') === A.STATUS.CANCELLED) {
    return blockedPage(ctx, doc, [A.MSG_CANCELLED], 'Request is cancelled');
  }
  if (A.isReleased(db, doc)) {
    ctx.app.audit.write('authorization_failure', { user: ctx.user.name, ip: ctx.ip, db: DB, unid: doc.unid, action: 'modify', reason: 'released_to_vendor' });
    return blockedPage(ctx, doc, [A.MSG_RELEASED_NOMODIFY]);
  }
  return modifyForm(ctx, doc, { ...doc.items }, []);
});

router.post((ctx) => ctx.pathname === '/heraldry.nsf/ModifyRequest.xsp', (ctx) => {
  requireLogin(ctx);
  const db = ctx.app.store.db(DB);
  const doc = db.get(cleanUnid(ctx.query.documentId));
  if (!doc || doc.form !== 'Request') {
    throw new A.AppError('Request not found', 404);
  }
  const values = {};
  for (const k of A.REQUEST_FIELDS) {
    if (ctx.body[k] !== undefined) {
      values[k] = k === 'Justification' ? cleanText(ctx.body[k], 2000) : cleanText(ctx.body[k], 255);
    }
  }
  for (const k of ['ShipToDODAAC', 'FundCode', 'ProjectCode', 'ShipToState', 'SignalCode', 'RPD']) {
    if (values[k] !== undefined) {
      values[k] = cleanCode(values[k], 32);
    }
  }
  const r = A.modifyRequest(actx(ctx), doc, values);
  if (!r.ok && r.blocked) {
    ctx.app.audit.write('authorization_failure', { user: ctx.user.name, ip: ctx.ip, db: DB, unid: doc.unid, action: 'modify', reason: 'released_or_cancelled' });
    return blockedPage(ctx, doc, r.errors);
  }
  if (!r.ok) {
    ctx.res.statusCode = 400;
    return modifyForm(ctx, doc, { ...doc.items, ...values }, r.errors);
  }
  ctx.app.audit.write('document_modify', { user: ctx.user.name, ip: ctx.ip, db: DB, form: 'Request', unid: doc.unid, documentNumber: A.text(doc, 'DocumentNumber'), changed: r.changed });
  return ctx.redirect(`/heraldry.nsf/0/${doc.unid}?OpenDocument&Saved=1`, 303);
});

/* ---------------------------------------------------------------- document actions: ?ReleaseToVendor ?CancelRequest */

function docFromPath(ctx) {
  const p = splitDbPath(ctx.pathname);
  if (!p || p.parts.length !== 2 || p.parts[0] !== '0') {
    return null;
  }
  return ctx.app.store.db(DB).get(cleanUnid(p.parts[1]));
}

router.post((ctx) => splitDbPath(ctx.pathname) && splitDbPath(ctx.pathname).db === DB && /^0\/[A-Fa-f0-9]{32}$/.test(splitDbPath(ctx.pathname).rest) && ctx.query.ReleaseToVendor === '', (ctx) => {
  requireRole(ctx, '[TACOM]', '[Admin]');
  const doc = docFromPath(ctx);
  if (!doc || doc.form !== 'Request') {
    throw new A.AppError('Request not found', 404);
  }
  const r = A.releaseToVendor(actx(ctx), doc, cleanCode(ctx.body.VendorKey, 10));
  if (!r.ok) {
    ctx.app.audit.write(r.blocked ? 'authorization_failure' : 'validation_failure', { user: ctx.user.name, ip: ctx.ip, db: DB, unid: doc.unid, action: 'release', errors: r.errors });
    return documentPage(ctx, doc, { errors: r.errors });
  }
  ctx.app.audit.write('request_release', { user: ctx.user.name, ip: ctx.ip, db: DB, unid: doc.unid, documentNumber: A.text(doc, 'DocumentNumber'), vendorKey: A.text(doc, 'VendorKey') });
  return ctx.redirect(`/heraldry.nsf/0/${doc.unid}?OpenDocument&Released=1`, 303);
});

router.post((ctx) => splitDbPath(ctx.pathname) && splitDbPath(ctx.pathname).db === DB && /^0\/[A-Fa-f0-9]{32}$/.test(splitDbPath(ctx.pathname).rest) && ctx.query.CancelRequest === '', (ctx) => {
  requireLogin(ctx);
  const doc = docFromPath(ctx);
  if (!doc || doc.form !== 'Request') {
    throw new A.AppError('Request not found', 404);
  }
  const r = A.cancelRequest(actx(ctx), doc, cleanText(ctx.body.CancelReason, 255));
  if (!r.ok && r.blocked) {
    ctx.app.audit.write('authorization_failure', { user: ctx.user.name, ip: ctx.ip, db: DB, unid: doc.unid, action: 'cancel', reason: 'released_or_cancelled' });
    return blockedPage(ctx, doc, r.errors, 'Request cannot be cancelled');
  }
  if (!r.ok) {
    ctx.res.statusCode = 400;
    return documentPage(ctx, doc, { errors: r.errors });
  }
  ctx.app.audit.write('request_cancel', { user: ctx.user.name, ip: ctx.ip, db: DB, unid: doc.unid, documentNumber: A.text(doc, 'DocumentNumber'), reason: A.text(doc, 'CancelReason') });
  return ctx.redirect(`/heraldry.nsf/0/${doc.unid}?OpenDocument&Cancelled=1`, 303);
});

/* ---------------------------------------------------------------- 0/<unid>?OpenDocument */

function requestActions(ctx, doc) {
  const db = ctx.app.store.db(DB);
  const released = A.isReleased(db, doc);
  const cancelled = A.text(doc, 'Status') === A.STATUS.CANCELLED;
  const out = [];
  if (!released && !cancelled) {
    out.push(H.linkButton(`/heraldry.nsf/ModifyRequest.xsp?documentId=${doc.unid}`, 'Modify Request'));
  }
  if (hasRole(ctx.user, '[TACOM]', '[Admin]') && !released && !cancelled) {
    const vendors = db.all('Vendor').filter((v) => A.text(v, 'Active') === 'Yes').map((v) => [A.text(v, 'VendorKey'), `${A.text(v, 'VendorKey')} - ${A.text(v, 'VendorName')} (${A.text(v, 'LeadTimeDays')} days)`]);
    out.push(`<form method="post" action="/heraldry.nsf/0/${H.attr(doc.unid)}?ReleaseToVendor" class="inlineForm">${H.select('VendorKey', vendors, A.text(doc, 'VendorKey'), { blank: '(select vendor)' })} ${H.button('Release to Vendor')}</form>`);
  }
  if (!released && !cancelled) {
    out.push(`<form method="post" action="/heraldry.nsf/0/${H.attr(doc.unid)}?CancelRequest" class="inlineForm">${H.input('CancelReason', '', { size: 28, maxlength: 255, extra: ' placeholder="Cancellation reason"' })} ${H.button('Cancel Request', { className: 'xspButtonCommand dangerButton' })}</form>`);
  }
  if (released && !cancelled) {
    out.push(`<span class="lockedNote">&#128274; Released to vendor ${H.esc(A.text(doc, 'VendorKey'))} on ${H.esc(H.fmtValue(doc.items.ReleasedDate))} - locked against modification (Error 4091)</span> ${H.linkButton(`/heraldry.nsf/ModifyRequest.xsp?documentId=${doc.unid}`, 'Attempt Modify')}`);
  }
  out.push(H.linkButton(`/heraldry.nsf/StatusInquiry.xsp?DocumentNumber=${encodeURIComponent(A.text(doc, 'DocumentNumber'))}&DODAAC=${encodeURIComponent(A.text(doc, 'DODAAC'))}`, 'Status Inquiry'));
  return `<div class="docActions">${out.join(' ')}</div>`;
}

function documentPage(ctx, doc, opts = {}) {
  const db = ctx.app.store.db(DB);
  const design = ctx.app.designs[DB];
  const out = [];
  if (opts.errors) {
    out.push(H.errorBlock(opts.errors, 'Action failed'));
  }
  if (ctx.query.Saved) {
    out.push(H.infoBlock(`Document saved. ${doc.form === 'Request' ? `Document number ${A.text(doc, 'DocumentNumber')} has been assigned; a status e-mail has been queued (SendStatusMail).` : ''}`));
  }
  if (ctx.query.Released) {
    out.push(H.infoBlock(`Request released to vendor ${A.text(doc, 'VendorName') || A.text(doc, 'VendorKey')}. Estimated ship date ${H.fmtValue(doc.items.EstimatedShipDate)}. The request is now locked.`));
  }
  if (ctx.query.Cancelled) {
    out.push(H.infoBlock('Request cancelled. Line items were set to Cancelled and the requester was notified.'));
  }
  const title = doc.form === 'Request' ? `Request ${A.text(doc, 'DocumentNumber')}` : doc.form === 'RequestLine' ? `Line ${A.text(doc, 'LineDocNumber')}` : doc.form === 'SESFlagRequest' ? `SES Flag Request ${A.text(doc, 'SESFlagNumber')}` : `${doc.form}: ${A.text(doc, 'ItemName') || A.text(doc, 'VendorName') || A.text(doc, 'Name') || doc.unid}`;
  if (doc.form === 'Request') {
    out.push(`<div class="docHeader">${statusChip(A.text(doc, 'Status'))} &nbsp; <b>${H.esc(A.text(doc, 'RequestType'))}</b> for ${H.esc(A.text(doc, 'UnitName'))} (${H.esc(A.text(doc, 'DODAAC'))} / ${H.esc(A.text(doc, 'UIC'))}) &nbsp; <span class="muted">Priority ${H.esc(A.text(doc, 'Priority'))} &middot; RPD ${H.esc(A.text(doc, 'RPD'))}</span></div>`);
    out.push(requestActions(ctx, doc));
  }
  out.push(D.itemsTable(design, doc));
  if (doc.form === 'Request') {
    const lines = db.responses(doc.unid, 'RequestLine');
    out.push(`<h3>Line items (${lines.length})${Number(doc.items.LineCount) !== lines.length ? ` <span class="warn">LineCount item says ${H.esc(String(doc.items.LineCount))}</span>` : ''}</h3>`);
    out.push(D.responsesTable(DB, lines, [
      { title: 'Line', item: 'LineDocNumber' }, { title: 'NSN / Item', render: (l) => H.esc(A.text(l, 'NSN') || A.text(l, 'ItemKey')) }, { title: 'Description', item: 'ItemDescription' }, { title: 'Exception Data', item: 'ExceptionData' }, { title: 'U/I', item: 'UnitOfIssue' }, { title: 'Qty', item: 'Quantity' }, { title: 'Unit Price', render: (l) => H.esc(H.money(l.items.UnitPrice)) }, { title: 'Extended', render: (l) => H.esc(H.money(l.items.ExtendedPrice)) }, { title: 'Line Status', item: 'LineStatus' },
    ]) || '<p class="muted">No RequestLine responses (orphaned or never entered).</p>');
    if (A.text(doc, 'VendorKey')) {
      const v = db.findOne('Vendor', 'VendorKey', A.text(doc, 'VendorKey'));
      out.push(`<h3>Vendor</h3><p>${v ? `<a href="/heraldry.nsf/0/${H.attr(v.unid)}?OpenDocument">${H.esc(A.text(v, 'VendorName'))}</a> (${H.esc(A.text(v, 'VendorKey'))}, ${H.esc(A.text(v, 'City'))}, ${H.esc(A.text(v, 'State'))})` : `<span class="warn">Vendor ${H.esc(A.text(doc, 'VendorKey'))} is referenced but no Vendor document exists (deleted-but-referenced vendor).</span>`} &nbsp; <a href="/heraldry.nsf/VendorQueue.xsp?vendor=${H.attr(encodeURIComponent(A.text(doc, 'VendorKey')))}">vendor queue</a></p>`);
    }
  }
  if (doc.form === 'Vendor') {
    const key = A.text(doc, 'VendorKey');
    const open = db.all('Request').filter((d) => A.text(d, 'VendorKey') === key && [A.STATUS.RELEASED, A.STATUS.PRODUCTION].includes(A.text(d, 'Status')));
    out.push(`<p><a href="/heraldry.nsf/VendorQueue.xsp?vendor=${H.attr(encodeURIComponent(key))}">${open.length} open request(s) in the vendor queue</a></p>`);
  }
  if (doc.form === 'HeraldicItem') {
    const used = db.all('RequestLine').filter((l) => A.text(l, 'ItemKey') === A.text(doc, 'StockNumber')).length;
    out.push(`<p class="muted">Referenced by ${used} request line(s).</p>`);
  }
  out.push(D.systemTable(doc, DB));
  return page(ctx, { title, content: out.join('\n'), breadcrumb: [{ label: 'Heraldry', href: '/heraldry.nsf/HeraldryHome.xsp' }, { label: doc.form, href: doc.form === 'Request' ? '/heraldry.nsf/RequestsByStatus?OpenView' : '/heraldry.nsf/($All)?OpenView' }, { label: title }] });
}

router.get((ctx) => {
  const p = splitDbPath(ctx.pathname);
  return p && p.db === DB && p.parts.length === 2 && p.parts[0] === '0' && dominoCommand(ctx.query) === 'opendocument';
}, (ctx) => {
  const doc = docFromPath(ctx);
  if (!doc) {
    throw new A.AppError('Document not found', 404);
  }
  if (doc.readers.length && !ctx.user.anonymous && !readerAllowed(ctx.user, doc)) {
    ctx.app.audit.write('authorization_failure', { user: ctx.user.name, ip: ctx.ip, db: DB, unid: doc.unid, reason: 'readers_field' });
  }
  ctx.app.audit.write('document_read', { user: ctx.user.name, ip: ctx.ip, db: DB, unid: doc.unid, form: doc.form });
  return documentPage(ctx, doc);
});

function readerAllowed(user, doc) {
  const names = new Set(doc.readers.map((x) => String(x).toUpperCase()));
  if (!names.size) {
    return true;
  }
  return [user.name, ...(user.roles || []), ...(user.groups || [])].some((n) => names.has(String(n).toUpperCase()));
}

/* ---------------------------------------------------------------- <view>?OpenView */

router.get((ctx) => {
  const p = splitDbPath(ctx.pathname);
  return p && p.db === DB && p.parts.length === 1 && dominoCommand(ctx.query) === 'openview';
}, (ctx) => openView(ctx, DB));

function openView(ctx, dbName) {
  const p = splitDbPath(ctx.pathname);
  const name = cleanName(p.parts[0]);
  const design = ctx.app.designs[dbName];
  const view = design.views.find((v) => v.name === name || (v.aliases || []).includes(name));
  if (!view) {
    throw new A.AppError('View not found', 404);
  }
  const engine = ctx.app.engines[dbName];
  const start = cleanInt(ctx.query.Start, 1, 1000000, 1);
  const count = cleanInt(ctx.query.Count, 5, 500, 30);
  const restrict = ctx.query.RestrictToCategory ? cleanText(ctx.query.RestrictToCategory, 100) : '';
  const collapse = ctx.query.CollapseView === '' || ctx.query.CollapseView === '1';
  const expand = ctx.query.ExpandView === '';
  const collapsed = collapse && !expand;
  const base = `/${dbName}/${encodeURIComponent(view.name)}?OpenView${restrict ? `&RestrictToCategory=${encodeURIComponent(restrict)}` : ''}`;
  const toolbar = `<span class="viewTools"><a class="viewNavBtn" href="${H.attr(`${base}&ExpandView`)}">Expand All</a> <a class="viewNavBtn" href="${H.attr(`${base}&CollapseView`)}">Collapse All</a>${restrict ? ` <a class="viewNavBtn" href="${H.attr(`/${dbName}/${encodeURIComponent(view.name)}?OpenView`)}">Clear category "${H.esc(restrict)}"</a>` : ''}</span>`;
  const table = engine.render(view, { start, count, restrictToCategory: restrict, collapsed, toolbar });
  const actions = (view.actions || []).filter((a) => !a.hideWhen || !/\[Admin\]|\[TACOM\]/.test(a.hideWhen) || hasRole(ctx.user, '[TACOM]', '[Admin]')).map((a) => `<span class="viewAction" title="${H.attr(a.click || '')}">${H.esc(a.title)}</span>`).join('');
  const content = `
<div class="viewHeader"><span class="muted">Selection: <code>${H.esc(view.selection)}</code>${view.aliases && view.aliases.length ? ` &middot; alias ${H.esc(view.aliases.join(', '))}` : ''}${view.showResponseHierarchy ? ' &middot; response hierarchy' : ''} &middot; Start=${start}&amp;Count=${count}</span>${actions ? `<div class="viewActions">${actions}</div>` : ''}</div>
${table}`;
  return render(ctx, { db: dbName, title: `${view.name}${restrict ? ` - ${restrict}` : ''}`, content, breadcrumb: [{ label: dbName === DB ? 'Heraldry' : 'Veteran Medals', href: dbName === DB ? '/heraldry.nsf/HeraldryHome.xsp' : '/vetmedals.nsf/CasesByStage?OpenView' }, { label: `${view.name}?OpenView` }] });
}

/* ---------------------------------------------------------------- StatusInquiry.xsp */

router.get((ctx) => ctx.pathname === '/heraldry.nsf/StatusInquiry.xsp', (ctx) => statusInquiryPage(ctx, ctx.query));
router.post((ctx) => ctx.pathname === '/heraldry.nsf/StatusInquiry.xsp', (ctx) => statusInquiryPage(ctx, ctx.body));

function statusInquiryPage(ctx, params) {
  const db = ctx.app.store.db(DB);
  const num = cleanCode(params.DocumentNumber, 20);
  const dodaac = cleanCode(params.DODAAC, 6);
  let resultHtml = '';
  if (num) {
    const r = A.statusInquiry(db, num, dodaac);
    ctx.app.audit.write('status_inquiry', { user: ctx.user.name, ip: ctx.ip, db: DB, documentNumber: num, dodaac, found: r.ok ? r.hits.length : 0 });
    if (!r.ok) {
      resultHtml = H.errorBlock(r.errors, 'Status Inquiry');
    } else {
      resultHtml = r.hits.map((d, i) => {
        const lines = db.responses(d.unid, 'RequestLine');
        const hist = [].concat(d.items.StatusHistory || []);
        return `<div class="inquiryResult">
<h3>${H.esc(A.text(d, 'DocumentNumber') || A.text(d, 'SESFlagNumber'))} &nbsp; ${statusChip(A.text(d, 'Status'))}</h3>
${H.fieldTable([
    { cells: [{ label: 'Unit', value: A.text(d, 'UnitName') || A.text(d, 'Organization') }, { label: 'DODAAC / UIC', value: `${A.text(d, 'DODAAC')} / ${A.text(d, 'UIC')}` }] },
    { cells: [{ label: 'Type', value: A.text(d, 'RequestType') || A.text(d, 'FlagType') }, { label: 'Entered', value: H.fmtValue(d.items.EnteredDate) }] },
    { cells: [{ label: 'Vendor', value: A.text(d, 'VendorName') || A.text(d, 'VendorKey') || '(not yet released)' }, { label: 'Released', value: H.fmtValue(d.items.ReleasedDate) || '-' }] },
    { cells: [{ label: 'Estimated Ship', value: H.fmtValue(d.items.EstimatedShipDate) || '-' }, { label: 'Lines / Value', value: `${lines.length} / ${H.money(d.items.TotalValue)}` }] },
    { label: 'Status history', value: hist.map((h) => H.esc(h)).join('<br>') || '(none)', raw: true, colspan: 3 },
  ])}
<p>${H.linkButton(`/heraldry.nsf/0/${d.unid}?OpenDocument`, 'Open')} ${r.canModify[i] ? H.linkButton(`/heraldry.nsf/ModifyRequest.xsp?documentId=${d.unid}`, 'Modify / Cancel') : `<span class="lockedNote">Modification closed: ${H.esc(A.text(d, 'Status'))}</span>`}</p>
</div>`;
      }).join('\n');
    }
  }
  const content = `
<p>Enter the 14-character document number from block 1-2 of the DD Form 1348-6 (DODAAC + Julian date + serial) or an SES flag number. Adding the DODAAC narrows the lookup. Lookups run against the <code>StatusInquiry</code> view (rebuilt nightly by <code>RebuildStatusInquiryIndex</code>).</p>
<form method="post" action="/heraldry.nsf/StatusInquiry.xsp" class="dominoForm">
${H.fieldTable([{ cells: [{ label: 'Document Number', value: H.input('DocumentNumber', num, { size: 18, maxlength: 20 }), raw: true, required: true }, { label: 'DODAAC (optional)', value: H.input('DODAAC', dodaac, { size: 8, maxlength: 6 }), raw: true }] }])}
<div class="formButtons">${H.button('Inquire')} ${H.button('Clear', { type: 'reset' })}</div>
</form>
${resultHtml}
<h3>Sample document numbers</h3>
<p class="muted">${db.all('Request').slice(0, 8).map((d) => `<a href="/heraldry.nsf/StatusInquiry.xsp?DocumentNumber=${H.attr(encodeURIComponent(A.text(d, 'DocumentNumber')))}">${H.esc(A.text(d, 'DocumentNumber'))}</a>`).join(' &middot; ')}</p>`;
  return page(ctx, { title: 'Status Inquiry', content, breadcrumb: [{ label: 'Heraldry', href: '/heraldry.nsf/HeraldryHome.xsp' }, { label: 'StatusInquiry.xsp' }] });
}

/* ---------------------------------------------------------------- VendorQueue.xsp */

router.get((ctx) => ctx.pathname === '/heraldry.nsf/VendorQueue.xsp', (ctx) => {
  const db = ctx.app.store.db(DB);
  const vendors = db.all('Vendor').slice().sort((a, b) => A.text(a, 'VendorName').localeCompare(A.text(b, 'VendorName')));
  let key = cleanCode(ctx.query.vendor, 10);
  if (ctx.user.vendorKey) {
    key = ctx.user.vendorKey; // vendors only ever see their own queue
  }
  const referencedKeys = [...new Set(db.all('Request').map((d) => A.text(d, 'VendorKey')).filter(Boolean))];
  const missing = referencedKeys.filter((k) => !db.findOne('Vendor', 'VendorKey', k));
  const chooser = ctx.user.vendorKey ? '' : `<form method="get" action="/heraldry.nsf/VendorQueue.xsp" class="inlineForm dominoForm"><label>Vendor ${H.select('vendor', vendors.map((v) => [A.text(v, 'VendorKey'), `${A.text(v, 'VendorKey')} - ${A.text(v, 'VendorName')}${A.text(v, 'Active') === 'Yes' ? '' : ' (inactive)'}`]).concat(missing.map((k) => [k, `${k} - (vendor document deleted)`])), key, { blank: '(all vendors)' })}</label> ${H.button('Show Queue')}</form>`;
  const vendor = key ? db.findOne('Vendor', 'VendorKey', key) : null;
  const open = db.all('Request').filter((d) => (!key || A.text(d, 'VendorKey') === key) && [A.STATUS.RELEASED, A.STATUS.PRODUCTION, A.STATUS.SHIPPED].includes(A.text(d, 'Status')))
    .sort((a, b) => String(a.items.ReleasedDate).localeCompare(String(b.items.ReleasedDate)));
  const canWork = hasRole(ctx.user, '[Vendor]', '[TACOM]', '[Admin]');
  const rows = open.slice(0, 200).map((d) => {
    const st = A.text(d, 'Status');
    let act = '';
    if (canWork && st === A.STATUS.RELEASED) {
      act = `<form method="post" action="/heraldry.nsf/VendorQueue.xsp?vendor=${H.attr(encodeURIComponent(key))}" class="inlineForm"><input type="hidden" name="unid" value="${H.attr(d.unid)}"><input type="hidden" name="action" value="acknowledge">${H.button('Acknowledge (In Production)')}</form>`;
    } else if (canWork && st === A.STATUS.PRODUCTION) {
      act = `<form method="post" action="/heraldry.nsf/VendorQueue.xsp?vendor=${H.attr(encodeURIComponent(key))}" class="inlineForm"><input type="hidden" name="unid" value="${H.attr(d.unid)}"><input type="hidden" name="action" value="ship">${H.input('Tracking', '', { size: 16, maxlength: 30, extra: ' placeholder="Tracking #"' })} ${H.button('Ship')}</form>`;
    }
    return `<tr><td>${docLink(d)}</td><td>${H.esc(A.text(d, 'VendorKey'))}</td><td>${H.esc(A.text(d, 'UnitName'))}</td><td>${H.esc(A.text(d, 'RequestType'))}</td><td align="right">${H.esc(String(d.items.LineCount || ''))}</td><td align="right">${H.esc(H.money(d.items.TotalValue))}</td><td>${H.esc(H.fmtValue(d.items.ReleasedDate))}</td><td>${H.esc(H.fmtValue(d.items.EstimatedShipDate))}</td><td>${statusChip(st)}</td><td>${act}</td></tr>`;
  }).join('');
  const content = `
${ctx.query.Done ? H.infoBlock(`Request ${cleanCode(ctx.query.Done, 14)} updated.`) : ''}
<p>Work released to heraldry vendors. Vendors see only their own queue (Readers field <code>DocReaders</code> includes <code>Vendor-&lt;key&gt;</code>); TACOM staff can view any vendor.</p>
${chooser}
${key ? `<div class="docHeader">${vendor ? `<b>${H.esc(A.text(vendor, 'VendorName'))}</b> (${H.esc(key)}) &middot; ${H.esc(A.text(vendor, 'City'))}, ${H.esc(A.text(vendor, 'State'))} &middot; contract ${H.esc(A.text(vendor, 'ContractNumber'))} &middot; lead time ${H.esc(A.text(vendor, 'LeadTimeDays'))} days &middot; POC ${H.esc(A.text(vendor, 'POC'))}` : `<span class="warn">Vendor key ${H.esc(key)} has ${open.length} open request(s) but the Vendor document no longer exists.</span>`}</div>` : ''}
<table class="dominoView" border="1" cellpadding="3" cellspacing="0" width="100%"><tr><th>Document Number</th><th>Vendor</th><th>Unit</th><th>Type</th><th>Lines</th><th>Value</th><th>Released</th><th>Est. Ship</th><th>Status</th><th>Action</th></tr>${rows || '<tr><td colspan="10" class="muted">No released work for this vendor.</td></tr>'}</table>
<p class="muted">${open.length} request(s)${open.length > 200 ? ' (first 200 shown)' : ''}.</p>`;
  return page(ctx, { title: `Vendor Work Queue${vendor ? ` - ${A.text(vendor, 'VendorName')}` : ''}`, content, breadcrumb: [{ label: 'Heraldry', href: '/heraldry.nsf/HeraldryHome.xsp' }, { label: 'VendorQueue.xsp' }] });
});

router.post((ctx) => ctx.pathname === '/heraldry.nsf/VendorQueue.xsp', (ctx) => {
  requireRole(ctx, '[Vendor]', '[TACOM]', '[Admin]');
  const db = ctx.app.store.db(DB);
  const doc = db.get(cleanUnid(ctx.body.unid));
  if (!doc || doc.form !== 'Request') {
    throw new A.AppError('Request not found', 404);
  }
  if (ctx.user.vendorKey && A.text(doc, 'VendorKey') !== ctx.user.vendorKey) {
    throw new A.AppError('This request belongs to another vendor', 403);
  }
  const action = cleanText(ctx.body.action, 20);
  const from = A.text(doc, 'Status');
  const clock = () => ctx.now;
  if (action === 'acknowledge' && from === A.STATUS.RELEASED) {
    db.update(doc, { Status: A.STATUS.PRODUCTION, LastModifiedBy: ctx.user.name, LastModifiedDate: ctx.now.toISOString(), StatusHistory: [].concat(doc.items.StatusHistory || []).concat(`${H.fmtDate(ctx.now.toISOString())} | ${from} -> ${A.STATUS.PRODUCTION} | ${A.commonName(ctx.user.name)}`) }, { user: ctx.user.name, clock });
    for (const l of db.responses(doc.unid, 'RequestLine')) {
      db.update(l, { LineStatus: 'In Production' }, { user: ctx.user.name, clock });
    }
  } else if (action === 'ship' && from === A.STATUS.PRODUCTION) {
    const tracking = cleanCode(ctx.body.Tracking, 30);
    db.update(doc, { Status: A.STATUS.SHIPPED, VendorTracking: tracking, LastModifiedBy: ctx.user.name, LastModifiedDate: ctx.now.toISOString(), StatusHistory: [].concat(doc.items.StatusHistory || []).concat(`${H.fmtDate(ctx.now.toISOString())} | ${from} -> ${A.STATUS.SHIPPED} | ${A.commonName(ctx.user.name)}`) }, { user: ctx.user.name, clock });
    for (const l of db.responses(doc.unid, 'RequestLine')) {
      db.update(l, { LineStatus: 'Shipped', VendorShipDate: ctx.now.toISOString().slice(0, 10) }, { user: ctx.user.name, clock });
    }
  } else {
    throw new A.AppError('That action is not valid for the request status', 400);
  }
  ctx.app.audit.write('request_status_change', { user: ctx.user.name, ip: ctx.ip, db: DB, unid: doc.unid, documentNumber: A.text(doc, 'DocumentNumber'), from, to: A.text(doc, 'Status') });
  return ctx.redirect(`/heraldry.nsf/VendorQueue.xsp?vendor=${encodeURIComponent(A.text(doc, 'VendorKey'))}&Done=${encodeURIComponent(A.text(doc, 'DocumentNumber'))}`, 303);
});

/* ---------------------------------------------------------------- SESFlag.xsp */

const SES_FIELDS = ['ExecutiveName', 'ExecutiveTitle', 'ExecutiveTier', 'Organization', 'FlagType', 'Quantity', 'DODAAC', 'UIC', 'ShipToAddress', 'Justification'];

function sesPage(ctx, values, errors, message) {
  const db = ctx.app.store.db(DB);
  const design = ctx.app.designs[DB];
  const form = D.findForm(design, 'SESFlagRequest');
  const byName = Object.fromEntries(form.fields.map((f) => [f.name, f]));
  const canApprove = hasRole(ctx.user, '[SESApprover]', '[Admin]');
  const queue = db.all('SESFlagRequest').slice().sort((a, b) => String(b.items.EnteredDate).localeCompare(String(a.items.EnteredDate)));
  const rows = queue.slice(0, 60).map((d) => {
    const st = A.text(d, 'Status');
    let act = '';
    if (canApprove && ['Submitted', 'Draft'].includes(st)) {
      act = `<form method="post" action="/heraldry.nsf/SESFlag.xsp?action=approve" class="inlineForm"><input type="hidden" name="unid" value="${H.attr(d.unid)}">${H.button('Approve')}</form> <form method="post" action="/heraldry.nsf/SESFlag.xsp?action=return" class="inlineForm"><input type="hidden" name="unid" value="${H.attr(d.unid)}">${H.input('ReturnReason', '', { size: 14, maxlength: 255, extra: ' placeholder="Return reason"' })}${H.button('Return')}</form>`;
    }
    return `<tr><td>${docLink(d, A.text(d, 'SESFlagNumber'))}</td><td>${H.esc(A.text(d, 'ExecutiveName'))}<br><span class="muted">${H.esc(A.text(d, 'ExecutiveTitle'))}</span></td><td>${H.esc(A.text(d, 'ExecutiveTier'))}</td><td>${H.esc(A.text(d, 'Organization'))}</td><td>${H.esc(A.text(d, 'FlagType'))}</td><td align="right">${H.esc(String(d.items.Quantity))}</td><td>${H.esc(H.fmtValue(d.items.EnteredDate))}</td><td>${statusChip(st)}${A.text(d, 'ReturnReason') ? `<br><span class="warn">${H.esc(A.text(d, 'ReturnReason'))}</span>` : ''}</td><td>${act}</td></tr>`;
  }).join('');
  const cell = (name, opts = {}) => ({ label: D.humanize(name), value: fieldInput(byName[name], values[name], opts), raw: true, required: Boolean(byName[name].inputValidation) });
  const content = `
${message ? H.infoBlock(message) : ''}
${H.errorBlock(errors, 'The SES flag request could not be saved:')}
<p>Senior Executive Service positional colors, automobile flags and desk sets are requested here rather than on a DD 1348-6. Requests require approval by the Heraldry program lead (<code>[SESApprover]</code>) before release to the flag vendor; approved requests appear in the SES Flag Queue view.</p>
${ctx.user.anonymous ? '<p><a href="/names.nsf?Login&RedirectTo=%2Fheraldry.nsf%2FSESFlag.xsp">Log in</a> to submit an SES flag request.</p>' : `
<form method="post" action="/heraldry.nsf/SESFlag.xsp?action=create" class="dominoForm" autocomplete="off">
${H.fieldTable([
    { section: 'Executive' },
    { cells: [cell('ExecutiveName'), cell('ExecutiveTitle')] },
    { cells: [cell('ExecutiveTier'), cell('Organization')] },
    { section: 'Flag' },
    { cells: [cell('FlagType'), cell('Quantity')] },
    { section: 'Requesting activity and shipping' },
    { cells: [cell('DODAAC'), cell('UIC')] },
    { ...cell('ShipToAddress', { size: 70 }), colspan: 3 },
    { ...cell('Justification', { size: 70 }), colspan: 3 },
  ])}
<div class="formButtons">${H.button('Submit SES Flag Request')}</div>
</form>`}
<h3>SES flag requests (${queue.length})</h3>
<table class="dominoView" border="1" cellpadding="3" cellspacing="0" width="100%"><tr><th>SES Flag #</th><th>Executive</th><th>Tier</th><th>Organization</th><th>Flag Type</th><th>Qty</th><th>Entered</th><th>Status</th><th>Action</th></tr>${rows}</table>`;
  return page(ctx, { title: 'SES Flag Requests', content, breadcrumb: [{ label: 'Heraldry', href: '/heraldry.nsf/HeraldryHome.xsp' }, { label: 'SESFlag.xsp' }] });
}

router.get((ctx) => ctx.pathname === '/heraldry.nsf/SESFlag.xsp', (ctx) => sesPage(ctx, { Quantity: 1, FlagType: 'SES Positional Color (Indoor)', DODAAC: ctx.user.dodaac || '', UIC: ctx.user.uic || '' }, [], ctx.query.Saved ? `SES flag request ${cleanCode(ctx.query.Saved, 20)} submitted for approval.` : ctx.query.Done ? 'SES flag request updated.' : ''));

router.post((ctx) => ctx.pathname === '/heraldry.nsf/SESFlag.xsp', (ctx) => {
  requireLogin(ctx);
  const db = ctx.app.store.db(DB);
  const design = ctx.app.designs[DB];
  const engine = ctx.app.engines[DB];
  const action = cleanText(ctx.query.action, 10);
  const clock = () => ctx.now;
  if (action === 'create') {
    const values = {};
    for (const k of SES_FIELDS) {
      values[k] = cleanText(ctx.body[k], k === 'Justification' || k === 'ShipToAddress' ? 500 : 255);
    }
    values.DODAAC = cleanCode(values.DODAAC, 6);
    values.UIC = cleanCode(values.UIC, 6);
    const form = D.findForm(design, 'SESFlagRequest');
    const draft = { unid: '', items: { Form: 'SESFlagRequest', ...values, Status: 'Submitted' } };
    const r = A.computeWithForm(engine, form, draft, { isNew: true, userName: ctx.user.name, roles: ctx.user.roles, skipComputed: ['SESFlagNumber', 'StatusInquiryKey'] });
    if (!r.ok) {
      ctx.app.audit.write('validation_failure', { user: ctx.user.name, ip: ctx.ip, db: DB, form: 'SESFlagRequest', errors: r.errors.slice(0, 10) });
      ctx.res.statusCode = 400;
      return sesPage(ctx, values, r.errors, '');
    }
    const serial = db.nextSerial('NextSESSerial', { user: ctx.user.name, clock });
    const num = `SES-${ctx.now.getFullYear()}-${String(serial).padStart(4, '0')}`;
    const doc = db.create('SESFlagRequest', {
      ...draft.items,
      SESFlagNumber: num,
      EnteredDate: ctx.now.toISOString(),
      EnteredBy: ctx.user.name,
      ApprovalDate: '',
      ApprovedBy: '',
      ReturnReason: '',
      VendorKey: '',
      ReleasedDate: '',
      StatusInquiryKey: `${num}|${values.DODAAC}|${values.UIC}`,
    }, { user: ctx.user.name, clock });
    ctx.app.audit.write('document_create', { user: ctx.user.name, ip: ctx.ip, db: DB, form: 'SESFlagRequest', unid: doc.unid, sesFlagNumber: num });
    return ctx.redirect(`/heraldry.nsf/SESFlag.xsp?Saved=${encodeURIComponent(num)}`, 303);
  }
  requireRole(ctx, '[SESApprover]', '[Admin]');
  const doc = db.get(cleanUnid(ctx.body.unid));
  if (!doc || doc.form !== 'SESFlagRequest') {
    throw new A.AppError('SES flag request not found', 404);
  }
  const from = A.text(doc, 'Status');
  if (action === 'approve') {
    db.update(doc, { Status: 'Approved', ApprovalDate: ctx.now.toISOString(), ApprovedBy: ctx.user.name, ReturnReason: '' }, { user: ctx.user.name, clock });
  } else if (action === 'return') {
    db.update(doc, { Status: 'Returned', ReturnReason: cleanText(ctx.body.ReturnReason, 255) || 'Returned without comment' }, { user: ctx.user.name, clock });
  } else {
    throw new A.AppError('Unknown action', 400);
  }
  ctx.app.audit.write('request_status_change', { user: ctx.user.name, ip: ctx.ip, db: DB, unid: doc.unid, sesFlagNumber: A.text(doc, 'SESFlagNumber'), from, to: A.text(doc, 'Status') });
  return ctx.redirect('/heraldry.nsf/SESFlag.xsp?Done=1', 303);
});

module.exports = { dispatch: (ctx) => router.dispatch(ctx), openView, statusChip, fieldInput };
