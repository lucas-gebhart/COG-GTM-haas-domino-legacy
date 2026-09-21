'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const F = require('../lib/formula');
const dxl = require('../lib/dxl');
const { REPO_ROOT } = require('./helpers');

const doc = (items) => ({ unid: 'X', items });
const val = (src, ctx) => F.evaluate(src, ctx).value;

test('formula: arithmetic, precedence and string concatenation', () => {
  assert.equal(val('1 + 2 * 3'), 7);
  assert.equal(val('(1 + 2) * 3'), 9);
  assert.equal(val('"a" + "b"'), 'ab');
  assert.equal(val('10 / 4'), 2.5);
  assert.equal(val('Quantity * UnitPrice', { doc: doc({ Quantity: 3, UnitPrice: 12.5 }) }), 37.5);
  assert.equal(val('@Round(Quantity * UnitPrice; 0.01)', { doc: doc({ Quantity: 2, UnitPrice: 64.57 }) }), 129.14, '@Round takes a rounding factor, not a digit count');
  assert.equal(val('@Round(2.5)'), 3);
  assert.equal(val('@Round(1234; 100)'), 1200);
});

test('formula: comparison, permuted operators and logic', () => {
  assert.equal(val('3 > 2'), 1);
  assert.equal(val('"a" = "a" & 1 < 2'), 1);
  assert.equal(val('"a" != "a" | 0'), 0);
  assert.equal(val('!(1 = 2)'), 1);
  assert.deepEqual(val('"b" *= "a":"b":"c"'), [0, 1, 0], 'permuted equality yields one result per pair');
  assert.deepEqual(val('1:2 *< 2:3'), [1, 1, 0, 1]);
  assert.equal(val('Quantity * 2', { doc: doc({ Quantity: 4 }) }), 8, '* is multiplication, not a permuted operator');
});

test('formula: lists and list functions', () => {
  assert.deepEqual(val('"a":"b":"c"'), ['a', 'b', 'c']);
  assert.equal(val('@Elements("a":"b":"c")'), 3);
  assert.equal(val('@Implode("a":"b"; "-")'), 'a-b');
  assert.deepEqual(val('@Explode("x,y"; ",")'), ['x', 'y']);
  assert.equal(val('@IsMember("b"; "a":"b")'), 1);
  assert.equal(val('@Subset("a":"b":"c"; -1)'), 'c');
  assert.deepEqual(val('@Trim("a":"":"b")'), ['a', 'b']);
});

test('formula: text functions used by the HAAS forms', () => {
  assert.equal(val('@UpperCase(@Trim("  w45xyz "))'), 'W45XYZ');
  assert.equal(val('@Length("ABCDEF")'), 6);
  assert.equal(val('@Left("W45XYZ"; 1)'), 'W');
  assert.equal(val('@Right("W45XYZ"; 3)'), 'XYZ');
  assert.equal(val('@Middle("ABCDEF"; 2; 2)'), 'CD');
  assert.equal(val('@Text(15)'), '15');
  assert.equal(val('@TextToNumber("07")'), 7);
  assert.equal(val('@Right("00" + @Text(7); 2)'), '07');
  assert.equal(val('@Matches("W12345"; "W?+")'), 1);
  assert.equal(val('@Matches("X12345"; "W?+")'), 0);
  assert.equal(val('@Matches("WWW"; "W+")'), 1);
  assert.equal(val('@Matches("WWX"; "W+")'), 0);
  assert.equal(val('@Like("ABC123"; "ABC%")'), 1);
  assert.equal(val('@ReplaceSubstring("a-b"; "-"; "_")'), 'a_b');
  assert.equal(val('@Contains("Bronze Star Medal"; "Star")'), 1);
});

test('formula: @If with multiple branches and @Do side effects', () => {
  assert.equal(val('@If(1 = 2; "a"; 2 = 2; "b"; "c")'), 'b');
  assert.equal(val('@If(1 = 2; "a"; "z")'), 'z');
  const r = F.evaluate('@Do(FIELD Status := "Released to Vendor"; FIELD ReleasedBy := @UserName; @Success)', { userName: 'CN=Ann/O=TACOM' });
  assert.equal(r.fieldWrites.Status, 'Released to Vendor');
  assert.equal(r.fieldWrites.ReleasedBy, 'CN=Ann/O=TACOM');
  assert.equal(r.value, F.SUCCESS);
});

test('formula: temporaries, @Return and DEFAULT', () => {
  assert.equal(val('x := 2; y := x * 3; y + 1'), 7);
  assert.equal(val('@If(1 = 1; @Return("early"); ""); "late"'), 'early');
  assert.equal(val('DEFAULT Priority := "Routine"; Priority', { doc: doc({}) }), 'Routine');
  assert.equal(val('DEFAULT Priority := "Routine"; Priority', { doc: doc({ Priority: 'Expedite' }) }), 'Expedite');
});

test('formula: dates, @Adjust and date subtraction', () => {
  const now = new Date(2026, 8, 1, 6, 30);
  const today = val('@Today', { now });
  assert.ok(today instanceof Date);
  assert.equal(F.formatDate(today), '09/01/2026');
  const adjusted = val('@Adjust(@Today; 0; 0; 75; 0; 0; 0)', { now });
  assert.equal(F.formatDate(adjusted), '11/15/2026');
  const days = val('(@Today - @Date(2026; 7; 1)) / 86400', { now });
  assert.equal(days, 62);
  const parsed = F.parseDateValue('2004-02-18T09:00:00-05:00');
  assert.equal(parsed.getFullYear(), 2004);
  assert.equal(F.parseDateValue('not a date'), null);
  assert.equal(val('@Year(@Date(2019; 12; 31))'), 2019);
  assert.equal(val('@Text(@Date(2019; 1; 2); "D0S0")'), '01/02/2019');
});

test('formula: @UserName, @UserRoles, @IsNewDoc and @Name', () => {
  const ctx = { userName: 'CN=Dana Whitcombe/OU=CHPSID/O=TACOM', roles: ['[TACOM]', '[Admin]'], isNewDoc: true };
  assert.equal(val('@Name([CN]; @UserName)', ctx), 'Dana Whitcombe');
  assert.equal(val('@IsMember("[Admin]"; @UserRoles)', ctx), 1);
  assert.equal(val('@IsNewDoc', ctx), 1);
  assert.equal(val('@Name([Abbreviate]; @UserName)', ctx), 'Dana Whitcombe/CHPSID/TACOM');
});

test('formula: validate() and translate() follow Domino @Success/@Failure semantics', () => {
  const src = '@If(@Length(DODAAC) != 6; @Failure("DODAAC must be exactly 6 characters."); !@Matches(DODAAC; "{A-Z0-9}{A-Z0-9}{A-Z0-9}{A-Z0-9}{A-Z0-9}{A-Z0-9}"); @Failure("DODAAC must be alphanumeric."); @Success)';
  assert.deepEqual(F.validate(src, { doc: doc({ DODAAC: 'W45XYZ' }) }), { ok: true });
  assert.equal(F.validate(src, { doc: doc({ DODAAC: 'W45' }) }).message, 'DODAAC must be exactly 6 characters.');
  assert.equal(F.validate(src, { doc: doc({ DODAAC: 'W45-YZ' }) }).message, 'DODAAC must be alphanumeric.');
  assert.deepEqual(F.validate('1', {}), { ok: true }, 'legacy formulas returning a number are treated as success');
  assert.equal(F.translate('@UpperCase(@Trim(DODAAC))', { doc: doc({ DODAAC: ' w45xyz ' }), fieldName: 'DODAAC' }), 'W45XYZ');
});

test('formula: SELECT formulas', () => {
  assert.equal(F.selects('SELECT Form = "Request" & Status != "Cancelled"', doc({ Form: 'Request', Status: 'Submitted' })), true);
  assert.equal(F.selects('SELECT Form = "Request" & Status != "Cancelled"', doc({ Form: 'Request', Status: 'Cancelled' })), false);
  assert.equal(F.selects('SELECT @All', doc({ Form: 'X' })), true);
  assert.equal(F.selects('SELECT @IsResponseDoc', { ...doc({}), parent: 'ABC' }), true);
});

test('formula: matchesToRegExp converts Notes wildcards', () => {
  const re = F.matchesToRegExp('W{A-Z0-9}{A-Z0-9}{A-Z0-9}{A-Z0-9}{A-Z0-9}');
  assert.ok(re.test('W12AB3'));
  assert.ok(!re.test('X12AB3'));
  assert.ok(!re.test('W12AB'));
  assert.ok(F.matchesToRegExp('*Medal').test('Bronze Star Medal'));
  assert.ok(F.matchesToRegExp('?ABC').test('XABC'));
  assert.ok(!F.matchesToRegExp('?ABC').test('XXABC'));
  assert.ok(F.matchesToRegExp('{0-9}+').test('12345'));
  assert.ok(!F.matchesToRegExp('{0-9}+').test('1234A'));
  assert.ok(F.matchesToRegExp('{!0-9}?').test('AB'));
  assert.ok(F.matchesToRegExp('a\\*b').test('a*b'));
});

test('formula: syntax errors are reported with position, unknown @functions fail at eval', () => {
  assert.throws(() => F.compile('@If(1; 2'), F.FormulaError);
  assert.throws(() => F.compile('1 +'), F.FormulaError);
  assert.throws(() => val('@NoSuchFunction(1)'), /Unsupported @function @NoSuchFunction/);
  assert.ok(val('1 / 0') instanceof F.FormulaErrorValue, 'runtime errors surface as error values');
});

test('formula: every formula in the shipped design compiles', () => {
  let count = 0;
  for (const nsf of ['heraldry.nsf', 'vetmedals.nsf']) {
    const design = dxl.loadDesign(path.join(REPO_ROOT, 'nsf', nsf));
    for (const form of design.forms.concat(design.subforms || [])) {
      for (const f of form.fields) {
        for (const src of [f.defaultValue, f.value, f.inputTranslation, f.inputValidation, f.keywordFormula]) {
          if (src) {
            F.compile(src);
            count += 1;
          }
        }
      }
      for (const a of form.actions || []) {
        if (a.language === 'formula' && a.click) {
          F.compile(a.click);
          count += 1;
        }
        if (a.hideWhen) {
          F.compile(a.hideWhen);
          count += 1;
        }
      }
    }
    for (const view of design.views) {
      F.compile(view.selection);
      count += 1;
      for (const c of view.columns) {
        if (c.formula) {
          F.compile(c.formula);
          count += 1;
        }
      }
    }
  }
  assert.ok(count > 300, `compiled ${count} formulas`);
});

test('formula: validation formulas on Request enforce the DD 1348-6 header rules', () => {
  const design = dxl.loadDesign(path.join(REPO_ROOT, 'nsf', 'heraldry.nsf'));
  const form = design.forms.find((f) => f.name === 'Request');
  const field = (n) => form.fields.find((f) => f.name === n);
  const check = (n, items) => F.validate(field(n).inputValidation, { doc: doc(items), fieldName: n, isSaving: true });
  assert.equal(check('DODAAC', { DODAAC: 'W45XYZ' }).ok, true);
  assert.equal(check('DODAAC', { DODAAC: 'W45' }).ok, false);
  assert.equal(check('UIC', { UIC: 'WAHQAA' }).ok, true);
  assert.equal(check('UIC', { UIC: 'XAHQAA' }).ok, false, 'UIC must start with W');
  assert.equal(check('RPD', { RPD: '03' }).ok, true);
  assert.equal(check('RPD', { RPD: '16' }).ok, false);
  assert.equal(check('RPD', { RPD: '00' }).ok, false);
  assert.equal(check('ShipToZIP', { ShipToZIP: '79916' }).ok, true);
  assert.equal(check('ShipToZIP', { ShipToZIP: '7991' }).ok, false);
  const catalog = fs.existsSync(path.join(REPO_ROOT, 'nsf', 'heraldry.nsf', 'formulas'));
  assert.ok(catalog, 'formulas/ catalogue exists');
});
