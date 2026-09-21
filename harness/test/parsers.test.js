'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const xml = require('../lib/xml');
const dxl = require('../lib/dxl');
const xsp = require('../lib/xsp');
const { REPO_ROOT } = require('./helpers');

const HER = path.join(REPO_ROOT, 'nsf', 'heraldry.nsf');
const VET = path.join(REPO_ROOT, 'nsf', 'vetmedals.nsf');

test('xml: parses elements, attributes, CDATA and entities', () => {
  const doc = xml.parse('<?xml version="1.0"?><a x="1&amp;2"><b>hi &lt;there&gt;</b><![CDATA[raw <x>]]><c/></a>');
  const root = xml.rootElement(doc);
  assert.equal(root.name, 'a');
  assert.equal(root.attrs.x, '1&2');
  assert.equal(xml.text(xml.child(root, 'b')), 'hi <there>');
  assert.equal(xml.children(root).length, 2);
  assert.ok(xml.text(root).includes('raw <x>'));
});

test('xml: rejects malformed markup', () => {
  assert.throws(() => xml.parse('<a><b></a>'), xml.XmlError);
  assert.throws(() => xml.parse('<a x="1>'), xml.XmlError);
});

test('dxl: Request form exposes fields with kinds and formulas', () => {
  const form = dxl.parseForm(fs.readFileSync(path.join(HER, 'forms', 'Request.dxl'), 'utf8'), 'forms/Request.dxl');
  assert.equal(form.name, 'Request');
  const byName = Object.fromEntries(form.fields.map((f) => [f.name, f]));
  assert.equal(byName.DODAAC.kind, 'editable');
  assert.match(byName.DODAAC.inputValidation, /@Failure/);
  assert.match(byName.DODAAC.inputTranslation, /@UpperCase|@Trim/);
  assert.equal(byName.Status.type, 'keyword');
  assert.ok(byName.Status.keywords.includes('Released to Vendor'));
  assert.ok(byName.DocReaders.readers, 'DocReaders is a Readers field');
  assert.ok(form.actions.length >= 3, 'action bar buttons parsed');
  assert.ok(form.fields.some((f) => f.kind === 'computed' && f.value));
});

test('dxl: all forms in both databases parse with unique field names', () => {
  for (const dir of [HER, VET]) {
    for (const f of fs.readdirSync(path.join(dir, 'forms'))) {
      const form = dxl.parseForm(fs.readFileSync(path.join(dir, 'forms', f), 'utf8'), `forms/${f}`);
      const names = form.fields.map((x) => x.name);
      assert.equal(new Set(names).size, names.length, `${dir}/${f} duplicate field`);
      assert.ok(form.name, `${f} has a name`);
    }
  }
});

test('dxl: categorized view parses selection formula and columns', () => {
  const view = dxl.parseView(fs.readFileSync(path.join(HER, 'views', 'RequestsByStatus.dxl'), 'utf8'), 'views/RequestsByStatus.dxl');
  assert.equal(view.name, 'RequestsByStatus');
  assert.match(view.selection, /SELECT/);
  assert.ok(view.columns.length >= 5);
  assert.ok(view.columns[0].categorized, 'first column categorized');
  assert.ok(view.columns.every((c) => c.formula || c.itemName), 'every column has a formula or item');
});

test('dxl: agent wrapper parses trigger metadata and pairs with LotusScript', () => {
  const agent = dxl.parseAgentDxl(fs.readFileSync(path.join(VET, 'agents', 'NightlyAging.dxl'), 'utf8'), 'agents/NightlyAging.dxl');
  assert.equal(agent.name, 'NightlyAging');
  assert.match(agent.trigger, /scheduled/i);
  const design = dxl.loadDesign(VET);
  const aging = design.agents.find((a) => a.name === 'NightlyAging');
  assert.equal(aging.language, 'LotusScript');
  assert.ok(aging.linesOfCode > 50);
  assert.equal(aging.sourceFile, 'agents/NightlyAging.lss');
});

test('dxl: ACL parses roles and entries', () => {
  const acl = dxl.parseAcl(fs.readFileSync(path.join(HER, 'acl.dxl'), 'utf8'));
  for (const r of ['[TACOM]', '[DLA]', '[Vendor]', '[CSR]', '[Admin]']) {
    assert.ok(acl.roles.includes(r), `role ${r}`);
  }
  const anon = acl.entries.find((e) => e.name === 'Anonymous');
  assert.ok(anon);
  assert.ok(['noaccess', 'depositor', 'reader'].includes(anon.level), 'Anonymous is never an author');
  const def = acl.entries.find((e) => e.name === '-Default-');
  assert.ok(def);
  assert.ok(acl.entries.some((e) => e.name === 'LocalDomainServers'));
});

test('dxl: database properties carry replica id and title', () => {
  const props = dxl.parseDatabaseProperties(fs.readFileSync(path.join(HER, 'database.properties.dxl'), 'utf8'));
  assert.equal(props.replicaId, 'C1258A1F00305C22');
  assert.match(props.title, /Heraldry/);
  assert.equal(props.items.$TITLE, props.title);
  const vet = dxl.parseDatabaseProperties(fs.readFileSync(path.join(VET, 'database.properties.dxl'), 'utf8'));
  assert.equal(vet.replicaId, 'C1258A1F00305D71');
});

test('dxl: document export parses documents, items, system items and $FILE', () => {
  const src = `<?xml version="1.0"?>
<database xmlns="http://www.lotus.com/dxl" replicaid="C1258A1F00305C22" title="T">
<document form="Request" replicaid="C1258A1F00305C22" unid="0123456789ABCDEF0123456789ABCDEF" noteid="8F2">
<noteinfo unid="0123456789ABCDEF0123456789ABCDEF"><created><datetime>20240102T101500,00-05</datetime></created><modified><datetime>20240103T101500,00-05</datetime></modified></noteinfo>
<item name="Form"><text>Request</text></item>
<item name="DODAAC"><text>W45XYZ</text></item>
<item name="Quantity"><number>3</number></item>
<item name="Tags"><textlist><text>a</text><text>b</text></textlist></item>
<item name="EnteredDate"><datetime>20240102T101500,00-05</datetime></item>
<item name="DocReaders" names="true" readers="true"><textlist><text>[TACOM]</text></textlist></item>
<item name="$UpdatedBy" names="true"><textlist><text>CN=A/O=TACOM</text></textlist></item>
<item name="$FILE"><object><file name="dd1348-6.pdf" size="1200"/></object></item>
</document>
<document form="RequestLine" unid="FEDCBA9876543210FEDCBA9876543210" parent="0123456789ABCDEF0123456789ABCDEF" noteid="8F6">
<item name="Form"><text>RequestLine</text></item>
</document>
</database>`;
  const parsed = dxl.parseDocumentExport(src);
  assert.equal(parsed.database.replicaid || parsed.database.replicaId, 'C1258A1F00305C22');
  assert.equal(parsed.documents.length, 2);
  const [req, line] = parsed.documents;
  assert.equal(req.form, 'Request');
  assert.equal(req.items.Quantity, 3);
  assert.deepEqual(req.items.Tags, ['a', 'b']);
  assert.deepEqual(req.items.DocReaders, ['[TACOM]']);
  assert.ok(req.readers.includes('[TACOM]'));
  assert.deepEqual(req.updatedBy, ['CN=A/O=TACOM']);
  assert.match(String(req.items.EnteredDate), /^2024-01-02/);
  assert.equal(req.files[0].name, 'dd1348-6.pdf');
  assert.equal(line.parent, req.unid);
});

test('dxl: parseDxlDateTime handles offsets and date-only values', () => {
  assert.equal(dxl.parseDxlDateTime('20240102T101500,00-05'), '2024-01-02T10:15:00-05:00');
  assert.match(dxl.parseDxlDateTime('20040218'), /^2004-02-18/);
  assert.equal(dxl.parseDxlDateTime('3/7/2011'), '2011-03-07');
  assert.equal(dxl.parseDxlDateTime('18-Feb-2004'), '2004-02-18');
  assert.equal(dxl.parseDxlDateTime('garbage'), 'garbage', 'unparseable legacy values are preserved verbatim');
});

test('dxl: shipped document exports parse to the seeded volumes', () => {
  const her = dxl.parseDocumentExport(fs.readFileSync(path.join(REPO_ROOT, 'export', 'dxl', 'heraldry-documents.dxl'), 'utf8'));
  const count = (docs, form) => docs.filter((d) => d.form === form).length;
  assert.equal(count(her.documents, 'Vendor'), 12);
  assert.equal(count(her.documents, 'HeraldicItem'), 120);
  assert.equal(count(her.documents, 'Request'), 800);
  assert.equal(count(her.documents, 'RequestLine'), 2000);
  assert.equal(count(her.documents, 'SESFlagRequest'), 60);
  assert.ok(her.documents.every((d) => d.items.Form === d.form));
  assert.ok(her.documents.every((d) => d.updatedBy.length >= 1), 'every document carries $UpdatedBy');
  assert.ok(her.documents.every((d) => d.revisions.length >= 1), 'every document carries $Revisions');
  assert.ok(her.documents.filter((d) => d.form === 'RequestLine').every((d) => d.parent), 'RequestLines are responses');
});

test('xsp: parses controls, data sources, SSJS bindings and custom control references', () => {
  const page = xsp.parseXsp(fs.readFileSync(path.join(HER, 'xpages', 'Request.xsp'), 'utf8'), 'xpages/Request.xsp');
  assert.equal(page.name, 'Request');
  assert.ok(page.dataSources.some((d) => d.type === 'dominoDocument' && d.formName === 'Request'));
  assert.ok(page.controlCounts['xp:inputText'] > 5, 'inputText controls counted');
  assert.ok(page.controlCounts['xp:button'] >= 1);
  assert.equal(page.controls, Object.values(page.controlCounts).reduce((a, b) => a + b, 0));
  assert.ok(page.ssjsBlocks > 0, 'SSJS snippets extracted');
  assert.ok(page.customControls.includes('ccLayout'));
  assert.ok(page.inputs.some((i) => i.field && i.field.field === 'DODAAC' && i.maxlength === 6));
  assert.ok(page.buttons.some((b) => /Submit/.test(b.value)));
});

test('xsp: extractSsjs and bindingField', () => {
  const s = xsp.extractSsjs('<xp:button><xp:this.action><![CDATA[#{javascript:var a = 1;\nreturn a;}]]></xp:this.action></xp:button><xp:inputText value="#{document1.DODAAC}"/>');
  assert.equal(s.length, 1);
  assert.match(s[0], /var a = 1/);
  assert.deepEqual(xsp.bindingField('#{document1.DODAAC}'), { source: 'document1', field: 'DODAAC' });
  assert.equal(xsp.bindingField('#{javascript:foo()}'), null);
});

test('xsp: every XPage and custom control in both databases parses', () => {
  for (const dir of [HER, VET]) {
    for (const sub of ['xpages', 'customcontrols']) {
      const p = path.join(dir, sub);
      if (!fs.existsSync(p)) {
        continue;
      }
      for (const f of fs.readdirSync(p)) {
        const page = xsp.parseXsp(fs.readFileSync(path.join(p, f), 'utf8'), `${sub}/${f}`);
        assert.ok(page.name, `${f} parsed`);
        assert.ok(page.controls > 0, `${f} has controls`);
      }
    }
  }
});
