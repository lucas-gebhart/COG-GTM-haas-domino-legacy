'use strict';

/**
 * DXL readers for the two kinds of artifact a migration team receives from a Domino
 * shop:
 *
 *   1. design elements exported per note (nsf/<db>/forms/*.dxl, views/*.dxl, agents/*.dxl ...)
 *   2. the document (data) export (export/dxl/<db>-documents.dxl)
 *
 * Everything here is a pure function of the XML; there is no Domino runtime.
 */

const fs = require('node:fs');
const path = require('node:path');
const xml = require('./xml');

// --- Domino datetime -------------------------------------------------------------------------

/**
 * Parse a DXL datetime ("20260901T063000,00-05", "20260901" or a legacy free-text
 * "07/04/2019") into an ISO-8601 string, or return the raw text if it does not parse.
 * Legacy exports genuinely contain mixed formats, so callers must tolerate a string.
 */
function parseDxlDateTime(raw) {
  const s = String(raw || '').trim();
  let m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(?:,(\d{2}))?)?(?:([+-])(\d{2})(?::?(\d{2}))?)?$/.exec(s);
  if (m) {
    const [, y, mo, d, h, mi, se, , sign, tzh, tzm] = m;
    if (h === undefined) {
      return `${y}-${mo}-${d}`;
    }
    const off = sign ? `${sign}${tzh}:${tzm || '00'}` : 'Z';
    return `${y}-${mo}-${d}T${h}:${mi}:${se}${off}`;
  }
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) {
    return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(s);
  if (m) {
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const idx = months.indexOf(m[2].toLowerCase());
    if (idx >= 0) {
      return `${m[3]}-${String(idx + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    }
  }
  return s;
}

// --- Documents --------------------------------------------------------------------------------

function itemValue(itemEl) {
  const valueEl = xml.children(itemEl)[0];
  if (!valueEl) {
    return '';
  }
  switch (valueEl.name) {
    case 'text':
      return xml.text(valueEl);
    case 'number':
      return Number(xml.text(valueEl));
    case 'datetime':
      return parseDxlDateTime(xml.text(valueEl));
    case 'textlist':
      return xml.children(valueEl, 'text').map((t) => xml.text(t));
    case 'numberlist':
      return xml.children(valueEl, 'number').map((t) => Number(xml.text(t)));
    case 'datetimelist':
      return xml.children(valueEl, 'datetime').map((t) => parseDxlDateTime(xml.text(t)));
    case 'richtext':
      return xml.text(valueEl);
    default:
      return xml.text(valueEl);
  }
}

/**
 * Convert one <document> element into the harness document shape:
 * { unid, noteid, form, parent, created, modified, items: {name: value}, readers: [...],
 *   authors: [...], files: [{name,size}], updatedBy: [...], revisions: [...] }
 */
function documentFromElement(docEl) {
  const noteinfo = xml.child(docEl, 'noteinfo');
  const doc = {
    unid: noteinfo ? noteinfo.attrs.unid : '',
    noteid: noteinfo ? noteinfo.attrs.noteid : '',
    sequence: noteinfo ? Number(noteinfo.attrs.sequence || 1) : 1,
    form: docEl.attrs.form || '',
    parent: docEl.attrs.parent || '',
    created: noteinfo ? parseDxlDateTime(xml.text(xml.child(xml.child(noteinfo, 'created'), 'datetime'))) : '',
    modified: noteinfo ? parseDxlDateTime(xml.text(xml.child(xml.child(noteinfo, 'modified'), 'datetime'))) : '',
    items: {},
    readers: [],
    authors: [],
    files: [],
    updatedBy: [],
    revisions: [],
  };
  for (const item of xml.children(docEl, 'item')) {
    const name = item.attrs.name;
    if (name === '$FILE') {
      const fileEl = xml.descendants(item, 'file')[0];
      if (fileEl) {
        doc.files.push({ name: fileEl.attrs.name, size: Number(fileEl.attrs.size || 0) });
      }
      continue;
    }
    const value = itemValue(item);
    if (name === '$UpdatedBy') {
      doc.updatedBy = Array.isArray(value) ? value : [value];
      continue;
    }
    if (name === '$Revisions') {
      doc.revisions = Array.isArray(value) ? value : [value];
      continue;
    }
    doc.items[name] = value;
    if (item.attrs.readers === 'true') {
      doc.readers = doc.readers.concat(Array.isArray(value) ? value : [value]);
    }
    if (item.attrs.authors === 'true') {
      doc.authors = doc.authors.concat(Array.isArray(value) ? value : [value]);
    }
  }
  if (!doc.form && doc.items.Form) {
    doc.form = String(doc.items.Form);
  }
  return doc;
}

/** Parse a document export file (or XML string). Returns { database: {...attrs}, documents: [...] }. */
function parseDocumentExport(source) {
  const content = source.indexOf('<') === -1 ? fs.readFileSync(source, 'utf8') : source;
  const root = xml.rootElement(xml.parse(content));
  if (!root || root.name !== 'database') {
    throw new Error('DXL document export must have a <database> root element');
  }
  return {
    database: { ...root.attrs },
    documents: xml.children(root, 'document').map(documentFromElement),
  };
}

// --- Design elements --------------------------------------------------------------------------

function codeEvents(el) {
  const events = {};
  for (const code of xml.children(el, 'code')) {
    const ev = code.attrs.event;
    const body = xml.children(code)[0];
    if (!ev || !body) {
      continue;
    }
    events[ev] = { language: body.name, source: xml.text(body).trim() };
  }
  return events;
}

function parseField(fieldEl) {
  const events = codeEvents(fieldEl);
  const keywords = xml.child(fieldEl, 'keywords');
  const field = {
    name: fieldEl.attrs.name,
    type: fieldEl.attrs.type,
    kind: fieldEl.attrs.kind,
    description: fieldEl.attrs.description || '',
    multivalue: fieldEl.attrs.allowmultivalues === 'true',
    readers: fieldEl.attrs.readers === 'true',
    authors: fieldEl.attrs.authors === 'true',
    allowNew: fieldEl.attrs.allownew === 'true',
    keywords: keywords ? xml.descendants(keywords, 'text').map((t) => xml.text(t)) : [],
    keywordUi: keywords ? keywords.attrs.ui || '' : '',
    defaultValue: events.defaultvalue ? events.defaultvalue.source : '',
    inputTranslation: events.inputtranslation ? events.inputtranslation.source : '',
    inputValidation: events.inputvalidation ? events.inputvalidation.source : '',
    value: events.value ? events.value.source : '',
    hideWhen: events.hidewhen ? events.hidewhen.source : '',
  };
  return field;
}

function parseActions(el) {
  const bar = xml.child(el, 'actionbar');
  if (!bar) {
    return [];
  }
  return xml.children(bar, 'action').map((a) => {
    const ev = codeEvents(a);
    return {
      title: a.attrs.title,
      hide: a.attrs.hide || '',
      hideWhen: ev.hidewhen ? ev.hidewhen.source : '',
      click: ev.click ? ev.click.source : '',
      language: ev.click ? ev.click.language : '',
    };
  });
}

function parseForm(content, fileName) {
  const root = xml.rootElement(xml.parse(content));
  const isSubform = root.name === 'subform';
  const fields = xml.descendants(root, 'field').map(parseField);
  const events = codeEvents(root);
  const globals = xml.child(root, 'globals');
  const lssLines = xml.descendants(root, 'lotusscript').reduce((n, ls) => n + xml.text(ls).split('\n').length, 0);
  return {
    kind: isSubform ? 'subform' : 'form',
    file: fileName,
    name: root.attrs.name,
    alias: root.attrs.alias || '',
    aliases: (root.attrs.alias || '').split('|').filter(Boolean),
    default: root.attrs.default === 'true',
    fields,
    subformRefs: xml.descendants(root, 'subformref').map((s) => s.attrs.name),
    actions: parseActions(root),
    events: Object.keys(events),
    windowTitle: events.windowtitle ? events.windowtitle.source : '',
    hideWhens: xml.descendants(root, 'code').filter((c) => c.attrs.event === 'hidewhen').length,
    hasGlobals: Boolean(globals),
    lotusScriptLines: lssLines,
    tables: xml.descendants(root, 'table').length,
    readersFields: fields.filter((f) => f.readers).map((f) => f.name),
    authorsFields: fields.filter((f) => f.authors).map((f) => f.name),
  };
}

function parseView(content, fileName) {
  const root = xml.rootElement(xml.parse(content));
  const events = codeEvents(root);
  const columns = xml.children(root, 'column').map((c) => {
    const ev = codeEvents(c);
    const header = xml.child(c, 'columnheader');
    const dt = xml.child(c, 'datetimeformat');
    return {
      itemName: c.attrs.itemname || '',
      title: header ? header.attrs.title || '' : '',
      width: Number(c.attrs.width || 10),
      sort: c.attrs.sort || '',
      categorized: c.attrs.categorized === 'true',
      twisties: c.attrs.twisties === 'true',
      responsesOnly: c.attrs.responsesonly === 'true',
      hidden: c.attrs.hidden === 'true',
      align: c.attrs.align || 'left',
      totals: c.attrs.totals || '',
      formula: ev.value ? ev.value.source : c.attrs.itemname || '',
      dateFormat: dt ? { show: dt.attrs.show || 'datetime', date: dt.attrs.date || '', time: dt.attrs.time || '' } : null,
    };
  });
  return {
    kind: root.name === 'folder' ? 'folder' : 'view',
    file: fileName,
    name: root.attrs.name,
    alias: root.attrs.alias || '',
    aliases: (root.attrs.alias || '').split('|').filter(Boolean),
    hidden: /^\(.*\)$/.test(root.attrs.name || ''),
    default: root.attrs.default === 'true',
    showResponseHierarchy: root.attrs.showresponsehierarchy === 'true',
    selection: events.selection ? events.selection.source : 'SELECT @All',
    columns,
    actions: parseActions(root),
    events: Object.keys(events),
    comment: xml.children(root, 'item').filter((i) => i.attrs.name === '$Comment').map((i) => xml.text(i).trim())[0] || '',
  };
}

function parseAgentDxl(content, fileName) {
  const root = xml.rootElement(xml.parse(content));
  const trigger = xml.child(root, 'trigger');
  const schedule = trigger ? xml.child(trigger, 'schedule') : null;
  const docset = xml.child(root, 'documentset');
  const items = {};
  for (const item of xml.children(root, 'item')) {
    items[item.attrs.name] = xml.text(item).trim();
  }
  const languages = new Set(xml.descendants(root, 'code').map((c) => (xml.children(c)[0] || {}).name).filter(Boolean));
  return {
    kind: 'agent',
    file: fileName,
    name: root.attrs.name,
    alias: root.attrs.alias || '',
    enabled: root.attrs.enabled !== 'false',
    runAsWeb: root.attrs.runasweb === 'true',
    trigger: trigger ? trigger.attrs.type : 'manual',
    schedule: schedule
      ? {
          type: schedule.attrs.type,
          hours: schedule.attrs.hours || '',
          dayOfWeek: schedule.attrs.dayofweek || '',
          onWeekends: schedule.attrs.onweekends === 'true',
          runServer: schedule.attrs.runserver || '',
          startTime: xml.child(schedule, 'starttime') ? xml.text(xml.child(schedule, 'starttime')).trim() : '',
        }
      : null,
    documentSet: docset ? docset.attrs.type : '',
    comment: items.$Comment || '',
    languages: [...languages],
  };
}

function parseAcl(content) {
  const root = xml.rootElement(xml.parse(content));
  return {
    roles: xml.children(root, 'role').map((r) => r.attrs.name),
    entries: xml.children(root, 'aclentry').map((e) => ({
      name: e.attrs.name,
      type: e.attrs.type || 'unspecified',
      level: e.attrs.level,
      roles: xml.children(e, 'role').map((r) => r.attrs.name),
      flags: Object.keys(e.attrs).filter((k) => e.attrs[k] === 'true' && !['name', 'type', 'level'].includes(k)),
    })),
    consistent: root.attrs.consistentacl === 'true',
    adminServer: root.attrs.adminserver || '',
    maxInternetAccess: root.attrs.maxinternetaccess || '',
    log: xml.children(root, 'logentry').length,
  };
}

function parseDatabaseProperties(content) {
  const root = xml.rootElement(xml.parse(content));
  const info = xml.child(root, 'databaseinfo');
  const items = {};
  for (const item of xml.children(root, 'item')) {
    items[item.attrs.name] = itemValue(item);
  }
  return {
    title: root.attrs.title || '',
    path: root.attrs.path || '',
    replicaId: root.attrs.replicaid || '',
    template: root.attrs.fromtemplate || '',
    designerVersion: root.attrs.designerversion || '',
    inheritDesign: root.attrs.inheritdesignfromtemplate === 'true',
    odsVersion: info ? info.attrs.odsversion : '',
    numberOfDocuments: info ? Number(info.attrs.numberofdocuments || 0) : 0,
    created: info ? parseDxlDateTime(info.attrs.created) : '',
    designModified: info ? parseDxlDateTime(info.attrs.designmodified) : '',
    category: info ? info.attrs.category || '' : '',
    items,
  };
}

function countLines(text) {
  if (!text) {
    return 0;
  }
  return text.split(/\r?\n/).filter((l) => l.trim() !== '').length;
}

function readIfExists(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

function listFiles(dir, ext) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(ext))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Read a whole nsf/<db>/ design tree. Returns
 * { name, properties, acl, forms, subforms, views, agents, scriptLibraries, xpages, customControls, config }
 * XPages are parsed by ./xsp.js; this function only gathers them.
 */
function loadDesign(nsfDir) {
  const xsp = require('./xsp');
  const name = path.basename(nsfDir);
  const propsText = readIfExists(path.join(nsfDir, 'database.properties.dxl'));
  const aclText = readIfExists(path.join(nsfDir, 'acl.dxl'));
  const forms = [];
  const subforms = [];
  for (const f of listFiles(path.join(nsfDir, 'forms'), '.dxl')) {
    const parsed = parseForm(fs.readFileSync(path.join(nsfDir, 'forms', f), 'utf8'), `forms/${f}`);
    (parsed.kind === 'subform' ? subforms : forms).push(parsed);
  }
  const views = listFiles(path.join(nsfDir, 'views'), '.dxl').map((f) =>
    parseView(fs.readFileSync(path.join(nsfDir, 'views', f), 'utf8'), `views/${f}`),
  );
  const agents = listFiles(path.join(nsfDir, 'agents'), '.dxl').map((f) => {
    const agent = parseAgentDxl(fs.readFileSync(path.join(nsfDir, 'agents', f), 'utf8'), `agents/${f}`);
    const lssPath = path.join(nsfDir, 'agents', f.replace(/\.dxl$/i, '.lss'));
    const lss = readIfExists(lssPath);
    agent.sourceFile = lss !== null ? `agents/${path.basename(lssPath)}` : '';
    agent.language = lss !== null ? 'LotusScript' : agent.languages.includes('formula') ? 'Formula' : agent.languages.join('/') || 'LotusScript';
    agent.linesOfCode = countLines(lss);
    return agent;
  });
  const scriptLibraries = [];
  for (const f of listFiles(path.join(nsfDir, 'scriptlibs'), '.lss').concat(listFiles(path.join(nsfDir, 'scriptlibs'), '.jss'))) {
    const src = fs.readFileSync(path.join(nsfDir, 'scriptlibs', f), 'utf8');
    scriptLibraries.push({
      kind: 'scriptlibrary',
      file: `scriptlibs/${f}`,
      name: f.replace(/\.(lss|jss)$/i, ''),
      language: f.toLowerCase().endsWith('.jss') ? 'Server JavaScript' : 'LotusScript',
      linesOfCode: countLines(src),
      routines: (src.match(/^\s*(?:Public\s+|Private\s+)?(?:Sub|Function)\s+\w+/gim) || []).length + (src.match(/^\s*(\w+)\s*:\s*function\s*\(/gm) || []).length,
    });
  }
  const xpages = listFiles(path.join(nsfDir, 'xpages'), '.xsp').map((f) =>
    xsp.parseXsp(fs.readFileSync(path.join(nsfDir, 'xpages', f), 'utf8'), `xpages/${f}`),
  );
  const customControls = listFiles(path.join(nsfDir, 'customcontrols'), '.xsp').map((f) =>
    xsp.parseXsp(fs.readFileSync(path.join(nsfDir, 'customcontrols', f), 'utf8'), `customcontrols/${f}`),
  );
  const config = {};
  for (const f of ['xsp.properties', 'faces-config.xml']) {
    const t = readIfExists(path.join(nsfDir, f));
    if (t !== null) {
      config[f] = { lines: countLines(t) };
    }
  }
  const formulas = listFiles(path.join(nsfDir, 'formulas'), '.md').map((f) => `formulas/${f}`);
  return {
    name,
    dir: nsfDir,
    properties: propsText ? parseDatabaseProperties(propsText) : null,
    acl: aclText ? parseAcl(aclText) : null,
    forms,
    subforms,
    views,
    agents,
    scriptLibraries,
    xpages,
    customControls,
    config,
    formulas,
  };
}

/** Find a form by name or alias (case-insensitive, like Domino). */
function findForm(design, name) {
  const key = String(name || '').toLowerCase();
  return design.forms.find((f) => f.name.toLowerCase() === key || f.aliases.some((a) => a.toLowerCase() === key)) || null;
}

function findView(design, name) {
  const key = String(name || '').toLowerCase();
  return design.views.find((v) => v.name.toLowerCase() === key || v.aliases.some((a) => a.toLowerCase() === key)) || null;
}

module.exports = {
  parseDxlDateTime,
  parseDocumentExport,
  documentFromElement,
  parseForm,
  parseView,
  parseAgentDxl,
  parseAcl,
  parseDatabaseProperties,
  loadDesign,
  findForm,
  findView,
  countLines,
};
