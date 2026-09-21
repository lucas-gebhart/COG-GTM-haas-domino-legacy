'use strict';

/**
 * Routes that are not tied to one database: home redirect, the EAMS-A login stub
 * (names.nsf?Login), the design inventory (/design), the Agents menu, and the audit view.
 */

const fs = require('node:fs');
const path = require('node:path');
const H = require('../lib/html');
const A = require('../lib/agents');
const { PERSONAS, hasRole } = require('../lib/personas');
const { Router, dominoCommand, requireRole, cleanText, cleanName } = require('./router');

const router = new Router();

const SAMPLE_DIR = path.join(__dirname, '..', '..', 'export', 'authorization-files');

function commonNav(ctx, current) {
  return [
    { heading: 'Heraldry Automation System' },
    { label: 'Home', href: '/heraldry.nsf/HeraldryHome.xsp', current: current === 'home' },
    { label: 'Create DD 1348-6 Request', href: '/heraldry.nsf/Request?OpenForm' },
    { label: 'Modify / Cancel Request', href: '/heraldry.nsf/ModifyRequest.xsp' },
    { label: 'Status Inquiry', href: '/heraldry.nsf/StatusInquiry.xsp' },
    { label: 'SES Flag Requests', href: '/heraldry.nsf/SESFlag.xsp' },
    { label: 'Vendor Work Queue', href: '/heraldry.nsf/VendorQueue.xsp' },
    { heading: 'Heraldry Views' },
    { label: 'Requests by Status', href: '/heraldry.nsf/RequestsByStatus?OpenView' },
    { label: 'Requests by Unit', href: '/heraldry.nsf/RequestsByUnit?OpenView' },
    { label: 'Requests by DODAAC', href: '/heraldry.nsf/RequestsByDODAAC?OpenView' },
    { label: 'Open Vendor Work', href: '/heraldry.nsf/OpenVendorWork?OpenView' },
    { label: 'Heraldic Catalog', href: '/heraldry.nsf/HeraldicCatalog?OpenView' },
    { label: 'SES Flag Queue', href: '/heraldry.nsf/SESFlagQueue?OpenView' },
    { heading: 'Veteran Medals & Awards' },
    { label: 'Cases by Stage', href: '/vetmedals.nsf/CasesByStage?OpenView' },
    { label: 'Cases by Auth Date', href: '/vetmedals.nsf/CasesByAuthDate?OpenView' },
    { label: 'Aging Cases', href: '/vetmedals.nsf/AgingCases?OpenView' },
    { label: 'Engraving Queue', href: '/vetmedals.nsf/EngravingQueue.xsp' },
    { label: 'Assembly Queue', href: '/vetmedals.nsf/AssemblyQueue?OpenView' },
    { label: 'Warehouse Pick', href: '/vetmedals.nsf/WarehousePick?OpenView' },
    { label: 'Ship Confirm', href: '/vetmedals.nsf/ShipConfirm?OpenView' },
    { label: 'CSR Lookup', href: '/vetmedals.nsf/CSRLookup.xsp' },
    { heading: 'Administration' },
    { label: 'Agents', href: '/agents', current: current === 'agents' },
    { label: 'Design Inventory', href: '/design', current: current === 'design' },
    { label: 'Audit Log', href: '/audit', current: current === 'audit' },
    { label: 'Log In / Switch User', href: '/names.nsf?Login', current: current === 'login' },
  ];
}

function render(ctx, opts) {
  return H.page({ user: ctx.user.anonymous ? null : ctx.user, nav: commonNav(ctx, opts.current), ...opts });
}

/* ---------------------------------------------------------------- home */

router.get((ctx) => ctx.pathname === '/' || ctx.pathname === '/heraldry.nsf' || ctx.pathname === '/heraldry.nsf/', (ctx) => ctx.redirect('/heraldry.nsf/HeraldryHome.xsp', 302));

router.get((ctx) => ctx.pathname === '/vetmedals.nsf' || ctx.pathname === '/vetmedals.nsf/', (ctx) => ctx.redirect('/vetmedals.nsf/CasesByStage?OpenView', 302));

router.get((ctx) => ctx.pathname === '/heraldry.nsf/Login.xsp', (ctx) => ctx.redirect('/names.nsf?Login', 302));

/* ---------------------------------------------------------------- names.nsf?Login (EAMS-A stub) */

function loginPage(ctx, message, redirectTo) {
  const rows = PERSONAS.map((p) => `<tr>
<td><form method="post" action="/names.nsf?Login" class="inlineForm"><input type="hidden" name="RedirectTo" value="${H.attr(redirectTo)}"><input type="hidden" name="Username" value="${H.attr(p.id)}"><button type="submit" class="xspButtonCommand">Authenticate as</button></form></td>
<td><b>${H.esc(p.name)}</b><br><span class="muted">${H.esc(p.title)}</span></td>
<td>${H.esc(p.access)}</td>
<td>${p.roles.length ? p.roles.map((r) => `<span class="roleChip">${H.esc(r)}</span>`).join(' ') : '<span class="muted">(no roles)</span>'}</td>
<td class="muted">${H.esc(p.groups.join(', '))}</td>
</tr>`).join('\n');
  const content = `
${message ? H.infoBlock(message) : ''}
<div class="loginBox">
<table border="0" cellpadding="6"><tr><td valign="top" width="420">
<h2>Army Enterprise Access Management Service (EAMS-A)</h2>
<p>The production application authenticates with an EAMS-A SAML assertion; Domino stores the relay state in a <code>DOMRELAYSTATE</code> cookie and maps the asserted CAC identity to a Notes name in <code>names.nsf</code>.</p>
<p class="muted">This harness does not contact EAMS-A or handle certificates. Selecting an identity below simulates a successful assertion for a synthetic person and issues a <code>DomAuthSessId</code> session cookie (HttpOnly, Secure, SameSite=Strict, 15-minute idle timeout). No passwords exist anywhere in this repository.</p>
<p><b>Current identity:</b> ${H.esc(ctx.user.name)} ${ctx.user.anonymous ? '' : `&nbsp;<a href="/names.nsf?Logout" class="xspButtonCommand lnkButton">Log Out</a>`}</p>
</td><td valign="top">
<table class="dominoView" border="1" cellpadding="3" cellspacing="0">
<tr><th></th><th>Notes name</th><th>ACL level</th><th>Roles</th><th>Groups</th></tr>
${rows}
</table>
</td></tr></table>
</div>`;
  return render(ctx, { title: 'Log In (EAMS-A SAML stub)', db: null, appTitle: 'HAAS Domino Web Login', content, current: 'login' });
}

router.get((ctx) => ctx.pathname === '/names.nsf' && dominoCommand(ctx.query) === 'login', (ctx) => loginPage(ctx, ctx.query.reason === 'expired' ? 'Your session has expired. Please authenticate again.' : '', safeRedirect(ctx.query.RedirectTo)));

router.get((ctx) => ctx.pathname === '/names.nsf' && dominoCommand(ctx.query) === 'logout', (ctx) => {
  ctx.app.logout(ctx.req, ctx.res, ctx.ip);
  return ctx.redirect('/names.nsf?Login', 302);
});

router.post((ctx) => ctx.pathname === '/names.nsf' && dominoCommand(ctx.query) === 'login', (ctx) => {
  const id = cleanText(ctx.body.Username, 40);
  if (!/^[a-z0-9-]{1,40}$/.test(id)) {
    throw new A.AppError('Invalid identity selection', 400);
  }
  const persona = ctx.app.login(ctx.res, id, ctx.ip);
  if (!persona) {
    return loginPage(ctx, 'Authentication failed. The identity is not known to names.nsf.', '/');
  }
  return ctx.redirect(safeRedirect(ctx.body.RedirectTo) || '/heraldry.nsf/HeraldryHome.xsp', 303);
});

function safeRedirect(v) {
  const s = String(v || '');
  if (/^\/[A-Za-z0-9_./?&=%$()+-]*$/.test(s) && !s.startsWith('//')) {
    return s;
  }
  return '';
}

/* ---------------------------------------------------------------- /design */

router.get((ctx) => ctx.pathname === '/design', (ctx) => {
  const out = [];
  out.push('<p>Design inventory read live from the DXL/XSP sources under <code>nsf/</code>. This is the discovery screen a modernization team would use to size the migration; <code>docs/DESIGN-INVENTORY.md</code> holds the generated Markdown version.</p>');
  for (const [dbName, d] of Object.entries(ctx.app.designs)) {
    const db = ctx.app.store.db(dbName);
    const counts = db.counts();
    out.push(`<h2>${H.esc(d.properties.title || dbName)} <span class="muted">(${H.esc(dbName)} &middot; replica ${H.esc(d.properties.replicaId)} &middot; ODS ${H.esc(d.properties.odsVersion)})</span></h2>`);
    out.push(`<table class="summaryTable" border="0" cellpadding="4"><tr>
<td><b>${d.forms.length}</b> forms</td><td><b>${d.subforms.length}</b> subforms</td><td><b>${d.views.length}</b> views</td><td><b>${d.agents.length}</b> agents</td>
<td><b>${d.scriptLibraries.length}</b> script libraries</td><td><b>${d.xpages.length}</b> XPages</td><td><b>${d.customControls.length}</b> custom controls</td><td><b>${d.acl.roles.length}</b> ACL roles</td><td><b>${db.documents.length.toLocaleString('en-US')}</b> documents</td></tr></table>`);

    out.push('<h3>Forms</h3><table class="dominoView" border="1" cellpadding="3" cellspacing="0" width="100%"><tr><th>Form</th><th>Alias</th><th>Fields</th><th>Validations</th><th>Computed</th><th>Keyword</th><th>Readers/Authors</th><th>Hide-whens</th><th>Actions</th><th>Documents</th></tr>');
    for (const f of d.forms) {
      out.push(`<tr><td><a href="/design/${H.attr(dbName)}/form/${H.attr(encodeURIComponent(f.name))}">${H.esc(f.name)}</a></td><td>${H.esc(f.alias)}</td><td align="right">${f.fields.length}</td><td align="right">${f.fields.filter((x) => x.inputValidation).length}</td><td align="right">${f.fields.filter((x) => x.kind !== 'editable').length}</td><td align="right">${f.fields.filter((x) => x.type === 'keyword').length}</td><td>${H.esc(f.readersFields.concat(f.authorsFields).join(', '))}</td><td align="right">${f.hideWhens}</td><td align="right">${f.actions.length}</td><td align="right">${(counts[f.name] || 0).toLocaleString('en-US')}</td></tr>`);
    }
    out.push('</table>');

    out.push('<h3>Views</h3><table class="dominoView" border="1" cellpadding="3" cellspacing="0" width="100%"><tr><th>View</th><th>Alias</th><th>Selection formula</th><th>Columns</th><th>Sorted</th><th>Categorized</th><th>Responses</th><th>Open</th></tr>');
    for (const v of d.views) {
      out.push(`<tr><td><a href="/design/${H.attr(dbName)}/view/${H.attr(encodeURIComponent(v.name))}">${H.esc(v.name)}</a></td><td>${H.esc(v.alias)}</td><td><code>${H.esc(v.selection)}</code></td><td align="right">${v.columns.length}</td><td align="right">${v.columns.filter((c) => c.sort).length}</td><td align="right">${v.columns.filter((c) => c.categorized).length}</td><td>${v.showResponseHierarchy ? 'Yes' : ''}</td><td><a href="/${H.attr(dbName)}/${H.attr(encodeURIComponent(v.name))}?OpenView">?OpenView</a></td></tr>`);
    }
    out.push('</table>');

    out.push('<h3>Agents</h3><table class="dominoView" border="1" cellpadding="3" cellspacing="0" width="100%"><tr><th>Agent</th><th>Language</th><th>Trigger</th><th>Schedule</th><th>Runs on</th><th>LoC</th><th>Purpose</th></tr>');
    for (const a of d.agents) {
      out.push(`<tr><td><a href="/design/${H.attr(dbName)}/agent/${H.attr(encodeURIComponent(a.name))}">${H.esc(a.name)}</a></td><td>${H.esc(a.language)}</td><td>${H.esc(a.trigger)}</td><td>${H.esc(scheduleText(a.schedule))}</td><td>${H.esc(a.documentSet)}</td><td align="right">${a.linesOfCode}</td><td>${H.esc(a.comment)}</td></tr>`);
    }
    out.push('</table>');

    out.push('<h3>Script libraries</h3><table class="dominoView" border="1" cellpadding="3" cellspacing="0"><tr><th>Library</th><th>Language</th><th>LoC</th><th>Routines</th></tr>');
    for (const s of d.scriptLibraries) {
      out.push(`<tr><td><a href="/design/${H.attr(dbName)}/scriptlibrary/${H.attr(encodeURIComponent(s.name))}">${H.esc(s.name)}</a></td><td>${H.esc(s.language)}</td><td align="right">${s.linesOfCode}</td><td align="right">${s.routines}</td></tr>`);
    }
    out.push('</table>');

    out.push('<h3>XPages and custom controls</h3><table class="dominoView" border="1" cellpadding="3" cellspacing="0" width="100%"><tr><th>Page</th><th>Title</th><th>Data sources</th><th>Controls</th><th>Inputs</th><th>Buttons</th><th>SSJS lines</th><th>Custom controls</th><th>Open</th></tr>');
    for (const x of d.xpages.concat(d.customControls)) {
      const total = Object.values(x.controlCounts).reduce((a, b) => a + b, 0);
      out.push(`<tr><td><a href="/design/${H.attr(dbName)}/${x.kind === 'xpage' ? 'xpage' : 'customcontrol'}/${H.attr(encodeURIComponent(x.name))}">${H.esc(x.name)}</a></td><td>${H.esc(x.pageTitle)}</td><td>${H.esc(x.dataSources.map((s) => `${s.type}:${s.formName || s.viewName || ''}`).join(', '))}</td><td align="right">${total}</td><td align="right">${x.inputs.length}</td><td align="right">${x.buttons.length}</td><td align="right">${x.ssjsLines}</td><td>${H.esc(x.customControls.join(', '))}</td><td>${x.kind === 'xpage' && xpageRoute(dbName, x.name) ? `<a href="${H.attr(xpageRoute(dbName, x.name))}">.xsp</a>` : ''}</td></tr>`);
    }
    out.push('</table>');

    out.push('<h3>ACL</h3>');
    out.push(`<p>Roles: ${d.acl.roles.map((r) => `<span class="roleChip">${H.esc(r)}</span>`).join(' ')}</p>`);
    out.push('<table class="dominoView" border="1" cellpadding="3" cellspacing="0"><tr><th>Entry</th><th>Type</th><th>Level</th><th>Roles</th><th>Flags</th></tr>');
    for (const e of d.acl.entries) {
      out.push(`<tr><td>${H.esc(e.name)}</td><td>${H.esc(e.type)}</td><td>${H.esc(e.level)}</td><td>${H.esc(e.roles.join(' '))}</td><td class="muted">${H.esc(e.flags.join(', '))}</td></tr>`);
    }
    out.push('</table>');
  }
  return render(ctx, { title: 'Design Inventory', db: null, appTitle: 'HAAS Design Catalog', content: out.join('\n'), current: 'design' });
});

function scheduleText(s) {
  if (!s) {
    return '';
  }
  return [s.type, s.hours ? `every ${s.hours}h` : '', s.time || s.startTime || '', s.days || '', s.runOn ? `on ${s.runOn}` : '']
    .filter(Boolean).join(' ');
}

function xpageRoute(dbName, name) {
  const map = {
    'heraldry.nsf': ['HeraldryHome', 'Request', 'ModifyRequest', 'StatusInquiry', 'SESFlag', 'VendorQueue', 'Login'],
    'vetmedals.nsf': ['CaseView', 'EngravingQueue', 'CSRLookup'],
  };
  if (!(map[dbName] || []).includes(name)) {
    return '';
  }
  return `/${dbName}/${name}.xsp`;
}

router.get((ctx) => /^\/design\/(heraldry\.nsf|vetmedals\.nsf)\/(form|view|agent|scriptlibrary|xpage|customcontrol)\/[^/]+$/.test(ctx.pathname), (ctx) => {
  const [dbName, kind, rawName] = ctx.pathname.split('/').slice(2);
  const name = cleanName(rawName);
  const d = ctx.app.designs[dbName];
  const list = { form: d.forms, view: d.views, agent: d.agents, scriptlibrary: d.scriptLibraries, xpage: d.xpages, customcontrol: d.customControls }[kind];
  const el = list.find((x) => x.name === name);
  if (!el) {
    throw new A.AppError('Design element not found', 404);
  }
  const file = path.join(ctx.app.repoRoot, 'nsf', dbName, el.file);
  const out = [`<p class="muted">${H.esc(dbName)} &middot; ${H.esc(kind)} &middot; <code>nsf/${H.esc(dbName)}/${H.esc(el.file)}</code></p>`];
  if (kind === 'form') {
    out.push('<table class="dominoView" border="1" cellpadding="3" cellspacing="0" width="100%"><tr><th>Field</th><th>Type</th><th>Kind</th><th>Keywords</th><th>Default</th><th>Input translation</th><th>Input validation</th><th>Value formula</th></tr>');
    for (const f of el.fields) {
      out.push(`<tr><td><b>${H.esc(f.name)}</b>${f.readers ? ' <span class="roleChip">Readers</span>' : ''}${f.authors ? ' <span class="roleChip">Authors</span>' : ''}</td><td>${H.esc(f.type)}${f.multivalue ? ' (multi)' : ''}</td><td>${H.esc(f.kind)}</td><td>${H.esc(f.keywords.join(' | '))}</td><td><code>${H.esc(f.defaultValue)}</code></td><td><code>${H.esc(f.inputTranslation)}</code></td><td><code>${H.esc(f.inputValidation)}</code></td><td><code>${H.esc(f.value)}</code></td></tr>`);
    }
    out.push('</table>');
    if (el.actions.length) {
      out.push('<h3>Action bar</h3><table class="dominoView" border="1" cellpadding="3" cellspacing="0"><tr><th>Action</th><th>Language</th><th>Hide-when</th><th>Code</th></tr>');
      for (const a of el.actions) {
        out.push(`<tr><td>${H.esc(a.title)}</td><td>${H.esc(a.language)}</td><td><code>${H.esc(a.hideWhen)}</code></td><td><pre class="code">${H.esc(a.click)}</pre></td></tr>`);
      }
      out.push('</table>');
    }
  } else if (kind === 'view') {
    out.push(`<p><b>Selection:</b> <code>${H.esc(el.selection)}</code></p>`);
    out.push('<table class="dominoView" border="1" cellpadding="3" cellspacing="0" width="100%"><tr><th>#</th><th>Item</th><th>Title</th><th>Width</th><th>Sort</th><th>Categorized</th><th>Responses only</th><th>Hidden</th><th>Formula</th></tr>');
    el.columns.forEach((c, i) => {
      out.push(`<tr><td>${i + 1}</td><td>${H.esc(c.itemName)}</td><td>${H.esc(c.title)}</td><td>${c.width}</td><td>${H.esc(c.sort)}</td><td>${c.categorized ? 'Yes' : ''}</td><td>${c.responsesOnly ? 'Yes' : ''}</td><td>${c.hidden ? 'Yes' : ''}</td><td><code>${H.esc(c.formula)}</code></td></tr>`);
    });
    out.push('</table>');
  }
  const src = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const srcFile = el.sourceFile ? path.join(ctx.app.repoRoot, 'nsf', dbName, el.sourceFile) : null;
  if (srcFile && fs.existsSync(srcFile)) {
    out.push(`<h3>Source: <code>${H.esc(el.sourceFile)}</code> (${el.linesOfCode} lines)</h3><pre class="code">${H.esc(fs.readFileSync(srcFile, 'utf8'))}</pre>`);
  }
  out.push(`<h3>Design element source</h3><pre class="code">${H.esc(src.length > 60000 ? `${src.slice(0, 60000)}\n... (truncated)` : src)}</pre>`);
  return render(ctx, { title: `${el.name} (${kind})`, db: dbName, appTitle: 'HAAS Design Catalog', content: out.join('\n'), current: 'design', breadcrumb: [{ label: 'Design', href: '/design' }, { label: el.name }] });
});

/* ---------------------------------------------------------------- Agents menu */

const RUNNABLE = {
  NightlyAging: { db: 'vetmedals.nsf', roles: ['[Admin]', '[TACOM]'], description: 'Recompute DaysOpen/DaysInStage and the 60/75-day AgingFlag on every open awards case.' },
  ImportAuthorizationFile: { db: 'vetmedals.nsf', roles: ['[Admin]', '[TACOM]', '[Importer]'], description: 'Parse an HRC fixed-width or NPRC pipe-delimited authorization file into AwardsCase / AwardLine / Requester documents.' },
  RebuildStatusInquiryIndex: { db: 'heraldry.nsf', roles: ['[Admin]', '[TACOM]'], description: 'Recompute StatusInquiryKey on every Request and SESFlagRequest.' },
  ArchiveClosedCases: { db: 'vetmedals.nsf', roles: ['[Admin]'], description: 'Report (dry run) which closed cases are past the archive threshold. The harness does not move documents to the archive replica.' },
};

function agentsPage(ctx, result) {
  const out = [];
  if (result) {
    out.push(`<div class="agentLog"><h2>Agent log: ${H.esc(result.agent)}</h2><pre class="code">${H.esc(result.log.join('\n'))}</pre>${result.links ? `<p>${result.links.map((l) => `<a href="${H.attr(l.href)}">${H.esc(l.label)}</a>`).join(' &middot; ')}</p>` : ''}</div>`);
  }
  out.push('<p>Equivalent of the Notes client <b>Actions</b> menu for agents that can run from the web. Scheduled agents are shown with their schedule; running them here executes the same logic against the harness data store and writes an entry to the audit log.</p>');
  for (const [dbName, d] of Object.entries(ctx.app.designs)) {
    out.push(`<h3>${H.esc(dbName)}</h3><table class="dominoView" border="1" cellpadding="4" cellspacing="0" width="100%"><tr><th>Agent</th><th>Trigger</th><th>Schedule</th><th>Purpose</th><th>Run</th></tr>`);
    for (const a of d.agents) {
      const r = RUNNABLE[a.name];
      let cell = '<span class="muted">runs from a document action / on save</span>';
      if (r) {
        const allowed = hasRole(ctx.user, ...r.roles);
        if (a.name === 'ImportAuthorizationFile') {
          const samples = fs.existsSync(SAMPLE_DIR) ? fs.readdirSync(SAMPLE_DIR).filter((f) => /\.(txt|dat)$/i.test(f)).sort() : [];
          cell = `<form method="post" action="/agents/run" enctype="multipart/form-data" class="agentForm">
<input type="hidden" name="agent" value="ImportAuthorizationFile">
<label>Sample file: ${H.select('sample', samples, '', { blank: '(none - upload below)' })}</label><br>
<label>Upload: <input type="file" name="upload" accept=".txt,.dat" class="xspFileUpload"></label><br>
<label><input type="checkbox" name="force" value="1"> Re-import even if already imported</label><br>
${H.button('Run ImportAuthorizationFile', { className: allowed ? 'xspButtonCommand' : 'xspButtonCommand disabled' })}
${allowed ? '' : `<div class="muted">Requires ${H.esc(r.roles.join(' or '))}</div>`}</form>`;
        } else {
          cell = `<form method="post" action="/agents/run" class="inlineForm"><input type="hidden" name="agent" value="${H.attr(a.name)}">${H.button(`Run ${a.name}`, { className: allowed ? 'xspButtonCommand' : 'xspButtonCommand disabled' })}${allowed ? '' : `<div class="muted">Requires ${H.esc(r.roles.join(' or '))}</div>`}</form>`;
        }
      }
      out.push(`<tr><td><a href="/design/${H.attr(dbName)}/agent/${H.attr(encodeURIComponent(a.name))}"><b>${H.esc(a.name)}</b></a><br><span class="muted">${H.esc(a.language)} &middot; ${a.linesOfCode} LoC</span></td><td>${H.esc(a.trigger)}</td><td>${H.esc(scheduleText(a.schedule))}</td><td>${H.esc(r ? r.description : a.comment)}</td><td>${cell}</td></tr>`);
    }
    out.push('</table>');
    const p = ctx.app.store.db(dbName).profile();
    if (p && (p.items.AgingLastRun || p.items.ImportLastRun)) {
      out.push(`<p class="muted">Profile: AgingLastRun=${H.esc(H.fmtValue(p.items.AgingLastRun || ''))} &middot; ImportLastRun=${H.esc(H.fmtValue(p.items.ImportLastRun || ''))} &middot; ArchiveLastRun=${H.esc(H.fmtValue(p.items.ArchiveLastRun || ''))}</p>`);
    }
  }
  return render(ctx, { title: 'Agents', db: null, appTitle: 'HAAS Agents', content: out.join('\n'), current: 'agents' });
}

router.get((ctx) => ctx.pathname === '/agents', (ctx) => agentsPage(ctx, null));

router.post((ctx) => ctx.pathname === '/agents/run', (ctx) => {
  const agent = cleanName(ctx.body.agent);
  const spec = RUNNABLE[agent];
  if (!spec) {
    throw new A.AppError('That agent cannot be run from the web', 400);
  }
  requireRole(ctx, ...spec.roles);
  const db = ctx.app.store.db(spec.db);
  const actx = { design: ctx.app.designs[spec.db], db, engine: ctx.app.engines[spec.db], user: ctx.user, now: ctx.now };
  const links = [];
  let log = [];
  let summary = {};
  if (agent === 'NightlyAging') {
    const r = A.nightlyAging(actx);
    log = r.log.concat(r.redList.length ? ['', 'Red cases (first 200):', ...r.redList] : []);
    summary = r.stats;
    links.push({ label: 'Open AgingCases view', href: '/vetmedals.nsf/AgingCases?OpenView' });
  } else if (agent === 'ImportAuthorizationFile') {
    let fileName;
    let content;
    const upload = ctx.body.upload;
    if (upload && typeof upload === 'object' && upload.size > 0) {
      fileName = upload.filename;
      content = upload.content;
    } else {
      const sample = cleanText(ctx.body.sample, 80);
      if (!/^[A-Za-z0-9_.-]+\.(txt|dat)$/i.test(sample)) {
        throw new A.AppError('Choose a sample authorization file or upload one.', 400);
      }
      const full = path.join(SAMPLE_DIR, sample);
      if (!fs.existsSync(full)) {
        throw new A.AppError('Sample file not found', 404);
      }
      fileName = sample;
      content = fs.readFileSync(full, 'utf8');
    }
    const r = A.importAuthorizationFile(actx, fileName, content, { force: ctx.body.force === '1' });
    log = r.log;
    summary = { status: r.status, cases: r.cases, lines: r.lines, rejected: r.rejected, requestersNew: r.requestersNew, requestersMatched: r.requestersMatched };
    links.push({ label: 'Open the AuthorizationFile document', href: `/vetmedals.nsf/0/${r.authDoc.unid}?OpenDocument` });
    links.push({ label: 'Cases by Stage', href: '/vetmedals.nsf/CasesByStage?OpenView' });
    if (r.created && r.created.length) {
      const first = r.created.find((d) => d.form === 'AwardsCase');
      if (first) {
        links.push({ label: `Open case ${first.items.CaseNumber}`, href: `/vetmedals.nsf/CaseView.xsp?documentId=${first.unid}` });
      }
    }
  } else if (agent === 'RebuildStatusInquiryIndex') {
    let n = 0;
    for (const doc of db.all('Request').concat(db.all('SESFlagRequest'))) {
      const num = A.text(doc, 'DocumentNumber') || A.text(doc, 'SESFlagNumber');
      const key = `${num.toUpperCase()}|${A.text(doc, 'DODAAC').toUpperCase()}|${A.text(doc, 'UIC').toUpperCase()}`;
      if (doc.items.StatusInquiryKey !== key) {
        db.update(doc, { StatusInquiryKey: key }, { user: 'CN=HAAS-APP01/O=TACOM', clock: () => ctx.now });
        n += 1;
      }
    }
    log = [`RebuildStatusInquiryIndex: ${db.all('Request').length + db.all('SESFlagRequest').length} documents scanned, ${n} keys rewritten`, 'View index (StatusInquiry) rebuilt (harness: view rows are recomputed on next open)'];
    summary = { rewritten: n };
    links.push({ label: 'StatusInquiry view', href: '/heraldry.nsf/StatusInquiry?OpenView' });
  } else if (agent === 'ArchiveClosedCases') {
    const days = Number(db.profileValue('ArchiveAfterDays', 730));
    const eligible = db.all('AwardsCase').filter((d) => A.text(d, 'Stage') === 'Closed' && (A.daysBetween(A.text(d, 'ClosedDate'), ctx.now) || 0) > days);
    log = [`ArchiveClosedCases (dry run): ${eligible.length} closed cases older than ${days} days would be copied to ${db.profileValue('ArchiveDbPath', 'haas/vetmedals-archive.nsf')} and stamped $Archived.`, 'The harness never moves documents; the LotusScript agent does.'];
    summary = { eligible: eligible.length };
  }
  ctx.app.audit.write('agent_run', { user: ctx.user.name, ip: ctx.ip, agent, db: spec.db, ...summary });
  return agentsPage(ctx, { agent, log, links });
});

/* ---------------------------------------------------------------- /audit */

router.get((ctx) => ctx.pathname === '/audit', (ctx) => {
  requireRole(ctx, '[Admin]', '[TACOM]', '[ReadOnlyAudit]');
  const entries = ctx.app.audit.tail(200).reverse();
  const out = ['<p>Last 200 entries of <code>harness/logs/audit.jsonl</code> (newest first). Every create, modify, cancel, release, stage change, agent run, login and authorization failure is recorded as one JSON line.</p>'];
  out.push('<table class="dominoView" border="1" cellpadding="3" cellspacing="0" width="100%"><tr><th>Timestamp</th><th>Event</th><th>User</th><th>Details</th></tr>');
  for (const e of entries) {
    const { timestamp, event, user, ...rest } = e;
    out.push(`<tr><td nowrap>${H.esc(timestamp)}</td><td>${H.esc(event)}</td><td>${H.esc(user || '')}</td><td><code>${H.esc(JSON.stringify(rest))}</code></td></tr>`);
  }
  out.push('</table>');
  return render(ctx, { title: 'Audit Log', db: null, appTitle: 'HAAS Audit', content: out.join('\n'), current: 'audit' });
});

module.exports = { dispatch: (ctx) => router.dispatch(ctx), commonNav, render, RUNNABLE };
