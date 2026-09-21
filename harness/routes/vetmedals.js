'use strict';

/**
 * vetmedals.nsf routes: CasesByStage / WarehousePick / any <view>?OpenView, CaseView.xsp,
 * EngravingQueue.xsp, CSRLookup.xsp, 0/<unid>?OpenDocument and the stage-advance / hold /
 * case-note actions used by CSR, engraving, assembly and warehouse staff.
 */

const H = require('../lib/html');
const A = require('../lib/agents');
const { hasRole } = require('../lib/personas');
const { render } = require('./common');
const D = require('./docview');
const { openView } = require('./heraldry');
const {
  Router, dominoCommand, splitDbPath, requireLogin, requireRole, cleanUnid, cleanText, cleanCode, cleanInt,
} = require('./router');

const DB = 'vetmedals.nsf';
const router = new Router();

function actx(ctx) {
  return { design: ctx.app.designs[DB], db: ctx.app.store.db(DB), engine: ctx.app.engines[DB], user: ctx.user, now: ctx.now, log: (a, m) => ctx.app.log('info', a, { message: m }) };
}

function page(ctx, opts) {
  return render(ctx, { db: DB, ...opts });
}

function caseLink(doc, label) {
  return `<a href="/vetmedals.nsf/CaseView.xsp?documentId=${H.attr(doc.unid)}">${H.esc(label || A.text(doc, 'CaseNumber'))}</a>`;
}

function stageChip(stage) {
  const s = String(stage || '').trim();
  const cls = {
    Authorized: 'stAuthorized', Engraving: 'stEngraving', 'Assembly/QC': 'stAssembly', Warehouse: 'stWarehouse', Shipped: 'stShipped', Closed: 'stClosed', Cancelled: 'stCancelled', 'On Hold': 'stHold',
  }[s] || (s.toLowerCase() === 'closed' || s === 'Complete' ? 'stClosedWart' : 'stOther');
  return `<span class="statusChip ${cls}" title="${H.attr(stage)}">${H.esc(stage === '' ? '(blank)' : stage)}</span>`;
}

function agingChip(flag) {
  if (!flag) {
    return '';
  }
  return `<span class="agingFlag aging${H.attr(flag)}">${H.esc(flag)}</span>`;
}

function stageTracker(doc) {
  const cur = A.text(doc, 'Stage').trim();
  const idx = A.STAGE_ORDER.indexOf(cur);
  return `<div class="stageTracker">${A.STAGE_ORDER.map((s, i) => `<span class="stageStep${i < idx ? ' done' : i === idx ? ' current' : ''}">${H.esc(s)}</span>`).join('<span class="stageArrow">&rarr;</span>')}${idx === -1 ? ` <span class="warn">(current stage "${H.esc(cur)}" is not in the canonical list)</span>` : ''}</div>`;
}

/* ---------------------------------------------------------------- CaseView.xsp */

function casePage(ctx, doc, opts = {}) {
  const db = ctx.app.store.db(DB);
  const design = ctx.app.designs[DB];
  const caseNo = A.text(doc, 'CaseNumber');
  const lines = db.findAll('AwardLine', 'ParentCaseNumber', caseNo);
  const notes = db.findAll('CaseNote', 'ParentCaseNumber', caseNo).sort((a, b) => String(b.items.NoteDate).localeCompare(String(a.items.NoteDate)));
  const job = A.text(doc, 'EngravingJobNumber') ? db.findOne('EngravingJob', 'JobNumber', A.text(doc, 'EngravingJobNumber')) : null;
  const shipments = db.findAll('ShipmentRecord', 'CaseNumber', caseNo);
  const requester = A.text(doc, 'RequesterKey') ? db.findOne('Requester', 'RequesterKey', A.text(doc, 'RequesterKey')) : null;
  const authFile = A.text(doc, 'AuthFileName') ? db.findOne('AuthorizationFile', 'FileName', A.text(doc, 'AuthFileName')) : null;
  const cur = A.text(doc, 'Stage').trim();
  const nxt = A.nextStage(cur, A.text(doc, 'EngravingRequired') === 'Yes' || lines.some((l) => A.text(l, 'Engrave') === 'Yes'));
  const mayAdvance = !ctx.user.anonymous && nxt && A.roleMayAdvance(ctx.user.roles, cur);
  const isCsr = hasRole(ctx.user, '[CSR]', '[TACOM]', '[Admin]');
  const out = [];
  if (opts.errors) {
    out.push(H.errorBlock(opts.errors, 'Action failed'));
  }
  if (ctx.query.Advanced) {
    out.push(H.infoBlock(`Case advanced to ${cleanText(ctx.query.Advanced, 20)}. Stage date reset; status history updated; SendStatusMail queued a notice to the requester.`));
  }
  if (ctx.query.NoteSaved) {
    out.push(H.infoBlock('Case note saved.'));
  }
  if (ctx.query.Hold) {
    out.push(H.infoBlock(cleanText(ctx.query.Hold, 10) === 'on' ? 'Case placed on hold.' : 'Hold released; case returned to its prior stage.'));
  }
  out.push(`<div class="docHeader">${stageChip(A.text(doc, 'Stage'))} ${agingChip(A.text(doc, 'AgingFlag'))} &nbsp; <b>${H.esc(A.text(doc, 'VeteranRank'))} ${H.esc(A.text(doc, 'VeteranFirstName'))} ${H.esc(A.text(doc, 'VeteranMI'))} ${H.esc(A.text(doc, 'VeteranLastName'))}</b> &nbsp; <span class="muted">${H.esc(A.text(doc, 'Era'))} &middot; ${H.esc(A.text(doc, 'Branch'))} &middot; Source ${H.esc(A.text(doc, 'Source'))} &middot; Priority ${H.esc(A.text(doc, 'Priority'))} &middot; ${H.esc(String(doc.items.DaysOpen || 0))} days open</span></div>`);
  out.push(stageTracker(doc));
  const actions = [];
  if (mayAdvance) {
    actions.push(`<form method="post" action="/vetmedals.nsf/CaseView.xsp?documentId=${H.attr(doc.unid)}&amp;action=advance" class="inlineForm">${H.button(`Advance to ${nxt}`, { className: 'xspButtonCommand primaryButton' })}</form>`);
  } else if (!ctx.user.anonymous && nxt) {
    actions.push(`<span class="muted">Your role (${H.esc(ctx.user.roles.join(' ') || 'none')}) cannot advance a case from ${H.esc(cur)}.</span>`);
  }
  if (isCsr && cur !== A.STAGE.CLOSED && cur !== A.STAGE.CANCELLED) {
    if (cur === 'On Hold') {
      actions.push(`<form method="post" action="/vetmedals.nsf/CaseView.xsp?documentId=${H.attr(doc.unid)}&amp;action=release" class="inlineForm">${H.button('Release Hold')}</form>`);
    } else {
      actions.push(`<form method="post" action="/vetmedals.nsf/CaseView.xsp?documentId=${H.attr(doc.unid)}&amp;action=hold" class="inlineForm">${H.input('HoldReason', '', { size: 24, maxlength: 255, extra: ' placeholder="Hold reason"' })} ${H.button('Place on Hold')}</form>`);
    }
  }
  actions.push(H.linkButton(`/vetmedals.nsf/0/${doc.unid}?OpenDocument`, 'Open Document (raw items)'));
  actions.push(H.linkButton(`/vetmedals.nsf/CSRLookup.xsp?q=${encodeURIComponent(A.text(doc, 'VeteranLastName'))}`, 'CSR Lookup'));
  out.push(`<div class="docActions">${actions.join(' ')}</div>`);
  out.push(H.fieldTable([
    { section: 'Case' },
    { cells: [{ label: 'Case Number', value: caseNo }, { label: 'Assigned CSR', value: A.commonName(A.text(doc, 'AssignedCSR')) }] },
    { cells: [{ label: 'Authorization Date', value: H.fmtValue(doc.items.AuthorizationDate) }, { label: 'Entered', value: `${H.fmtValue(doc.items.EnteredDate)} by ${A.commonName(A.text(doc, 'EnteredBy'))}` }] },
    { cells: [{ label: 'Authorization File', value: authFile ? `<a href="/vetmedals.nsf/0/${H.attr(authFile.unid)}?OpenDocument">${H.esc(A.text(doc, 'AuthFileName'))}</a> line ${H.esc(String(doc.items.AuthFileLine || ''))}` : H.esc(A.text(doc, 'AuthFileName') || '(manual entry)'), raw: true }, { label: 'Days Open / In Stage', value: `${doc.items.DaysOpen} / ${doc.items.DaysInStage}` }] },
    { cells: [{ label: 'Hold Reason', value: A.text(doc, 'HoldReason') || '-' }, { label: 'Stage Before Hold', value: A.text(doc, 'StageBeforeHold') || '-' }] },
    { section: 'Veteran' },
    { cells: [{ label: 'Service Number', value: A.text(doc, 'ServiceNumber') }, { label: 'Rank', value: A.text(doc, 'VeteranRank') }] },
    { cells: [{ label: 'Service From / To', value: `${H.fmtValue(doc.items.ServiceFrom)} - ${H.fmtValue(doc.items.ServiceTo)}` }, { label: 'Deceased', value: A.text(doc, 'Deceased') }] },
    { section: 'Requester / next of kin (synthetic PII)' },
    { cells: [{ label: 'Requester', value: requester ? `<a href="/vetmedals.nsf/0/${H.attr(requester.unid)}?OpenDocument">${H.esc(A.text(doc, 'RequesterName'))}</a> (${H.esc(A.text(doc, 'RequesterKey'))})` : `${H.esc(A.text(doc, 'RequesterName'))} <span class="warn">(requester key ${H.esc(A.text(doc, 'RequesterKey'))} not found)</span>`, raw: true }, { label: 'Relationship', value: A.text(doc, 'Relationship') }] },
    { cells: [{ label: 'Ship To', value: `${A.text(doc, 'ShipToName')}, ${A.text(doc, 'ShipToStreet')}, ${A.text(doc, 'ShipToCity')} ${A.text(doc, 'ShipToState')} ${A.text(doc, 'ShipToZIP')}` }, { label: 'Requester Phone / Email', value: requester ? `${A.text(requester, 'Phone')} / ${A.text(requester, 'Email')}` : '-' }] },
    { section: 'Fulfilment' },
    { cells: [{ label: 'Engraving Job', value: job ? `<a href="/vetmedals.nsf/0/${H.attr(job.unid)}?OpenDocument">${H.esc(A.text(job, 'JobNumber'))}</a> (${H.esc(A.text(job, 'JobStatus'))})` : H.esc(A.text(doc, 'EngravingJobNumber') || '-'), raw: true }, { label: 'Engraving Date', value: H.fmtValue(doc.items.EngravingDate) || '-' }] },
    { cells: [{ label: 'Assembly Date', value: H.fmtValue(doc.items.AssemblyDate) || '-' }, { label: 'QC Result', value: A.text(doc, 'QCResult') || '-' }] },
    { cells: [{ label: 'Warehouse Date', value: H.fmtValue(doc.items.WarehouseDate) || '-' }, { label: 'Pick Bin', value: A.text(doc, 'PickBin') || '-' }] },
    { cells: [{ label: 'Shipped Date', value: H.fmtValue(doc.items.ShippedDate) || '-' }, { label: 'Tracking', value: A.text(doc, 'TrackingNumber') || '-' }] },
    { cells: [{ label: 'Closed Date', value: H.fmtValue(doc.items.ClosedDate) || '-' }, { label: 'Remarks', value: A.text(doc, 'Remarks') || '-' }] },
  ]));
  out.push(`<h3>Award lines (${lines.length})${Number(doc.items.LineCount) !== lines.length ? ` <span class="warn">LineCount item says ${H.esc(String(doc.items.LineCount))}</span>` : ''}</h3>`);
  out.push(D.responsesTable(DB, lines, [
    { title: '#', item: 'LineNumber' }, { title: 'Award', item: 'AwardName' }, { title: 'Code', item: 'AwardCode' }, { title: 'Category', item: 'AwardCategory' }, { title: 'Qty', item: 'Quantity' }, { title: 'Set', item: 'SetType' }, { title: 'Devices', render: (l) => H.esc([].concat(l.items.Devices || []).filter(Boolean).join(', ') + (Number(l.items.DeviceCount) ? ` x${l.items.DeviceCount}` : '')) }, { title: 'Engrave', render: (l) => (A.text(l, 'Engrave') === 'Yes' ? `<b>Yes</b> <span class="mono">${H.esc(A.text(l, 'EngravingText'))}</span>` : 'No') }, { title: 'Line Status', item: 'LineStatus' }, { title: 'Authority', item: 'Authority' },
  ]) || '<p class="muted">No AwardLine documents (orphaned case or import problem).</p>');
  if (shipments.length) {
    out.push(`<h3>Shipments (${shipments.length})</h3>`);
    out.push(D.responsesTable(DB, shipments, [{ title: 'Shipment', item: 'ShipmentNumber' }, { title: 'Carrier', item: 'Carrier' }, { title: 'Tracking', item: 'TrackingNumber' }, { title: 'Status', item: 'ShipStatus' }, { title: 'Shipped', item: 'ShippedDate' }, { title: 'Delivered', item: 'DeliveredDate' }, { title: 'Pieces', item: 'PieceCount' }, { title: 'Partial', item: 'Partial' }]));
  }
  out.push(`<h3>Case notes (${notes.length})</h3>`);
  if (isCsr) {
    const noteForm = D.findForm(design, 'CaseNote');
    const types = noteForm.fields.find((f) => f.name === 'NoteType').keywords;
    out.push(`<form method="post" action="/vetmedals.nsf/CaseView.xsp?documentId=${H.attr(doc.unid)}&amp;action=note" class="dominoForm noteForm">
${H.fieldTable([{ cells: [{ label: 'Type', value: H.select('NoteType', types, types[0]), raw: true }, { label: 'Contact', value: H.input('ContactName', '', { size: 24, maxlength: 100 }), raw: true }] }, { label: 'Summary', value: H.input('Summary', '', { size: 70, maxlength: 255 }), raw: true, colspan: 3, required: true }, { label: 'Body', value: '<textarea name="Body" rows="3" cols="70" maxlength="2000" class="xspInputFieldEditBox"></textarea>', raw: true, colspan: 3 }])}
<div class="formButtons">${H.button('Add Note')}</div></form>`);
  }
  out.push(notes.length ? `<table class="dominoView" border="1" cellpadding="3" cellspacing="0" width="100%"><tr><th>Date</th><th>Type</th><th>Author</th><th>Contact</th><th>Summary</th><th>Follow-up</th></tr>${notes.map((n) => `<tr><td><a href="/vetmedals.nsf/0/${H.attr(n.unid)}?OpenDocument">${H.esc(H.fmtValue(n.items.NoteDate))}</a></td><td>${H.esc(A.text(n, 'NoteType'))}</td><td>${H.esc(A.commonName(A.text(n, 'NoteAuthor')))}</td><td>${H.esc(A.text(n, 'ContactName'))}</td><td>${H.esc(A.text(n, 'Summary'))}${A.text(n, 'Body') ? `<div class="muted">${H.esc(A.text(n, 'Body')).slice(0, 300)}</div>` : ''}</td><td>${H.esc(H.fmtValue(n.items.FollowUpDate))}${A.text(n, 'FollowUpDone') === 'Yes' ? ' (done)' : ''}</td></tr>`).join('')}</table>` : '<p class="muted">No case notes.</p>');
  out.push('<h3>Status history</h3>');
  out.push(`<div class="historyBox mono">${[].concat(doc.items.StatusHistory || []).map((h) => H.esc(h)).join('<br>') || '(none)'}</div>`);
  out.push(D.systemTable(doc, DB));
  return page(ctx, { title: `Case ${caseNo}`, content: out.join('\n'), breadcrumb: [{ label: 'Veteran Medals', href: '/vetmedals.nsf/CasesByStage?OpenView' }, { label: 'CaseView.xsp' }, { label: caseNo }] });
}

function caseFromQuery(ctx) {
  const db = ctx.app.store.db(DB);
  let doc = null;
  if (ctx.query.documentId) {
    doc = db.get(cleanUnid(ctx.query.documentId));
  } else if (ctx.query.caseNumber) {
    doc = db.findOne('AwardsCase', 'CaseNumber', cleanCode(ctx.query.caseNumber, 20));
  }
  if (!doc || doc.form !== 'AwardsCase') {
    throw new A.AppError('Case not found', 404);
  }
  return doc;
}

router.get((ctx) => ctx.pathname === '/vetmedals.nsf/CaseView.xsp', (ctx) => {
  if (!ctx.query.documentId && !ctx.query.caseNumber) {
    const db = ctx.app.store.db(DB);
    const open = db.all('AwardsCase').filter((d) => ![A.STAGE.CLOSED, A.STAGE.CANCELLED].includes(A.text(d, 'Stage').trim())).slice(0, 40);
    const content = `<p>Open a case from a view, or pick one of the open cases below.</p>
<form method="get" action="/vetmedals.nsf/CaseView.xsp" class="dominoForm inlineForm"><label>Case Number ${H.input('caseNumber', '', { size: 18, maxlength: 20 })}</label> ${H.button('Open Case')}</form>
<table class="dominoView" border="1" cellpadding="3" cellspacing="0" width="100%"><tr><th>Case</th><th>Veteran</th><th>Stage</th><th>Aging</th><th>Priority</th><th>Days Open</th><th>CSR</th></tr>${open.map((d) => `<tr><td>${caseLink(d)}</td><td>${H.esc(`${A.text(d, 'VeteranLastName')}, ${A.text(d, 'VeteranFirstName')}`)}</td><td>${stageChip(A.text(d, 'Stage'))}</td><td>${agingChip(A.text(d, 'AgingFlag'))}</td><td>${H.esc(A.text(d, 'Priority'))}</td><td align="right">${H.esc(String(d.items.DaysOpen))}</td><td>${H.esc(A.commonName(A.text(d, 'AssignedCSR')))}</td></tr>`).join('')}</table>`;
    return page(ctx, { title: 'Case View', content });
  }
  const doc = caseFromQuery(ctx);
  ctx.app.audit.write('document_read', { user: ctx.user.name, ip: ctx.ip, db: DB, unid: doc.unid, form: doc.form, caseNumber: A.text(doc, 'CaseNumber') });
  return casePage(ctx, doc);
});

router.post((ctx) => ctx.pathname === '/vetmedals.nsf/CaseView.xsp', (ctx) => {
  requireLogin(ctx);
  const db = ctx.app.store.db(DB);
  const doc = caseFromQuery(ctx);
  const action = cleanText(ctx.query.action, 10);
  const clock = () => ctx.now;
  const caseNo = A.text(doc, 'CaseNumber');
  if (action === 'advance') {
    const r = A.advanceCase(actx(ctx), doc);
    if (!r.ok) {
      ctx.app.audit.write(r.forbidden ? 'authorization_failure' : 'validation_failure', { user: ctx.user.name, ip: ctx.ip, db: DB, unid: doc.unid, caseNumber: caseNo, action: 'advance', errors: r.errors });
      ctx.res.statusCode = r.forbidden ? 403 : 400;
      return casePage(ctx, doc, { errors: r.errors });
    }
    ctx.app.audit.write('case_stage_change', { user: ctx.user.name, ip: ctx.ip, db: DB, unid: doc.unid, caseNumber: caseNo, from: r.from, to: r.to, side: r.side.map((s) => `${s.form}:${A.text(s, 'JobNumber') || A.text(s, 'ShipmentNumber')}`) });
    return ctx.redirect(`/vetmedals.nsf/CaseView.xsp?documentId=${doc.unid}&Advanced=${encodeURIComponent(r.to)}`, 303);
  }
  if (action === 'note') {
    requireRole(ctx, '[CSR]', '[TACOM]', '[Admin]');
    const summary = cleanText(ctx.body.Summary, 255);
    if (!summary) {
      ctx.res.statusCode = 400;
      return casePage(ctx, doc, { errors: ['Summary is required for a case note.'] });
    }
    const noteForm = D.findForm(ctx.app.designs[DB], 'CaseNote');
    const types = noteForm.fields.find((f) => f.name === 'NoteType').keywords;
    const type = types.includes(ctx.body.NoteType) ? ctx.body.NoteType : types[0];
    const note = db.create('CaseNote', {
      ParentCaseNumber: caseNo,
      ParentUNID: doc.unid,
      NoteType: type,
      ContactName: cleanText(ctx.body.ContactName, 100),
      ContactPhone: '',
      Body: cleanText(ctx.body.Body, 2000),
      Summary: summary,
      FollowUpDate: '',
      FollowUpDone: '',
      NoteAuthor: ctx.user.name,
      NoteDate: ctx.now.toISOString(),
      DocReaders: doc.items.DocReaders || [],
      DocAuthors: ['[CSR]', '[TACOM]', '[Admin]'],
    }, { user: ctx.user.name, parent: doc.unid, clock });
    ctx.app.audit.write('document_create', { user: ctx.user.name, ip: ctx.ip, db: DB, form: 'CaseNote', unid: note.unid, caseNumber: caseNo });
    return ctx.redirect(`/vetmedals.nsf/CaseView.xsp?documentId=${doc.unid}&NoteSaved=1`, 303);
  }
  if (action === 'hold' || action === 'release') {
    requireRole(ctx, '[CSR]', '[TACOM]', '[Admin]');
    const from = A.text(doc, 'Stage');
    if (action === 'hold') {
      const reason = cleanText(ctx.body.HoldReason, 255);
      if (!reason) {
        ctx.res.statusCode = 400;
        return casePage(ctx, doc, { errors: ['A hold reason is required.'] });
      }
      db.update(doc, { Stage: 'On Hold', StageBeforeHold: from, HoldReason: reason, StageDate: ctx.now.toISOString(), DaysInStage: 0, StatusHistory: [].concat(doc.items.StatusHistory || []).concat(`${H.fmtDate(ctx.now.toISOString())} | ${from} -> On Hold | ${A.commonName(ctx.user.name)}`), LastModifiedBy: ctx.user.name, LastModifiedDate: ctx.now.toISOString() }, { user: ctx.user.name, clock });
    } else {
      const back = A.text(doc, 'StageBeforeHold') || A.STAGE.AUTHORIZED;
      db.update(doc, { Stage: back, StageBeforeHold: '', HoldReason: '', StageDate: ctx.now.toISOString(), DaysInStage: 0, StatusHistory: [].concat(doc.items.StatusHistory || []).concat(`${H.fmtDate(ctx.now.toISOString())} | On Hold -> ${back} | ${A.commonName(ctx.user.name)}`), LastModifiedBy: ctx.user.name, LastModifiedDate: ctx.now.toISOString() }, { user: ctx.user.name, clock });
    }
    ctx.app.audit.write('case_stage_change', { user: ctx.user.name, ip: ctx.ip, db: DB, unid: doc.unid, caseNumber: caseNo, from, to: A.text(doc, 'Stage'), hold: action });
    return ctx.redirect(`/vetmedals.nsf/CaseView.xsp?documentId=${doc.unid}&Hold=${action === 'hold' ? 'on' : 'off'}`, 303);
  }
  throw new A.AppError('Unknown action', 400);
});

/* ---------------------------------------------------------------- EngravingQueue.xsp */

router.get((ctx) => ctx.pathname === '/vetmedals.nsf/EngravingQueue.xsp', (ctx) => {
  const db = ctx.app.store.db(DB);
  const status = cleanText(ctx.query.status, 20) || 'open';
  const jobs = db.all('EngravingJob').filter((j) => (status === 'all' ? true : status === 'open' ? ['Queued', 'In Progress', 'Rework'].includes(A.text(j, 'JobStatus')) : A.text(j, 'JobStatus') === status));
  const prio = { Congressional: 0, Expedite: 1, Routine: 2 };
  jobs.sort((a, b) => (prio[A.text(a, 'Priority')] ?? 3) - (prio[A.text(b, 'Priority')] ?? 3) || String(a.items.QueuedDate).localeCompare(String(b.items.QueuedDate)));
  const canWork = hasRole(ctx.user, '[Engraver]', '[TACOM]', '[Admin]');
  const rows = jobs.slice(0, 150).map((j) => {
    const st = A.text(j, 'JobStatus');
    const kase = db.findOne('AwardsCase', 'CaseNumber', A.text(j, 'CaseNumber'));
    let act = '';
    if (canWork && (st === 'Queued' || st === 'Rework')) {
      act = `<form method="post" action="/vetmedals.nsf/EngravingQueue.xsp" class="inlineForm"><input type="hidden" name="unid" value="${H.attr(j.unid)}"><input type="hidden" name="action" value="start">${H.select('Machine', ['Laser-1', 'Laser-2', 'Rotary-A', 'Hand'], A.text(j, 'Machine') || 'Laser-1')} ${H.button('Start')}</form>`;
    } else if (canWork && st === 'In Progress') {
      act = `<form method="post" action="/vetmedals.nsf/EngravingQueue.xsp" class="inlineForm"><input type="hidden" name="unid" value="${H.attr(j.unid)}"><input type="hidden" name="action" value="complete"><label><input type="checkbox" name="Proof" value="1"> proof checked</label> ${H.button('Complete')}</form> <form method="post" action="/vetmedals.nsf/EngravingQueue.xsp" class="inlineForm"><input type="hidden" name="unid" value="${H.attr(j.unid)}"><input type="hidden" name="action" value="rework">${H.button('Rework', { className: 'xspButtonCommand dangerButton' })}</form>`;
    }
    const days = j.items.QueuedDate ? A.daysBetween(String(j.items.QueuedDate), ctx.now) : '';
    return `<tr class="prio${H.attr(A.text(j, 'Priority'))}"><td><a href="/vetmedals.nsf/0/${H.attr(j.unid)}?OpenDocument">${H.esc(A.text(j, 'JobNumber'))}</a></td><td>${kase ? caseLink(kase) : H.esc(A.text(j, 'CaseNumber'))}</td><td>${H.esc(A.text(j, 'VeteranName'))}</td><td>${H.esc(A.text(j, 'Priority'))}</td><td>${[].concat(j.items.Items || []).map((x) => `<div class="mono small">${H.esc(x)}</div>`).join('')}</td><td>${H.esc(A.text(j, 'Font'))}</td><td>${H.esc(A.text(j, 'Machine'))}</td><td>${H.esc(H.fmtValue(j.items.QueuedDate))}</td><td align="right">${H.esc(String(days))}</td><td>${H.esc(st)}${Number(j.items.ReworkCount) ? ` <span class="warn">rework x${H.esc(String(j.items.ReworkCount))}</span>` : ''}</td><td>${H.esc(A.commonName(A.text(j, 'Engraver')))}</td><td>${act}</td></tr>`;
  }).join('');
  const counts = {};
  for (const j of db.all('EngravingJob')) {
    counts[A.text(j, 'JobStatus')] = (counts[A.text(j, 'JobStatus')] || 0) + 1;
  }
  const filters = [['open', 'Open (Queued / In Progress / Rework)'], ['Queued', 'Queued'], ['In Progress', 'In Progress'], ['Rework', 'Rework'], ['Complete', 'Complete'], ['all', 'All']].map(([k, l]) => (k === status ? `<b>${H.esc(l)}</b>` : `<a href="/vetmedals.nsf/EngravingQueue.xsp?status=${H.attr(encodeURIComponent(k))}">${H.esc(l)}</a>`)).join(' | ');
  const content = `
${ctx.query.Done ? H.infoBlock(`Engraving job ${cleanCode(ctx.query.Done, 20)} updated.`) : ''}
<p>Engraving shop work queue, sorted Congressional &rarr; Expedite &rarr; Routine then by queued date. Engraving text is transcribed in upper case exactly as authorized; the proof check confirms spelling against the authorization record before the job is completed and the case moves to Assembly/QC.</p>
<div class="viewToolbar">${filters} &nbsp; <span class="muted">${Object.entries(counts).map(([k, v]) => `${H.esc(k)}: ${v}`).join(' &middot; ')}</span></div>
<table class="dominoView" border="1" cellpadding="3" cellspacing="0" width="100%"><tr><th>Job</th><th>Case</th><th>Veteran</th><th>Priority</th><th>Items :: Engraving Text</th><th>Font</th><th>Machine</th><th>Queued</th><th>Days</th><th>Status</th><th>Engraver</th><th>Action</th></tr>${rows || '<tr><td colspan="12" class="muted">No jobs match this filter.</td></tr>'}</table>
<p class="muted">${jobs.length} job(s)${jobs.length > 150 ? ' (first 150 shown)' : ''}. Design source: xpages/EngravingQueue.xsp bound to view EngravingQueue (selection <code>Form = "EngravingJob" &amp; JobStatus != "Complete"</code>).</p>`;
  return page(ctx, { title: 'Engraving Queue', content, breadcrumb: [{ label: 'Veteran Medals', href: '/vetmedals.nsf/CasesByStage?OpenView' }, { label: 'EngravingQueue.xsp' }] });
});

router.post((ctx) => ctx.pathname === '/vetmedals.nsf/EngravingQueue.xsp', (ctx) => {
  requireRole(ctx, '[Engraver]', '[TACOM]', '[Admin]');
  const db = ctx.app.store.db(DB);
  const job = db.get(cleanUnid(ctx.body.unid));
  if (!job || job.form !== 'EngravingJob') {
    throw new A.AppError('Engraving job not found', 404);
  }
  const action = cleanText(ctx.body.action, 10);
  const from = A.text(job, 'JobStatus');
  const clock = () => ctx.now;
  const machines = ['Laser-1', 'Laser-2', 'Rotary-A', 'Hand'];
  if (action === 'start' && (from === 'Queued' || from === 'Rework')) {
    db.update(job, { JobStatus: 'In Progress', StartedDate: ctx.now.toISOString(), Engraver: ctx.user.name, Machine: machines.includes(ctx.body.Machine) ? ctx.body.Machine : 'Laser-1' }, { user: ctx.user.name, clock });
  } else if (action === 'complete' && from === 'In Progress') {
    db.update(job, { JobStatus: 'Complete', CompletedDate: ctx.now.toISOString(), Engraver: ctx.user.name, ProofChecked: ctx.body.Proof ? ['Spelling verified against authorization record', 'Award matches line item'] : [] }, { user: ctx.user.name, clock });
    const kase = db.findOne('AwardsCase', 'CaseNumber', A.text(job, 'CaseNumber'));
    if (kase && A.text(kase, 'Stage') === A.STAGE.ENGRAVING) {
      const r = A.advanceCase({ ...actx(ctx), user: { ...ctx.user, roles: [...ctx.user.roles, '[Engraver]'] } }, kase);
      if (r.ok) {
        ctx.app.audit.write('case_stage_change', { user: ctx.user.name, ip: ctx.ip, db: DB, unid: kase.unid, caseNumber: A.text(kase, 'CaseNumber'), from: r.from, to: r.to, via: 'EngravingQueue' });
      }
    }
  } else if (action === 'rework' && from === 'In Progress') {
    db.update(job, { JobStatus: 'Rework', ReworkCount: (Number(job.items.ReworkCount) || 0) + 1, Notes: `${A.text(job, 'Notes')}\n${H.fmtDate(ctx.now.toISOString())} rework requested by ${A.commonName(ctx.user.name)}`.trim() }, { user: ctx.user.name, clock });
  } else {
    throw new A.AppError('That action is not valid for the job status', 400);
  }
  ctx.app.audit.write('engraving_job_change', { user: ctx.user.name, ip: ctx.ip, db: DB, unid: job.unid, jobNumber: A.text(job, 'JobNumber'), from, to: A.text(job, 'JobStatus') });
  return ctx.redirect(`/vetmedals.nsf/EngravingQueue.xsp?Done=${encodeURIComponent(A.text(job, 'JobNumber'))}`, 303);
});

/* ---------------------------------------------------------------- CSRLookup.xsp */

router.get((ctx) => ctx.pathname === '/vetmedals.nsf/CSRLookup.xsp', (ctx) => {
  const db = ctx.app.store.db(DB);
  const q = cleanText(ctx.query.q, 60);
  const stageFilter = cleanText(ctx.query.stage, 20);
  let hits = [];
  if (q) {
    const needle = q.toUpperCase().replace(/[^A-Z0-9 ,.'-]/g, '');
    const digits = needle.replace(/\D/g, '');
    hits = db.all('AwardsCase').filter((d) => {
      if (stageFilter && A.text(d, 'Stage').trim() !== stageFilter) {
        return false;
      }
      const hay = [A.text(d, 'CaseNumber'), A.text(d, 'VeteranLastName'), A.text(d, 'VeteranFirstName'), `${A.text(d, 'VeteranLastName')}, ${A.text(d, 'VeteranFirstName')}`, A.text(d, 'RequesterName'), A.text(d, 'TrackingNumber')].join('|').toUpperCase();
      if (hay.includes(needle)) {
        return true;
      }
      return digits.length >= 4 && (A.text(d, 'ServiceNumber').replace(/\D/g, '').includes(digits) || A.text(d, 'TrackingNumber').replace(/\D/g, '').includes(digits) || A.text(d, 'CaseNumber').replace(/\D/g, '').includes(digits));
    }).slice(0, 100);
    ctx.app.audit.write('data_access', { user: ctx.user.name, ip: ctx.ip, db: DB, view: 'CSRLookup', query: needle, hits: hits.length });
  }
  const stages = A.STAGE_ORDER.concat(['On Hold', 'Cancelled']);
  const rows = hits.map((d) => {
    const lines = db.findAll('AwardLine', 'ParentCaseNumber', A.text(d, 'CaseNumber'));
    return `<tr><td>${caseLink(d)}</td><td>${H.esc(`${A.text(d, 'VeteranLastName')}, ${A.text(d, 'VeteranFirstName')} ${A.text(d, 'VeteranMI')}`)}<br><span class="muted">${H.esc(A.text(d, 'VeteranRank'))} &middot; ${H.esc(A.text(d, 'ServiceNumber'))} &middot; ${H.esc(A.text(d, 'Era'))}</span></td><td>${H.esc(A.text(d, 'RequesterName'))}<br><span class="muted">${H.esc(A.text(d, 'Relationship'))} &middot; ${H.esc(A.text(d, 'ShipToCity'))}, ${H.esc(A.text(d, 'ShipToState'))}</span></td><td>${stageChip(A.text(d, 'Stage'))} ${agingChip(A.text(d, 'AgingFlag'))}</td><td>${H.esc(H.fmtValue(d.items.AuthorizationDate))}</td><td align="right">${H.esc(String(d.items.DaysOpen))}</td><td>${lines.map((l) => H.esc(A.text(l, 'AwardName'))).join('<br>')}</td><td>${H.esc(A.text(d, 'TrackingNumber') || '-')}</td><td>${H.esc(A.commonName(A.text(d, 'AssignedCSR')))}</td></tr>`;
  }).join('');
  const content = `
<p>Customer-service lookup for inbound calls and congressional inquiries. Search by veteran last name, "Last, First", case number, SSN last-4 / legacy service number (digits of the <code>ServiceNumber</code> field), requester name or tracking number. Backed by the <code>CSRLookup</code> view (categorized by veteran last name) and the <code>($Lookups)</code> view.</p>
<form method="get" action="/vetmedals.nsf/CSRLookup.xsp" class="dominoForm">
${H.fieldTable([{ cells: [{ label: 'Search', value: H.input('q', q, { size: 36, maxlength: 60, extra: ' autofocus' }), raw: true, required: true }, { label: 'Stage', value: H.select('stage', stages, stageFilter, { blank: '(any stage)' }), raw: true }] }])}
<div class="formButtons">${H.button('Look Up')} ${H.linkButton('/vetmedals.nsf/CSRLookup.xsp', 'Clear')}</div>
</form>
${q ? `<h3>${hits.length} match(es) for "${H.esc(q)}"${hits.length === 100 ? ' (first 100)' : ''}</h3>
<table class="dominoView" border="1" cellpadding="3" cellspacing="0" width="100%"><tr><th>Case</th><th>Veteran</th><th>Requester</th><th>Stage</th><th>Authorized</th><th>Days</th><th>Awards</th><th>Tracking</th><th>CSR</th></tr>${rows || '<tr><td colspan="9" class="muted">No cases found. Try the last name only, or the digits of the service number.</td></tr>'}</table>` : `<h3>Try a lookup</h3><p class="muted">${db.all('AwardsCase').slice(0, 6).map((d) => `<a href="/vetmedals.nsf/CSRLookup.xsp?q=${H.attr(encodeURIComponent(A.text(d, 'VeteranLastName')))}">${H.esc(A.text(d, 'VeteranLastName'))}</a>`).join(' &middot; ')} &middot; <a href="/vetmedals.nsf/CSRLookup.xsp?q=${H.attr(encodeURIComponent(A.text(db.all('AwardsCase')[0], 'CaseNumber')))}">${H.esc(A.text(db.all('AwardsCase')[0], 'CaseNumber'))}</a></p>`}`;
  return page(ctx, { title: 'CSR Lookup', content, breadcrumb: [{ label: 'Veteran Medals', href: '/vetmedals.nsf/CasesByStage?OpenView' }, { label: 'CSRLookup.xsp' }] });
});

/* ---------------------------------------------------------------- Home / views / documents */

router.get((ctx) => ctx.pathname === '/vetmedals.nsf/Home.xsp' || ctx.pathname === '/vetmedals.nsf/VetMedalsHome.xsp', (ctx) => ctx.redirect('/vetmedals.nsf/CasesByStage?OpenView', 302));

router.get((ctx) => {
  const p = splitDbPath(ctx.pathname);
  return p && p.db === DB && p.parts.length === 1 && dominoCommand(ctx.query) === 'openview';
}, (ctx) => openView(ctx, DB));

router.get((ctx) => {
  const p = splitDbPath(ctx.pathname);
  return p && p.db === DB && p.parts.length === 2 && p.parts[0] === '0' && dominoCommand(ctx.query) === 'opendocument';
}, (ctx) => {
  const db = ctx.app.store.db(DB);
  const p = splitDbPath(ctx.pathname);
  const doc = db.get(cleanUnid(p.parts[1]));
  if (!doc) {
    throw new A.AppError('Document not found', 404);
  }
  ctx.app.audit.write('document_read', { user: ctx.user.name, ip: ctx.ip, db: DB, unid: doc.unid, form: doc.form });
  const design = ctx.app.designs[DB];
  const out = [];
  const label = doc.form === 'AwardsCase' ? `Case ${A.text(doc, 'CaseNumber')}` : doc.form === 'AwardLine' ? `${A.text(doc, 'AwardName')} (line ${A.text(doc, 'LineNumber')} of ${A.text(doc, 'ParentCaseNumber')})` : doc.form === 'EngravingJob' ? `Engraving Job ${A.text(doc, 'JobNumber')}` : doc.form === 'ShipmentRecord' ? `Shipment ${A.text(doc, 'ShipmentNumber')}` : doc.form === 'AuthorizationFile' ? `Authorization File ${A.text(doc, 'FileName')}` : doc.form === 'Requester' ? `Requester ${A.text(doc, 'RequesterKey')} - ${A.text(doc, 'LastName')}, ${A.text(doc, 'FirstName')}` : doc.form === 'CaseNote' ? `Case Note - ${A.text(doc, 'ParentCaseNumber')}` : `${doc.form} ${doc.unid}`;
  if (doc.form === 'AwardsCase') {
    out.push(`<div class="docActions">${H.linkButton(`/vetmedals.nsf/CaseView.xsp?documentId=${doc.unid}`, 'Open in CaseView.xsp')}</div>`);
  }
  const caseNo = A.text(doc, 'ParentCaseNumber') || A.text(doc, 'CaseNumber');
  if (doc.form !== 'AwardsCase' && caseNo) {
    const kase = db.findOne('AwardsCase', 'CaseNumber', caseNo);
    out.push(`<div class="docActions">${kase ? H.linkButton(`/vetmedals.nsf/CaseView.xsp?documentId=${kase.unid}`, `Open case ${caseNo}`) : `<span class="warn">References case ${H.esc(caseNo)} which does not exist (orphan).</span>`}</div>`);
  }
  if (doc.form === 'Requester') {
    const cases = db.findAll('AwardsCase', 'RequesterKey', A.text(doc, 'RequesterKey'));
    const dupes = db.all('Requester').filter((r) => r.unid !== doc.unid && A.text(r, 'LookupKey') && A.text(r, 'LookupKey') === A.text(doc, 'LookupKey'));
    out.push(`<p>${cases.length} case(s): ${cases.map((c) => caseLink(c)).join(', ') || '-'}${dupes.length ? `<br><span class="warn">${dupes.length} other Requester document(s) share this lookup key (duplicate requester wart): ${dupes.map((r) => `<a href="/vetmedals.nsf/0/${H.attr(r.unid)}?OpenDocument">${H.esc(A.text(r, 'RequesterKey'))}</a>`).join(', ')}</span>` : ''}</p>`);
  }
  if (doc.form === 'AuthorizationFile') {
    const cases = db.findAll('AwardsCase', 'AuthFileName', A.text(doc, 'FileName'));
    out.push(`<p>${cases.length} case(s) created from this file. Import status: <b>${H.esc(A.text(doc, 'ImportStatus'))}</b>, checksum match ${H.esc(A.text(doc, 'ChecksumMatch'))}. ${H.linkButton('/agents?agent=ImportAuthorizationFile', 'Run ImportAuthorizationFile')}</p>`);
    if (A.text(doc, 'FileBody')) {
      out.push(`<div class="twistySection"><a href="#" class="twisty" data-target="fileBody" aria-expanded="false">&#9654;</a> <b>File body (${String(doc.items.FileBody).split('\n').length} lines)</b></div><pre id="fileBody" class="fileBody" hidden>${H.esc(String(doc.items.FileBody).slice(0, 20000))}</pre>`);
    }
  }
  out.push(D.itemsTable(design, doc));
  out.push(D.systemTable(doc, DB));
  return page(ctx, { title: label, content: out.join('\n'), breadcrumb: [{ label: 'Veteran Medals', href: '/vetmedals.nsf/CasesByStage?OpenView' }, { label: doc.form, href: '/vetmedals.nsf/($All)?OpenView' }, { label }] });
});

module.exports = { dispatch: (ctx) => router.dispatch(ctx), stageChip, agingChip, cleanInt };
