'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildInventory, renderMarkdown, OUTPUT_FILE, TOTAL_ROWS } = require('../../tools/inventory');

const repoRoot = path.resolve(__dirname, '..', '..');
const nsfRoot = path.join(repoRoot, 'nsf');

function namesFromDisk(db, sub, ext) {
  return new Set(
    fs
      .readdirSync(path.join(nsfRoot, db, sub))
      .filter((f) => f.toLowerCase().endsWith(ext))
      .map((f) => f.slice(0, -ext.length)),
  );
}

const inventory = buildInventory(repoRoot);

test('buildInventory returns every nsf/*.nsf database in sorted order', () => {
  const expected = fs
    .readdirSync(nsfRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.toLowerCase().endsWith('.nsf'))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b, 'en'));
  assert.deepEqual(
    inventory.databases.map((db) => db.name),
    expected,
  );
  assert.ok(inventory.databases.length >= 2, 'expected at least two databases');
});

test('form, subform, view and agent name sets equal the design files on disk (both directions)', () => {
  for (const db of inventory.databases) {
    const formFiles = namesFromDisk(db.name, 'forms', '.dxl');
    const formNames = new Set(db.forms.concat(db.subforms).map((f) => f.name));
    assert.deepEqual(formNames, formFiles, `${db.name}: forms`);
    assert.equal(db.forms.length + db.subforms.length, formFiles.size, `${db.name}: forms count`);

    const viewFiles = namesFromDisk(db.name, 'views', '.dxl');
    const viewNames = new Set(db.views.map((v) => v.name));
    assert.deepEqual(viewNames, viewFiles, `${db.name}: views`);
    assert.equal(db.views.length, viewFiles.size, `${db.name}: views count`);

    const agentFiles = namesFromDisk(db.name, 'agents', '.dxl');
    const agentNames = new Set(db.agents.map((a) => a.name));
    assert.deepEqual(agentNames, agentFiles, `${db.name}: agents`);
    assert.equal(db.agents.length, agentFiles.size, `${db.name}: agents count`);

    const libFiles = new Set([...namesFromDisk(db.name, 'scriptlibs', '.lss'), ...namesFromDisk(db.name, 'scriptlibs', '.jss')]);
    assert.deepEqual(new Set(db.scriptLibraries.map((l) => l.name)), libFiles, `${db.name}: script libraries`);

    assert.deepEqual(new Set(db.xpages.map((x) => x.name)), namesFromDisk(db.name, 'xpages', '.xsp'), `${db.name}: xpages`);
    assert.deepEqual(new Set(db.customControls.map((x) => x.name)), namesFromDisk(db.name, 'customcontrols', '.xsp'), `${db.name}: custom controls`);
  }
});

test('elements are sorted by name within each database', () => {
  const sorted = (items) => items.map((i) => i.name).every((n, i, arr) => i === 0 || arr[i - 1].localeCompare(n, 'en') <= 0);
  for (const db of inventory.databases) {
    for (const key of ['forms', 'subforms', 'views', 'agents', 'scriptLibraries', 'xpages', 'customControls']) {
      assert.ok(sorted(db[key]), `${db.name}.${key} is sorted`);
    }
  }
});

test('database totals equal the sum of their parts', () => {
  const sum = (items, pick) => items.reduce((n, i) => n + pick(i), 0);
  for (const db of inventory.databases) {
    const all = db.forms.concat(db.subforms);
    const fields = all.flatMap((f) => f.fields);
    const t = db.totals;
    assert.equal(t.forms, db.forms.length);
    assert.equal(t.subforms, db.subforms.length);
    assert.equal(t.fields, sum(all, (f) => f.stats.fields));
    assert.equal(t.fields, fields.length);
    assert.equal(t.validations, sum(all, (f) => f.stats.validations));
    assert.equal(t.validations, fields.filter((f) => f.inputValidation).length);
    assert.equal(t.translations, sum(all, (f) => f.stats.translations));
    assert.equal(t.computedFields, sum(all, (f) => f.stats.computed));
    assert.equal(t.keywordFields, sum(all, (f) => f.stats.keyword));
    assert.equal(t.readersFields, sum(all, (f) => f.stats.readers.length));
    assert.equal(t.authorsFields, sum(all, (f) => f.stats.authors.length));
    for (const f of all) {
      assert.equal(f.stats.editable + f.stats.computed, f.fields.filter((x) => x.kind === 'editable' || ['computed', 'computedfordisplay', 'computedwhencomposed'].includes(x.kind)).length, `${db.name}/${f.name}: editable + computed`);
    }
    assert.equal(t.views, db.views.length);
    assert.equal(t.hiddenViews, db.views.filter((v) => v.hidden).length);
    assert.equal(t.columns, sum(db.views, (v) => v.columns.length));
    assert.equal(t.categorizedColumns, sum(db.views, (v) => v.columns.filter((c) => c.categorized).length));
    assert.equal(t.agents, db.agents.length);
    assert.equal(t.scheduledAgents, db.agents.filter((a) => a.trigger === 'scheduled').length);
    assert.equal(t.agentLoc, sum(db.agents, (a) => a.linesOfCode));
    assert.equal(t.scriptLibraries, db.scriptLibraries.length);
    assert.equal(t.libraryLoc, sum(db.scriptLibraries, (l) => l.linesOfCode));
    assert.equal(t.xpages, db.xpages.length);
    assert.equal(t.customControls, db.customControls.length);
    const pages = db.xpages.concat(db.customControls);
    assert.equal(t.xpageControls, sum(pages, (p) => p.controls));
    assert.equal(t.xpageControls, sum(pages, (p) => Object.values(p.controlCounts).reduce((a, b) => a + b, 0)));
    assert.equal(t.ssjsLines, sum(pages, (p) => p.ssjsLines));
  }
});

test('cross-database totals equal the sum of the per-database totals', () => {
  for (const [, key] of TOTAL_ROWS) {
    assert.equal(
      inventory.totals[key],
      inventory.databases.reduce((n, db) => n + db.totals[key], 0),
      key,
    );
  }
  const censusTotal = inventory.controlCensus.reduce((n, c) => n + c.count, 0);
  const xpTotal = inventory.databases
    .flatMap((db) => db.xpages.concat(db.customControls))
    .reduce((n, p) => n + Object.entries(p.controlCounts).filter(([tag]) => tag.startsWith('xp:')).reduce((m, [, c]) => m + c, 0), 0);
  assert.equal(censusTotal, xpTotal);
});

test('renderMarkdown is deterministic', () => {
  const a = renderMarkdown(inventory);
  const b = renderMarkdown(buildInventory(repoRoot));
  assert.equal(a, b);
  assert.doesNotMatch(a, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/, 'no generation timestamps');
});

test('every table cell escapes pipes and contains no raw newlines', () => {
  const md = renderMarkdown(inventory);
  const tableLines = md.split('\n').filter((l) => l.startsWith('| '));
  for (const line of tableLines) {
    const unescaped = line.replace(/\\\|/g, '');
    const cells = unescaped.split('|').length - 2;
    assert.ok(cells >= 1, line);
    assert.doesNotMatch(line, /\\\\\|/, `double-escaped pipe: ${line.slice(0, 120)}`);
  }
});

test('the checked-in docs/DESIGN-INVENTORY.md matches a fresh render byte for byte', () => {
  const onDisk = fs.readFileSync(path.join(repoRoot, OUTPUT_FILE), 'utf8');
  assert.equal(onDisk, renderMarkdown(inventory), `${OUTPUT_FILE} is stale; run \`node tools/inventory.js\``);
});

test('the rendered Markdown contains the cross-database summary and migration notes', () => {
  const md = renderMarkdown(inventory);
  assert.match(md, /^## Cross-database summary$/m);
  assert.match(md, /^## Migration notes$/m);
  assert.match(md, /^## Top control census$/m);
  for (const db of inventory.databases) {
    assert.match(md, new RegExp(`^## Database: .*\\(\`${db.name.replace('.', '\\.')}\`\\)$`, 'm'));
    for (const form of db.forms) {
      assert.match(md, new RegExp(`^#### Form: ${form.name.replace(/[()$]/g, '\\$&')}$`, 'm'));
    }
    for (const view of db.views) {
      assert.match(md, new RegExp(`^#### View: ${view.name.replace(/[()$]/g, '\\$&')}$`, 'm'));
    }
  }
  assert.ok(inventory.migrationNotes.length >= 3 && inventory.migrationNotes.length <= 6);
  assert.doesNotMatch(md, /demo/i);
});
