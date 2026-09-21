'use strict';

/**
 * Design inventory generator.
 *
 * Loads every nsf/<db>/ design tree with harness/lib/dxl.js and writes
 * docs/DESIGN-INVENTORY.md — a deterministic Markdown census of forms, fields, views,
 * columns, agents, script libraries, XPages and custom controls, with per-database and
 * cross-database totals. Every number in the document is derived from the parsed design.
 *
 *   node tools/inventory.js          regenerate docs/DESIGN-INVENTORY.md
 *   node tools/inventory.js --check  exit 1 (with a diff summary) if the file on disk is stale
 */

const fs = require('node:fs');
const path = require('node:path');
const { loadDesign } = require('../harness/lib/dxl');

const OUTPUT_FILE = path.join('docs', 'DESIGN-INVENTORY.md');
const FORMULA_MAX = 160;
const COMPUTED_KINDS = new Set(['computed', 'computedfordisplay', 'computedwhencomposed']);

const TOTAL_ROWS = [
  ['Forms', 'forms'],
  ['Subforms', 'subforms'],
  ['Fields', 'fields'],
  ['Validation formulas', 'validations'],
  ['Translation formulas', 'translations'],
  ['Computed fields', 'computedFields'],
  ['Keyword fields', 'keywordFields'],
  ['Readers fields', 'readersFields'],
  ['Authors fields', 'authorsFields'],
  ['Views', 'views'],
  ['Hidden views', 'hiddenViews'],
  ['Columns', 'columns'],
  ['Categorized columns', 'categorizedColumns'],
  ['Agents', 'agents'],
  ['Scheduled agents', 'scheduledAgents'],
  ['Agent LoC', 'agentLoc'],
  ['Script libraries', 'scriptLibraries'],
  ['Library LoC', 'libraryLoc'],
  ['XPages', 'xpages'],
  ['Custom controls', 'customControls'],
  ['XPage controls', 'xpageControls'],
  ['SSJS lines', 'ssjsLines'],
];

// --- helpers ------------------------------------------------------------------------------

function byName(a, b) {
  return a.name.localeCompare(b.name, 'en');
}

function sum(items, pick) {
  return items.reduce((n, item) => n + pick(item), 0);
}

function cell(text) {
  return String(text === undefined || text === null ? '' : text)
    .replace(/\|/g, '\\|')
    .replace(/[\r\n\t]+/g, ' ')
    .trim();
}

function collapse(source) {
  return String(source || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\t/g, ' ')
    .replace(/ {2,}/g, ' ');
}

function code(source, max = FORMULA_MAX) {
  let s = collapse(source);
  if (!s) {
    return '';
  }
  if (s.length > max) {
    s = `${s.slice(0, max).trimEnd()}…`;
  }
  return `\`${s.replace(/`/g, "'")}\``;
}

function yesNo(value) {
  return value ? 'yes' : 'no';
}

function list(values, empty = '—') {
  const arr = (values || []).filter((v) => v !== undefined && v !== null && String(v) !== '');
  return arr.length ? cell(arr.join(', ')) : empty;
}

function table(headers, rows) {
  const out = [`| ${headers.map(cell).join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`];
  for (const row of rows) {
    out.push(`| ${row.map((v) => cell(v) || '—').join(' | ')} |`);
  }
  return out.join('\n');
}

function scheduleText(agent) {
  const s = agent.schedule;
  if (agent.trigger === 'actionsmenu') {
    return `actions menu / ${agent.documentSet === 'selected' ? 'selected documents' : agent.documentSet || 'all documents'}`;
  }
  if (!s) {
    return agent.trigger || 'manual';
  }
  const server = s.runServer ? ` on ${s.runServer}` : '';
  const at = formatTime(s.startTime);
  switch (s.type) {
    case 'daily':
      return `daily${at ? ` ${at}` : ''}${server}`;
    case 'weekly':
      return `weekly ${s.dayOfWeek || ''}${at ? ` ${at}` : ''}${server}`.replace(/ {2,}/g, ' ');
    case 'monthly':
      return `monthly${at ? ` ${at}` : ''}${server}`;
    case 'byminutes':
      return `every ${s.hours || '?'} minutes${server}`;
    case 'newmodified':
    case 'new_modified':
      return `on new or modified documents${server}`;
    default:
      return `${s.type}${at ? ` ${at}` : ''}${server}`;
  }
}

function formatTime(raw) {
  const s = String(raw || '').trim();
  let m = /^T?(\d{2})(\d{2})(\d{2})/.exec(s);
  if (m) {
    return `${m[1]}:${m[2]}`;
  }
  m = /^(\d{1,2}):(\d{2})/.exec(s);
  if (m) {
    return `${m[1].padStart(2, '0')}:${m[2]}`;
  }
  return s;
}

function documentSetText(agent) {
  const ds = String(agent.documentSet || '').toLowerCase();
  if (ds === 'new_modified' || ds === 'newmodified') {
    return 'new or modified documents';
  }
  if (ds === 'selected') {
    return 'selected documents';
  }
  if (ds === 'all') {
    return 'all documents';
  }
  return agent.documentSet || '—';
}

function dataSourceText(ds) {
  if (ds.type === 'dominoDocument') {
    return `dominoDocument:${ds.formName || ds.var}`;
  }
  if (ds.type === 'dominoView') {
    return `dominoView:${ds.viewName || ds.var}`;
  }
  return `${ds.type}:${ds.var}`;
}

// --- data model ---------------------------------------------------------------------------

function fieldStats(fields) {
  return {
    fields: fields.length,
    editable: fields.filter((f) => f.kind === 'editable').length,
    computed: fields.filter((f) => COMPUTED_KINDS.has(f.kind)).length,
    keyword: fields.filter((f) => f.type === 'keyword' || f.keywords.length > 0).length,
    validations: fields.filter((f) => f.inputValidation).length,
    translations: fields.filter((f) => f.inputTranslation).length,
    readers: fields.filter((f) => f.readers).map((f) => f.name),
    authors: fields.filter((f) => f.authors).map((f) => f.name),
    allowNew: fields.filter((f) => f.allowNew).map((f) => f.name),
  };
}

function formModel(form) {
  const fields = form.fields.map((f) => ({
    name: f.name,
    type: f.type,
    kind: f.kind,
    description: f.description,
    keywords: f.keywords.slice(),
    keywordUi: f.keywordUi,
    allowNew: f.allowNew,
    multivalue: f.multivalue,
    readers: f.readers,
    authors: f.authors,
    defaultValue: f.defaultValue,
    inputTranslation: f.inputTranslation,
    inputValidation: f.inputValidation,
    value: f.value,
  }));
  return {
    name: form.name,
    kind: form.kind,
    file: form.file,
    aliases: form.aliases.slice(),
    windowTitle: form.windowTitle,
    fields,
    stats: fieldStats(fields),
    actions: form.actions.length,
    subformRefs: form.subformRefs.slice(),
    lotusScriptLines: form.lotusScriptLines,
  };
}

function viewModel(view) {
  return {
    name: view.name,
    file: view.file,
    aliases: view.aliases.slice(),
    hidden: view.hidden,
    showResponseHierarchy: view.showResponseHierarchy,
    selection: view.selection,
    comment: view.comment,
    actions: view.actions.length,
    columns: view.columns.map((c) => ({
      itemName: c.itemName,
      title: c.title,
      formula: c.formula,
      sort: c.sort,
      categorized: c.categorized,
      responsesOnly: c.responsesOnly,
      hidden: c.hidden,
    })),
    categorizedColumns: view.columns.filter((c) => c.categorized).length,
  };
}

function agentModel(agent) {
  return {
    name: agent.name,
    trigger: agent.trigger,
    schedule: agent.schedule ? { ...agent.schedule } : null,
    scheduleText: scheduleText(agent),
    documentSet: documentSetText(agent),
    language: agent.language,
    linesOfCode: agent.linesOfCode,
    sourceFile: agent.sourceFile,
    comment: agent.comment,
    scheduled: agent.trigger === 'scheduled',
  };
}

function libraryModel(lib) {
  return { name: lib.name, language: lib.language, linesOfCode: lib.linesOfCode, routines: lib.routines, file: lib.file };
}

function xspModel(page) {
  return {
    name: page.name,
    kind: page.kind,
    file: page.file,
    pageTitle: page.pageTitle,
    dataSources: page.dataSources.map(dataSourceText),
    controls: page.controls,
    controlCounts: { ...page.controlCounts },
    inputs: page.inputs.length,
    buttons: page.buttons.length,
    ssjsBlocks: page.ssjsBlocks,
    ssjsLines: page.ssjsLines,
    lines: page.lines,
    customControls: page.customControls.slice(),
  };
}

function databaseTotals(db) {
  const allFields = db.forms.concat(db.subforms).flatMap((f) => f.fields);
  return {
    forms: db.forms.length,
    subforms: db.subforms.length,
    fields: allFields.length,
    validations: allFields.filter((f) => f.inputValidation).length,
    translations: allFields.filter((f) => f.inputTranslation).length,
    computedFields: allFields.filter((f) => COMPUTED_KINDS.has(f.kind)).length,
    keywordFields: allFields.filter((f) => f.type === 'keyword' || f.keywords.length > 0).length,
    readersFields: allFields.filter((f) => f.readers).length,
    authorsFields: allFields.filter((f) => f.authors).length,
    views: db.views.length,
    hiddenViews: db.views.filter((v) => v.hidden).length,
    columns: sum(db.views, (v) => v.columns.length),
    categorizedColumns: sum(db.views, (v) => v.categorizedColumns),
    agents: db.agents.length,
    scheduledAgents: db.agents.filter((a) => a.scheduled).length,
    agentLoc: sum(db.agents, (a) => a.linesOfCode),
    scriptLibraries: db.scriptLibraries.length,
    libraryLoc: sum(db.scriptLibraries, (l) => l.linesOfCode),
    xpages: db.xpages.length,
    customControls: db.customControls.length,
    xpageControls: sum(db.xpages.concat(db.customControls), (p) => p.controls),
    ssjsLines: sum(db.xpages.concat(db.customControls), (p) => p.ssjsLines),
  };
}

function databaseModel(design) {
  const p = design.properties || {};
  const acl = design.acl || { roles: [], entries: [] };
  const db = {
    name: design.name,
    dir: path.relative(process.cwd(), design.dir).split(path.sep).join('/'),
    properties: {
      title: p.title || '',
      path: p.path || '',
      replicaId: p.replicaId || '',
      odsVersion: p.odsVersion || '',
      inheritDesign: Boolean(p.inheritDesign),
      template: p.template || '',
      designModified: p.designModified || '',
      category: p.category || '',
      designerVersion: p.designerVersion || '',
    },
    acl: {
      roles: acl.roles.slice(),
      entries: acl.entries.map((e) => ({ name: e.name, type: e.type, level: e.level, roles: e.roles.slice(), flags: e.flags.slice() })),
    },
    forms: design.forms.map(formModel).sort(byName),
    subforms: design.subforms.map(formModel).sort(byName),
    views: design.views.map(viewModel).sort(byName),
    agents: design.agents.map(agentModel).sort(byName),
    scriptLibraries: design.scriptLibraries.map(libraryModel).sort(byName),
    xpages: design.xpages.map(xspModel).sort(byName),
    customControls: design.customControls.map(xspModel).sort(byName),
  };
  db.totals = databaseTotals(db);
  return db;
}

function controlCensus(databases) {
  const counts = {};
  for (const db of databases) {
    for (const page of db.xpages.concat(db.customControls)) {
      for (const [tag, n] of Object.entries(page.controlCounts)) {
        if (tag.startsWith('xp:')) {
          counts[tag] = (counts[tag] || 0) + n;
        }
      }
    }
  }
  return Object.entries(counts)
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'en'));
}

function migrationNotes(databases) {
  const allForms = databases.flatMap((db) => db.forms.concat(db.subforms).map((f) => ({ db: db.name, form: f })));
  const validations = sum(databases, (db) => db.totals.validations);
  const translations = sum(databases, (db) => db.totals.translations);
  const scheduled = databases.flatMap((db) => db.agents.filter((a) => a.scheduled).map((a) => `${db.name}/${a.name}`));
  const hiddenViews = databases.flatMap((db) => db.views.filter((v) => v.name.startsWith('(')).map((v) => `${db.name}/${v.name}`));
  const allowNew = allForms.flatMap(({ db, form }) => form.stats.allowNew.map((f) => `${db}/${form.name}.${f}`));
  const readersForms = allForms.filter(({ form }) => form.stats.readers.length > 0).map(({ db, form }) => `${db}/${form.name} (${form.stats.readers.join(', ')})`);
  const agentLoc = sum(databases, (db) => db.totals.agentLoc);
  const libraryLoc = sum(databases, (db) => db.totals.libraryLoc);
  const ssjsLines = sum(databases, (db) => db.totals.ssjsLines);
  return [
    `${validations} field validation formulas and ${translations} input translation formulas must be ported to the target validation layer (Domino evaluates them field-by-field on save; the ${sum(databases, (db) => db.totals.computedFields)} computed fields become derived attributes or persistence hooks).`,
    `${scheduled.length} scheduled agents replace with jobs or queue consumers: ${scheduled.join(', ')}. ${agentLoc} lines of agent LotusScript and ${libraryLoc} lines of script-library code (LotusScript and Server JavaScript) are candidates for service extraction.`,
    `${hiddenViews.length} hidden lookup views (names starting with "(") back @DbLookup/@DbColumn calls and embedded views; each becomes a query or index in the target store: ${hiddenViews.join(', ')}.`,
    `${allowNew.length} keyword fields accept free-text values (allowNew): ${allowNew.length ? allowNew.join(', ') : 'none'}. Their reference data needs a de-duplication pass before it can become a constrained lookup table.`,
    `${readersForms.length} forms carry Readers fields and rely on document-level Domino security: ${readersForms.length ? readersForms.join('; ') : 'none'}. Row-level authorization must be reproduced explicitly in the target application.`,
    `${ssjsLines} lines of Server JavaScript across ${sum(databases, (db) => db.totals.xpages)} XPages and ${sum(databases, (db) => db.totals.customControls)} custom controls hold the web presentation logic that the new front end replaces.`,
  ];
}

/** Build the inventory data model for every nsf/<db>/ directory under repoRoot. */
function buildInventory(repoRoot) {
  const root = repoRoot || path.resolve(__dirname, '..');
  const nsfRoot = path.join(root, 'nsf');
  const dirs = fs
    .readdirSync(nsfRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.toLowerCase().endsWith('.nsf'))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b, 'en'));
  const databases = dirs.map((d) => {
    const design = loadDesign(path.join(nsfRoot, d));
    const db = databaseModel(design);
    db.dir = `nsf/${d}`;
    return db;
  });
  const totals = {};
  for (const [, key] of TOTAL_ROWS) {
    totals[key] = sum(databases, (db) => db.totals[key]);
  }
  return {
    generator: 'node tools/inventory.js',
    databases,
    totals,
    controlCensus: controlCensus(databases),
    migrationNotes: migrationNotes(databases),
  };
}

// --- rendering ----------------------------------------------------------------------------

function renderFormFields(form) {
  const rows = form.fields.map((f) => [
    f.name + (f.readers ? ' (Readers)' : '') + (f.authors ? ' (Authors)' : ''),
    f.type + (f.multivalue ? ' (multi)' : ''),
    f.kind,
    f.keywords.length ? `${f.keywords.join('; ')}${f.allowNew ? ' (+free text)' : ''}` : f.description || (COMPUTED_KINDS.has(f.kind) && f.value ? code(f.value) : ''),
    code(f.defaultValue),
    code(f.inputTranslation),
    code(f.inputValidation),
  ]);
  return table(['Field', 'Type', 'Kind', 'Keywords/Description', 'Default', 'Translation', 'Validation'], rows);
}

function renderForms(db) {
  const all = db.forms.concat(db.subforms);
  const out = [];
  out.push('### Forms');
  out.push('');
  out.push(
    table(
      ['Form', 'Kind', 'Aliases', 'Fields', 'Editable', 'Computed', 'Keyword', 'Validations', 'Translations', 'Readers/Authors', 'Actions', 'Subforms', 'LotusScript lines'],
      all.map((f) => [
        f.name,
        f.kind,
        list(f.aliases),
        f.stats.fields,
        f.stats.editable,
        f.stats.computed,
        f.stats.keyword,
        f.stats.validations,
        f.stats.translations,
        list([...f.stats.readers.map((n) => `${n} (R)`), ...f.stats.authors.map((n) => `${n} (A)`)]),
        f.actions,
        list(f.subformRefs),
        f.lotusScriptLines,
      ]),
    ),
  );
  for (const f of all) {
    out.push('');
    out.push(`#### ${f.kind === 'subform' ? 'Subform' : 'Form'}: ${f.name}`);
    out.push('');
    const meta = [`Source: \`${f.file}\``];
    if (f.aliases.length) {
      meta.push(`Aliases: ${f.aliases.join(', ')}`);
    }
    if (f.windowTitle) {
      meta.push(`Window title: ${code(f.windowTitle)}`);
    }
    out.push(meta.join(' · '));
    out.push('');
    out.push(renderFormFields(f));
  }
  return out.join('\n');
}

function renderViews(db) {
  const out = ['### Views', ''];
  out.push(
    table(
      ['View', 'Aliases', 'Hidden', 'Response hierarchy', 'Columns', 'Categorized', 'Selection formula'],
      db.views.map((v) => [v.name, list(v.aliases), yesNo(v.hidden), yesNo(v.showResponseHierarchy), v.columns.length, v.categorizedColumns, code(v.selection)]),
    ),
  );
  for (const v of db.views) {
    out.push('');
    out.push(`#### View: ${v.name}`);
    out.push('');
    out.push(`Source: \`${v.file}\`${v.comment ? ` · ${cell(v.comment)}` : ''}`);
    out.push('');
    out.push(
      table(
        ['#', 'Title', 'Item', 'Sort', 'Categorized', 'Responses only', 'Formula'],
        v.columns.map((c, i) => [i + 1, c.title, c.itemName, c.sort, yesNo(c.categorized), yesNo(c.responsesOnly), code(c.formula)]),
      ),
    );
  }
  return out.join('\n');
}

function renderAgents(db) {
  return [
    '### Agents',
    '',
    table(
      ['Agent', 'Trigger', 'Schedule', 'Document set', 'Language', 'LoC', 'Source file', 'Purpose'],
      db.agents.map((a) => [a.name, a.trigger, a.scheduleText, a.documentSet, a.language, a.linesOfCode, a.sourceFile ? `\`${a.sourceFile}\`` : '', a.comment]),
    ),
  ].join('\n');
}

function renderLibraries(db) {
  return ['### Script libraries', '', table(['Library', 'Language', 'LoC', 'Routines', 'Source file'], db.scriptLibraries.map((l) => [l.name, l.language, l.linesOfCode, l.routines, `\`${l.file}\``]))].join('\n');
}

function renderXsp(db) {
  const pages = db.xpages.concat(db.customControls);
  return [
    '### XPages and custom controls',
    '',
    table(
      ['Name', 'Page title', 'Kind', 'Data sources', 'Controls', 'Inputs', 'Buttons', 'SSJS blocks', 'SSJS lines', 'Custom controls used'],
      pages.map((p) => [p.name, p.pageTitle.startsWith('#{') ? code(p.pageTitle) : p.pageTitle, p.kind, list(p.dataSources), p.controls, p.inputs, p.buttons, p.ssjsBlocks, p.ssjsLines, list(p.customControls)]),
    ),
  ].join('\n');
}

function renderTotals(db) {
  return ['### Totals', '', table(['Metric', 'Count'], TOTAL_ROWS.map(([label, key]) => [label, db.totals[key]]))].join('\n');
}

function renderDatabase(db) {
  const p = db.properties;
  const out = [];
  out.push(`## Database: ${p.title || db.name} (\`${db.name}\`)`);
  out.push('');
  out.push(
    table(
      ['Property', 'Value'],
      [
        ['Title', p.title],
        ['Path', p.path],
        ['Design directory', `\`${db.dir}\``],
        ['Replica ID', p.replicaId],
        ['ODS version', p.odsVersion],
        ['Designer version', p.designerVersion],
        ['Inherits design from template', yesNo(p.inheritDesign) + (p.template ? ` (${p.template})` : '')],
        ['Design modified', p.designModified],
        ['Category', p.category],
      ],
    ),
  );
  out.push('');
  out.push('### ACL');
  out.push('');
  out.push(`Roles (${db.acl.roles.length}): ${db.acl.roles.length ? db.acl.roles.map((r) => `\`${r}\``).join(', ') : '—'}`);
  out.push('');
  out.push(table(['Entry', 'Type', 'Level', 'Roles', 'Flags'], db.acl.entries.map((e) => [e.name, e.type, e.level, list(e.roles), list(e.flags)])));
  out.push('');
  out.push(renderTotals(db));
  out.push('');
  out.push(renderForms(db));
  out.push('');
  out.push(renderViews(db));
  out.push('');
  out.push(renderAgents(db));
  out.push('');
  out.push(renderLibraries(db));
  out.push('');
  out.push(renderXsp(db));
  return out.join('\n');
}

function renderSummary(inventory) {
  const headers = ['Metric', ...inventory.databases.map((db) => db.name), 'Total'];
  const rows = TOTAL_ROWS.map(([label, key]) => [label, ...inventory.databases.map((db) => db.totals[key]), inventory.totals[key]]);
  return ['## Cross-database summary', '', table(headers, rows)].join('\n');
}

/** Render the inventory data model to Markdown. Pure and deterministic. */
function renderMarkdown(inventory) {
  const out = [];
  out.push('# HAAS Design Inventory');
  out.push('');
  out.push(`Generated by \`${inventory.generator}\` from the DXL/XSP design sources under \`nsf/\`. Do not edit by hand; run \`npm run inventory\` to refresh and \`node tools/inventory.js --check\` to verify.`);
  out.push('');
  out.push('HAAS (Heraldry & Awards Automation System) is a synthetic legacy application used as a modernization reference application. This inventory enumerates every design element in its HCL Domino/XPages databases so a migration team can size the port: every count below is computed from the parsed design.');
  out.push('');
  out.push('## Contents');
  out.push('');
  for (const db of inventory.databases) {
    out.push(`- ${db.properties.title || db.name} (\`${db.name}\`): ${db.totals.forms} forms, ${db.totals.subforms} subforms, ${db.totals.views} views, ${db.totals.agents} agents, ${db.totals.scriptLibraries} script libraries, ${db.totals.xpages} XPages, ${db.totals.customControls} custom controls`);
  }
  out.push('- Top control census');
  out.push('- Cross-database summary');
  out.push('- Migration notes');
  for (const db of inventory.databases) {
    out.push('');
    out.push(renderDatabase(db));
  }
  out.push('');
  out.push('## Top control census');
  out.push('');
  out.push(table(['Control', 'Occurrences'], inventory.controlCensus.map((c) => [`\`${c.tag}\``, c.count])));
  out.push('');
  out.push(renderSummary(inventory));
  out.push('');
  out.push('## Migration notes');
  out.push('');
  for (const note of inventory.migrationNotes) {
    out.push(`- ${note}`);
  }
  out.push('');
  return out.join('\n');
}

// --- CLI ----------------------------------------------------------------------------------

function diffSummary(expected, actual) {
  const a = expected.split('\n');
  const b = actual.split('\n');
  const lines = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max && lines.length < 40; i++) {
    if (a[i] !== b[i]) {
      lines.push(`  line ${i + 1}:`);
      lines.push(`    on disk : ${b[i] === undefined ? '<missing>' : b[i].slice(0, 200)}`);
      lines.push(`    expected: ${a[i] === undefined ? '<missing>' : a[i].slice(0, 200)}`);
    }
  }
  return `${lines.join('\n')}\n  (${a.length} expected lines, ${b.length} on disk)`;
}

function main(argv) {
  const repoRoot = path.resolve(__dirname, '..');
  const outPath = path.join(repoRoot, OUTPUT_FILE);
  const markdown = renderMarkdown(buildInventory(repoRoot));
  if (argv.includes('--check')) {
    const onDisk = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : '';
    if (onDisk !== markdown) {
      console.error(`${OUTPUT_FILE} is stale; run \`node tools/inventory.js\` to regenerate.`);
      console.error(diffSummary(markdown, onDisk));
      process.exitCode = 1;
      return;
    }
    console.log(`${OUTPUT_FILE} is up to date.`);
    return;
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, markdown, 'utf8');
  console.log(`wrote ${OUTPUT_FILE} (${markdown.split('\n').length} lines)`);
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { buildInventory, renderMarkdown, OUTPUT_FILE, TOTAL_ROWS, COMPUTED_KINDS };
