'use strict';

/**
 * A port of the Notes @Formula language subset used by the HAAS design.
 *
 * The forms in nsf/*.nsf/forms/*.dxl carry their business rules as @Formula input
 * translation / validation / default value / computed value formulas, and the views
 * carry selection and column formulas.  Rather than re-typing those rules in JavaScript
 * (and letting the two drift apart) the harness evaluates the formula text straight
 * from the DXL.
 *
 * Supported: text/number/date lists, ":" list concatenation, pairwise operators,
 * temporary variables with ":=", FIELD/SELECT/DEFAULT keywords, @If/@Do/@Return lazy
 * evaluation, @Failure/@Success validation results, @IsError sentinels, and ~70 of the
 * @functions (see FUNCTIONS).  @DbLookup/@DbColumn/@GetProfileField/@UserRoles are
 * delegated to the evaluation context so the caller decides what "the database" is.
 */

class FormulaError extends Error {
  constructor(msg, pos) {
    super(pos !== undefined ? `${msg} (at ${pos})` : msg);
    this.name = 'FormulaError';
  }
}

/** Marker returned by @Failure. */
class Failure {
  constructor(message) {
    this.message = message;
  }
}
const SUCCESS = Object.freeze({ success: true });

/** Marker for an @Function error (e.g. failed @DbLookup) - detected with @IsError. */
class FormulaErrorValue {
  constructor(message) {
    this.message = message;
  }
}

// --- lexer ------------------------------------------------------------------------------------

const KEYWORDS = new Set(['SELECT', 'FIELD', 'DEFAULT', 'ENVIRONMENT', 'REM']);

function tokenize(src) {
  const tokens = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let s = '';
      while (j < n) {
        if (src[j] === '\\' && j + 1 < n) {
          s += src[j + 1];
          j += 2;
          continue;
        }
        if (src[j] === '"') {
          if (src[j + 1] === '"') {
            s += '"';
            j += 2;
            continue;
          }
          break;
        }
        s += src[j];
        j++;
      }
      if (j >= n) {
        throw new FormulaError('Unterminated string literal', i);
      }
      tokens.push({ t: 'str', v: s, pos: i });
      i = j + 1;
      continue;
    }
    if (ch === '{') {
      const j = src.indexOf('}', i + 1);
      if (j === -1) {
        throw new FormulaError('Unterminated {string} literal', i);
      }
      tokens.push({ t: 'str', v: src.slice(i + 1, j), pos: i });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      const m = /^[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?|^[0-9]+\.?/.exec(src.slice(i));
      tokens.push({ t: 'num', v: Number(m[0]), pos: i });
      i += m[0].length;
      continue;
    }
    if (ch === '@' || ch === '$' || ch === '_' || /[A-Za-z]/.test(ch)) {
      const m = /^[@$A-Za-z_][A-Za-z0-9_$]*/.exec(src.slice(i));
      const word = m[0];
      if (word.startsWith('@')) {
        tokens.push({ t: 'func', v: word, pos: i });
      } else if (KEYWORDS.has(word.toUpperCase())) {
        tokens.push({ t: 'kw', v: word.toUpperCase(), pos: i });
      } else {
        tokens.push({ t: 'ident', v: word, pos: i });
      }
      i += word.length;
      continue;
    }
    if (ch === '[') {
      const j = src.indexOf(']', i);
      if (j === -1) {
        throw new FormulaError('Unterminated [keyword]', i);
      }
      tokens.push({ t: 'str', v: src.slice(i, j + 1), pos: i });
      i = j + 1;
      continue;
    }
    const two = src.slice(i, i + 2);
    if ([':=', '!=', '<>', '<=', '>=', '=<', '=>', '*=', '/=', '+=', '-=', '*<', '*>', '*!'].includes(two)) {
      tokens.push({ t: 'op', v: two, pos: i });
      i += 2;
      continue;
    }
    if ('+-*/=<>&|!:;()'.includes(ch)) {
      tokens.push({ t: 'op', v: ch, pos: i });
      i++;
      continue;
    }
    throw new FormulaError(`Unexpected character '${ch}'`, i);
  }
  tokens.push({ t: 'eof', pos: n });
  return tokens;
}

// --- parser -----------------------------------------------------------------------------------

class Parser {
  constructor(tokens) {
    this.toks = tokens;
    this.i = 0;
  }

  peek(offset = 0) {
    return this.toks[this.i + offset];
  }

  next() {
    return this.toks[this.i++];
  }

  accept(t, v) {
    const tok = this.peek();
    if (tok.t === t && (v === undefined || tok.v === v)) {
      this.i++;
      return tok;
    }
    return null;
  }

  expect(t, v) {
    const tok = this.accept(t, v);
    if (!tok) {
      const got = this.peek();
      throw new FormulaError(`Expected ${v || t} but found ${got.t === 'eof' ? 'end of formula' : `'${got.v}'`}`, got.pos);
    }
    return tok;
  }

  parseProgram() {
    const statements = [];
    while (this.peek().t !== 'eof') {
      if (this.accept('op', ';')) {
        continue;
      }
      statements.push(this.parseStatement());
      if (this.peek().t !== 'eof') {
        this.expect('op', ';');
      }
    }
    return { type: 'program', statements };
  }

  parseStatement() {
    const tok = this.peek();
    if (tok.t === 'kw') {
      this.next();
      if (tok.v === 'REM') {
        const s = this.expect('str');
        return { type: 'rem', text: s.v };
      }
      if (tok.v === 'SELECT') {
        return { type: 'select', expr: this.parseExpr() };
      }
      if (tok.v === 'FIELD' || tok.v === 'DEFAULT' || tok.v === 'ENVIRONMENT') {
        const name = this.expect('ident').v;
        this.expect('op', ':=');
        return { type: tok.v.toLowerCase(), name, expr: this.parseExpr() };
      }
    }
    if (tok.t === 'ident' && this.peek(1).t === 'op' && this.peek(1).v === ':=') {
      this.next();
      this.next();
      return { type: 'assign', name: tok.v, expr: this.parseExpr() };
    }
    return { type: 'expr', expr: this.parseExpr() };
  }

  parseExpr() {
    return this.parseOr();
  }

  parseOr() {
    let left = this.parseAnd();
    while (this.peek().t === 'op' && this.peek().v === '|') {
      this.next();
      left = { type: 'bin', op: '|', left, right: this.parseAnd() };
    }
    return left;
  }

  parseAnd() {
    let left = this.parseCompare();
    while (this.peek().t === 'op' && this.peek().v === '&') {
      this.next();
      left = { type: 'bin', op: '&', left, right: this.parseCompare() };
    }
    return left;
  }

  parseCompare() {
    let left = this.parseAdd();
    for (;;) {
      const tok = this.peek();
      if (tok.t === 'op' && ['=', '!=', '<>', '<', '>', '<=', '>=', '=<', '=>', '*=', '*<', '*>', '*!'].includes(tok.v)) {
        this.next();
        left = { type: 'bin', op: tok.v === '<>' ? '!=' : tok.v === '=<' ? '<=' : tok.v === '=>' ? '>=' : tok.v, left, right: this.parseAdd() };
      } else {
        return left;
      }
    }
  }

  parseAdd() {
    let left = this.parseMul();
    for (;;) {
      const tok = this.peek();
      if (tok.t === 'op' && (tok.v === '+' || tok.v === '-' || tok.v === '+=' || tok.v === '-=')) {
        this.next();
        left = { type: 'bin', op: tok.v[0], left, right: this.parseMul() };
      } else {
        return left;
      }
    }
  }

  parseMul() {
    let left = this.parseUnary();
    for (;;) {
      const tok = this.peek();
      if (tok.t === 'op' && (tok.v === '*' || tok.v === '/' || tok.v === '/=')) {
        this.next();
        left = { type: 'bin', op: tok.v[0], left, right: this.parseUnary() };
      } else {
        return left;
      }
    }
  }

  parseUnary() {
    const tok = this.peek();
    if (tok.t === 'op' && (tok.v === '!' || tok.v === '-' || tok.v === '+')) {
      this.next();
      return { type: 'unary', op: tok.v, expr: this.parseUnary() };
    }
    return this.parseList();
  }

  parseList() {
    let left = this.parsePrimary();
    while (this.peek().t === 'op' && this.peek().v === ':') {
      this.next();
      left = { type: 'list', left, right: this.parsePrimary() };
    }
    return left;
  }

  parsePrimary() {
    const tok = this.next();
    switch (tok.t) {
      case 'str':
        return { type: 'str', value: tok.v };
      case 'num':
        return { type: 'num', value: tok.v };
      case 'ident':
        return { type: 'field', name: tok.v };
      case 'func': {
        const args = [];
        if (this.accept('op', '(')) {
          if (!this.accept('op', ')')) {
            for (;;) {
              args.push(this.parseExpr());
              if (this.accept('op', ')')) {
                break;
              }
              this.expect('op', ';');
            }
          }
        }
        return { type: 'call', name: tok.v, args, pos: tok.pos };
      }
      case 'op':
        if (tok.v === '(') {
          const e = this.parseExpr();
          this.expect('op', ')');
          return e;
        }
        throw new FormulaError(`Unexpected operator '${tok.v}'`, tok.pos);
      case 'kw':
        if (tok.v === 'FIELD' || tok.v === 'DEFAULT') {
          const name = this.expect('ident').v;
          this.expect('op', ':=');
          return { type: 'fieldexpr', keyword: tok.v.toLowerCase(), name, expr: this.parseExpr() };
        }
        throw new FormulaError(`Unexpected keyword '${tok.v}'`, tok.pos);
      default:
        throw new FormulaError('Unexpected end of formula', tok.pos);
    }
  }
}

function parse(src) {
  return new Parser(tokenize(src)).parseProgram();
}

// --- value helpers ----------------------------------------------------------------------------

function toList(v) {
  if (v === undefined || v === null) {
    return [''];
  }
  if (Array.isArray(v)) {
    return v.length === 0 ? [''] : v;
  }
  return [v];
}

function isDateValue(v) {
  return v instanceof Date;
}

function asText(v) {
  if (v === undefined || v === null) {
    return '';
  }
  if (isDateValue(v)) {
    return formatDate(v, '');
  }
  if (typeof v === 'boolean') {
    return v ? '1' : '0';
  }
  if (typeof v === 'number') {
    return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(10)));
  }
  return String(v);
}

function asNumber(v) {
  if (typeof v === 'number') {
    return v;
  }
  if (typeof v === 'boolean') {
    return v ? 1 : 0;
  }
  if (isDateValue(v)) {
    return v.getTime() / 1000;
  }
  const n = Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : NaN;
}

function truthy(v) {
  return toList(v).some((x) => (typeof x === 'number' ? x !== 0 : typeof x === 'boolean' ? x : asNumber(x) !== 0 && String(x) !== ''));
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Notes-style @Text for dates. Notes default is "MM/DD/YYYY hh:mm:ss AM"; the "S0" component
 * limits to the date, "S1" to the time.  Date-only values (no time part) print as a date.
 */
function formatDate(d, fmt) {
  if (Number.isNaN(d.getTime())) {
    return '';
  }
  const dateOnly = d.dateOnly === true;
  const date = `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}/${d.getFullYear()}`;
  let h = d.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 === 0 ? 12 : h % 12;
  const time = `${pad2(h)}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())} ${ampm}`;
  const f = String(fmt || '');
  if (/S0/.test(f) || (dateOnly && !/S[12]/.test(f))) {
    return date;
  }
  if (/S1/.test(f)) {
    return time;
  }
  return `${date} ${time}`;
}

/** Parse the many date shapes a legacy Notes database contains into a Date (or null). */
function parseDateValue(v) {
  if (isDateValue(v)) {
    return v;
  }
  if (typeof v !== 'string') {
    return null;
  }
  const s = v.trim();
  if (!s) {
    return null;
  }
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(s);
  if (m) {
    if (m[4] === undefined) {
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      d.dateOnly = true;
      return d;
    }
    if (m[7]) {
      return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}${m[7] === 'Z' ? 'Z' : m[7].includes(':') ? m[7] : `${m[7].slice(0, 3)}:${m[7].slice(3)}`}`);
    }
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] || 0));
  }
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i.exec(s);
  if (m) {
    if (m[4] === undefined) {
      const d = new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
      d.dateOnly = true;
      return d;
    }
    let h = Number(m[4]);
    if (m[7]) {
      const pm = m[7].toUpperCase() === 'PM';
      h = (h % 12) + (pm ? 12 : 0);
    }
    return new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]), h, Number(m[5]), Number(m[6] || 0));
  }
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    d.dateOnly = true;
    return d;
  }
  m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(s);
  if (m) {
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const idx = months.indexOf(m[2].toLowerCase());
    if (idx >= 0) {
      const d = new Date(Number(m[3]), idx, Number(m[1]));
      d.dateOnly = true;
      return d;
    }
  }
  return null;
}

function compare(a, b, op) {
  let x = a;
  let y = b;
  if (isDateValue(x) || isDateValue(y)) {
    const dx = parseDateValue(x);
    const dy = parseDateValue(y);
    if (dx && dy) {
      x = dx.getTime();
      y = dy.getTime();
    } else {
      x = asText(x);
      y = asText(y);
    }
  } else if (typeof x === 'number' || typeof y === 'number') {
    const nx = asNumber(x);
    const ny = asNumber(y);
    if (Number.isNaN(nx) || Number.isNaN(ny)) {
      x = asText(x);
      y = asText(y);
    } else {
      x = nx;
      y = ny;
    }
  } else {
    x = asText(x);
    y = asText(y);
  }
  switch (op) {
    case '=':
      return x === y;
    case '!=':
      return x !== y;
    case '<':
      return x < y;
    case '>':
      return x > y;
    case '<=':
      return x <= y;
    case '>=':
      return x >= y;
    default:
      throw new FormulaError(`Unknown comparison ${op}`);
  }
}

/** Pairwise list operation: shorter list is extended with its last element (Notes semantics). */
function pairwise(a, b, fn) {
  const la = toList(a);
  const lb = toList(b);
  const len = Math.max(la.length, lb.length);
  const out = [];
  for (let i = 0; i < len; i++) {
    out.push(fn(la[Math.min(i, la.length - 1)], lb[Math.min(i, lb.length - 1)]));
  }
  return out.length === 1 ? out[0] : out;
}

/** Notes @Matches wildcard pattern -> RegExp.  ? = one char, * = any run, {set}, +x = one or more x, \ escapes. */
function matchesToRegExp(pattern) {
  // Notes wildcards: ? one char, * any string, + repeats the preceding atom,
  // {set} / {!set} character classes, \ escapes the next character.
  let re = '^';
  let i = 0;
  // wrap() consumes the atom ending at index `end` (exclusive) plus any trailing '+'
  const wrap = (atom, end) => {
    if (pattern[end] === '+') {
      re += `(?:${atom})+`;
      i = end + 1;
    } else {
      re += atom;
      i = end;
    }
  };
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '\\' && i + 1 < pattern.length) {
      wrap(pattern[i + 1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), i + 2);
    } else if (ch === '?') {
      wrap('.', i + 1);
    } else if (ch === '*') {
      re += '.*';
      i++;
    } else if (ch === '+') {
      re += '.*';
      i++;
    } else if (ch === '{') {
      const j = pattern.indexOf('}', i);
      if (j === -1) {
        throw new FormulaError('Unterminated {set} in @Matches pattern');
      }
      let body = pattern.slice(i + 1, j);
      let neg = false;
      if (body.startsWith('!')) {
        neg = true;
        body = body.slice(1);
      }
      wrap(`[${neg ? '^' : ''}${body.replace(/[\]\\^]/g, '\\$&')}]`, j + 1);
    } else {
      wrap(ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), i + 1);
    }
  }
  return new RegExp(`${re}$`, 's');
}

function notesName(name, part) {
  const s = asText(name);
  const parts = {};
  for (const seg of s.split('/')) {
    const m = /^(\w+)=(.*)$/.exec(seg.trim());
    if (m) {
      const k = m[1].toUpperCase();
      parts[k] = parts[k] ? parts[k] : m[2];
      if (k === 'OU') {
        parts.OUs = (parts.OUs || []).concat(m[2]);
      }
    } else if (!parts.CN) {
      parts.CN = seg.trim();
    }
  }
  switch (String(part).toUpperCase()) {
    case '[CN]':
      return parts.CN || s;
    case '[O]':
      return parts.O || '';
    case '[OU]':
    case '[OU1]':
      return parts.OUs ? parts.OUs[0] : '';
    case '[ABBREVIATE]':
      return s.replace(/\b(CN|OU|O|C)=/g, '');
    case '[CANONICALIZE]':
      return s.includes('=') ? s : `CN=${s}`;
    default:
      return s;
  }
}

// --- evaluator --------------------------------------------------------------------------------

/**
 * Evaluation context:
 *   doc:        { items: {name: value} }   - the current document (values may be lists)
 *   isNewDoc:   boolean
 *   userName:   canonical Notes name of the current user
 *   roles:      ['[TACOM]', ...]
 *   now:        Date (defaults to new Date())
 *   dbLookup(dbSpec, viewName, key, columnOrField) -> value | FormulaErrorValue
 *   dbColumn(dbSpec, viewName, column) -> value | FormulaErrorValue
 *   profileField(profileName, fieldName) -> value
 *   docLength / attachments (optional)
 */
class Evaluator {
  constructor(ctx) {
    this.ctx = ctx || {};
    this.doc = this.ctx.doc || { items: {} };
    this.vars = new Map();
    this.fieldWrites = {};
    this.selectResult = true;
  }

  now() {
    return this.ctx.now ? new Date(this.ctx.now) : new Date();
  }

  today() {
    const d = this.now();
    d.setHours(0, 0, 0, 0);
    d.dateOnly = true;
    return d;
  }

  lookupField(name) {
    if (this.vars.has(name)) {
      return this.vars.get(name);
    }
    if (Object.prototype.hasOwnProperty.call(this.fieldWrites, name)) {
      return this.fieldWrites[name];
    }
    const items = this.doc.items || {};
    if (Object.prototype.hasOwnProperty.call(items, name)) {
      return items[name];
    }
    const key = Object.keys(items).find((k) => k.toLowerCase() === name.toLowerCase());
    if (key !== undefined) {
      return items[key];
    }
    return '';
  }

  hasField(name) {
    const items = this.doc.items || {};
    if (Object.prototype.hasOwnProperty.call(this.fieldWrites, name)) {
      return true;
    }
    return Object.keys(items).some((k) => k.toLowerCase() === name.toLowerCase());
  }

  run(program) {
    let last = '';
    for (const st of program.statements) {
      last = this.exec(st);
      if (last instanceof Failure || (last && last.__return)) {
        return last && last.__return ? last.value : last;
      }
    }
    return last;
  }

  exec(st) {
    switch (st.type) {
      case 'rem':
        return '';
      case 'select':
        this.selectResult = truthy(this.eval(st.expr));
        return this.selectResult ? 1 : 0;
      case 'assign': {
        const v = this.eval(st.expr);
        this.vars.set(st.name, v);
        return v;
      }
      case 'field': {
        const v = this.eval(st.expr);
        this.fieldWrites[st.name] = v;
        return v;
      }
      case 'default': {
        if (!this.hasField(st.name)) {
          this.fieldWrites[st.name] = this.eval(st.expr);
        }
        return this.lookupField(st.name);
      }
      case 'environment':
        return this.eval(st.expr);
      case 'expr':
        return this.eval(st.expr);
      default:
        throw new FormulaError(`Unknown statement ${st.type}`);
    }
  }

  eval(node) {
    switch (node.type) {
      case 'str':
        return node.value;
      case 'num':
        return node.value;
      case 'field':
        return this.lookupField(node.name);
      case 'list': {
        const l = toList(this.eval(node.left));
        const r = toList(this.eval(node.right));
        return l.concat(r);
      }
      case 'unary': {
        const v = this.eval(node.expr);
        if (node.op === '!') {
          return truthy(v) ? 0 : 1;
        }
        if (node.op === '-') {
          return pairwise(v, 0, (a) => -asNumber(a));
        }
        return v;
      }
      case 'bin':
        return this.evalBinary(node);
      case 'call':
        return this.call(node);
      case 'fieldexpr':
        return this.exec({ type: node.keyword, name: node.name, expr: node.expr });
      default:
        throw new FormulaError(`Unknown node ${node.type}`);
    }
  }

  evalBinary(node) {
    const op = node.op;
    if (op === '&') {
      return truthy(this.eval(node.left)) && truthy(this.eval(node.right)) ? 1 : 0;
    }
    if (op === '|') {
      return truthy(this.eval(node.left)) || truthy(this.eval(node.right)) ? 1 : 0;
    }
    const left = this.eval(node.left);
    const right = this.eval(node.right);
    if (left instanceof FormulaErrorValue) {
      return left;
    }
    if (right instanceof FormulaErrorValue) {
      return right;
    }
    if (['=', '!=', '<', '>', '<=', '>='].includes(op)) {
      // Notes list comparison: true when ANY pair satisfies the test (= and inequalities)
      const la = toList(left);
      const lb = toList(right);
      if (op === '!=') {
        return la.every((a) => lb.every((b) => compare(a, b, '!='))) ? 1 : 0;
      }
      return la.some((a) => lb.some((b) => compare(a, b, op))) ? 1 : 0;
    }
    if (op.length === 2 && op[0] === '*') {
      // permuted operators *= *< *> *!  produce one result per (left, right) pair
      const la = toList(left);
      const lb = toList(right);
      const cop = op === '*!' ? '!=' : op.slice(1);
      const out = [];
      for (const a of la) {
        for (const b of lb) {
          out.push(compare(a, b, cop) ? 1 : 0);
        }
      }
      return out.length === 1 ? out[0] : out;
    }
    if (op === '+') {
      return pairwise(left, right, (a, b) => {
        if (isDateValue(a) && typeof b === 'number') {
          return new Date(a.getTime() + b * 1000);
        }
        if (typeof a === 'number' && typeof b === 'number') {
          return a + b;
        }
        if (typeof a === 'string' || typeof b === 'string') {
          return asText(a) + asText(b);
        }
        return asNumber(a) + asNumber(b);
      });
    }
    if (op === '-') {
      return pairwise(left, right, (a, b) => {
        if (isDateValue(a) || isDateValue(b)) {
          const da = parseDateValue(a);
          const db = parseDateValue(b);
          if (da && db) {
            return Math.round((da.getTime() - db.getTime()) / 1000);
          }
          if (da && typeof b === 'number') {
            return new Date(da.getTime() - b * 1000);
          }
        }
        return asNumber(a) - asNumber(b);
      });
    }
    if (op === '*') {
      return pairwise(left, right, (a, b) => asNumber(a) * asNumber(b));
    }
    if (op === '/') {
      return pairwise(left, right, (a, b) => {
        const d = asNumber(b);
        return d === 0 ? new FormulaErrorValue('Division by zero') : asNumber(a) / d;
      });
    }
    throw new FormulaError(`Unsupported operator ${op}`);
  }

  argValues(node) {
    return node.args.map((a) => this.eval(a));
  }

  call(node) {
    const name = node.name.toLowerCase();
    // lazy forms
    switch (name) {
      case '@if': {
        const args = node.args;
        if (args.length < 3 || args.length % 2 === 0) {
          throw new FormulaError('@If requires an odd number of arguments (at least 3)', node.pos);
        }
        for (let i = 0; i + 1 < args.length; i += 2) {
          if (truthy(this.eval(args[i]))) {
            return this.eval(args[i + 1]);
          }
        }
        return this.eval(args[args.length - 1]);
      }
      case '@do': {
        let last = '';
        for (const a of node.args) {
          last = this.eval(a);
          if (last instanceof Failure) {
            return last;
          }
        }
        return last;
      }
      case '@return':
        return { __return: true, value: this.eval(node.args[0]) };
      case '@isavailable':
        return node.args.every((a) => a.type === 'field' && this.hasField(a.name)) ? 1 : 0;
      case '@isunavailable':
        return node.args.every((a) => a.type === 'field' && !this.hasField(a.name)) ? 1 : 0;
      case '@iserror': {
        const v = this.eval(node.args[0]);
        return v instanceof FormulaErrorValue || toList(v).some((x) => x instanceof FormulaErrorValue) ? 1 : 0;
      }
      case '@setfield': {
        const fname = asText(this.eval(node.args[0]));
        const v = this.eval(node.args[1]);
        this.fieldWrites[fname] = v;
        return v;
      }
      case '@command':
      case '@postedcommand':
      case '@prompt':
      case '@dialogbox':
      case '@mailsend':
      case '@statusbar':
        return '';
      default:
        break;
    }
    const fn = FUNCTIONS[name];
    if (!fn) {
      throw new FormulaError(`Unsupported @function ${node.name}`, node.pos);
    }
    const args = this.argValues(node);
    for (const a of args) {
      if (a instanceof FormulaErrorValue && !['@text', '@isnumber', '@istext', '@istime'].includes(name)) {
        return a;
      }
    }
    return fn(this, args, node);
  }
}

function mapText(args, fn) {
  return pairwise(args[0], 0, (a) => fn(asText(a)));
}

const FUNCTIONS = {
  '@success': () => SUCCESS,
  '@failure': (ev, args) => new Failure(asText(toList(args[0])[0])),
  '@true': () => 1,
  '@false': () => 0,
  '@yes': () => 1,
  '@no': () => 0,
  '@nothing': () => '',
  '@all': () => 1,
  '@trim': (ev, args) => {
    const l = toList(args[0]).map((x) => asText(x).trim().replace(/\s+/g, ' ')).filter((x) => x !== '');
    return l.length === 0 ? '' : l.length === 1 ? l[0] : l;
  },
  '@uppercase': (ev, args) => mapText(args, (s) => s.toUpperCase()),
  '@lowercase': (ev, args) => mapText(args, (s) => s.toLowerCase()),
  '@propercase': (ev, args) => mapText(args, (s) => s.toLowerCase().replace(/(^|[\s\-'])(\p{L})/gu, (m, p, c) => p + c.toUpperCase())),
  '@length': (ev, args) => pairwise(args[0], 0, (a) => asText(a).length),
  '@left': (ev, args) => pairwise(args[0], args[1], (a, b) => {
    const s = asText(a);
    if (typeof b === 'number') {
      return s.slice(0, Math.max(0, b));
    }
    const idx = s.indexOf(asText(b));
    return idx === -1 ? '' : s.slice(0, idx);
  }),
  '@right': (ev, args) => pairwise(args[0], args[1], (a, b) => {
    const s = asText(a);
    if (typeof b === 'number') {
      return b <= 0 ? '' : s.slice(-b);
    }
    const idx = s.indexOf(asText(b));
    return idx === -1 ? '' : s.slice(idx + asText(b).length);
  }),
  '@middle': (ev, args) => {
    const s = asText(toList(args[0])[0]);
    const off = asNumber(toList(args[1])[0]);
    const len = asNumber(toList(args[2])[0]);
    return s.substr(off, len);
  },
  '@leftback': (ev, args) => pairwise(args[0], args[1], (a, b) => {
    const s = asText(a);
    if (typeof b === 'number') {
      return s.slice(0, Math.max(0, s.length - b));
    }
    const idx = s.lastIndexOf(asText(b));
    return idx === -1 ? '' : s.slice(0, idx);
  }),
  '@rightback': (ev, args) => pairwise(args[0], args[1], (a, b) => {
    const s = asText(a);
    if (typeof b === 'number') {
      return s.slice(Math.max(0, s.length - (s.length - b)));
    }
    const idx = s.lastIndexOf(asText(b));
    return idx === -1 ? '' : s.slice(idx + asText(b).length);
  }),
  '@contains': (ev, args) => (toList(args[0]).some((a) => toList(args[1]).some((b) => asText(a).includes(asText(b)))) ? 1 : 0),
  '@begins': (ev, args) => (toList(args[0]).some((a) => toList(args[1]).some((b) => asText(a).startsWith(asText(b)))) ? 1 : 0),
  '@ends': (ev, args) => (toList(args[0]).some((a) => toList(args[1]).some((b) => asText(a).endsWith(asText(b)))) ? 1 : 0),
  '@matches': (ev, args) => {
    const patterns = toList(args[1]).map((p) => matchesToRegExp(asText(p)));
    return toList(args[0]).some((a) => patterns.some((re) => re.test(asText(a)))) ? 1 : 0;
  },
  '@like': (ev, args) => {
    const patterns = toList(args[1]).map((p) => new RegExp(`^${asText(p).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.')}$`, 'is'));
    return toList(args[0]).some((a) => patterns.some((re) => re.test(asText(a)))) ? 1 : 0;
  },
  '@replacesubstring': (ev, args) => {
    const from = toList(args[1]).map(asText);
    const to = toList(args[2]).map(asText);
    return pairwise(args[0], 0, (a) => {
      let s = asText(a);
      from.forEach((f, i) => {
        if (f !== '') {
          s = s.split(f).join(to[Math.min(i, to.length - 1)]);
        }
      });
      return s;
    });
  },
  '@replace': (ev, args) => {
    const from = toList(args[1]).map(asText);
    const to = toList(args[2]).map(asText);
    return pairwise(args[0], 0, (a) => {
      const idx = from.indexOf(asText(a));
      return idx === -1 ? a : to[Math.min(idx, to.length - 1)];
    });
  },
  '@word': (ev, args) => {
    const sep = asText(toList(args[1])[0]);
    const n = asNumber(toList(args[2])[0]);
    return pairwise(args[0], 0, (a) => {
      const parts = asText(a).split(sep);
      return n < 0 ? parts[parts.length + n] || '' : parts[n - 1] || '';
    });
  },
  '@explode': (ev, args) => {
    const seps = args.length > 1 ? asText(toList(args[1])[0]) : ' ,;';
    const re = new RegExp(`[${seps.replace(/[\]\\^-]/g, '\\$&')}]`);
    const out = [];
    for (const a of toList(args[0])) {
      out.push(...asText(a).split(re).filter((x) => x !== ''));
    }
    return out.length === 0 ? '' : out;
  },
  '@implode': (ev, args) => toList(args[0]).map(asText).join(args.length > 1 ? asText(toList(args[1])[0]) : ' '),
  '@repeat': (ev, args) => pairwise(args[0], args[1], (a, b) => asText(a).repeat(Math.max(0, asNumber(b)))),
  '@char': (ev, args) => pairwise(args[0], 0, (a) => String.fromCharCode(asNumber(a))),
  '@ascii': (ev, args) => pairwise(args[0], 0, (a) => asText(a)),
  '@abstract': (ev, args) => {
    const size = asNumber(toList(args[1])[0]) || 100;
    const fields = toList(args[3] === undefined ? '' : args[3]).map(asText);
    const text = fields.map((f) => toList(ev.lookupField(f)).map(asText).join(' ')).join(' ').trim();
    return text.length > size ? `${text.slice(0, size - 3)}...` : text;
  },
  '@text': (ev, args) => {
    const fmt = args.length > 1 ? asText(toList(args[1])[0]) : '';
    return pairwise(args[0], 0, (a) => {
      if (a instanceof FormulaErrorValue) {
        return `@ERROR: ${a.message}`;
      }
      if (isDateValue(a)) {
        return formatDate(a, fmt);
      }
      if (typeof a === 'number') {
        const fm = /F(\d)/.exec(fmt);
        let s = fm ? a.toFixed(Number(fm[1])) : asText(a);
        if (/,/.test(fmt)) {
          const [ip, fp] = s.split('.');
          s = ip.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fp !== undefined ? `.${fp}` : '');
        }
        if (/C/.test(fmt)) {
          s = `$${s}`;
        }
        if (/%/.test(fmt)) {
          s = `${s}%`;
        }
        return s;
      }
      if (typeof a === 'string' && /D0|S0|S2|T0/.test(fmt)) {
        const d = parseDateValue(a);
        if (d) {
          return formatDate(d, fmt);
        }
      }
      return asText(a);
    });
  },
  '@texttonumber': (ev, args) => pairwise(args[0], 0, (a) => {
    const n = asNumber(a);
    return Number.isNaN(n) ? new FormulaErrorValue('Cannot convert text to number') : n;
  }),
  '@texttotime': (ev, args) => pairwise(args[0], 0, (a) => {
    const s = asText(a);
    if (/^today$/i.test(s)) {
      return ev.today();
    }
    if (/^yesterday$/i.test(s)) {
      const d = ev.today();
      d.setDate(d.getDate() - 1);
      d.dateOnly = true;
      return d;
    }
    if (/^tomorrow$/i.test(s)) {
      const d = ev.today();
      d.setDate(d.getDate() + 1);
      d.dateOnly = true;
      return d;
    }
    const d = parseDateValue(s);
    return d || new FormulaErrorValue('Cannot convert text to time/date');
  }),
  '@isnumber': (ev, args) => (toList(args[0]).every((a) => typeof a === 'number') ? 1 : 0),
  '@istext': (ev, args) => (toList(args[0]).every((a) => typeof a === 'string') ? 1 : 0),
  '@istime': (ev, args) => (toList(args[0]).every((a) => isDateValue(a)) ? 1 : 0),
  '@integer': (ev, args) => pairwise(args[0], 0, (a) => Math.trunc(asNumber(a))),
  '@round': (ev, args) => {
    // Notes semantics: the optional second argument is a rounding factor (e.g. 0.01), not a digit count
    const factor = args.length > 1 ? asNumber(toList(args[1])[0]) : 1;
    if (!factor) {
      return new FormulaErrorValue('@Round: rounding factor must be non-zero');
    }
    return pairwise(args[0], 0, (a) => Number((Math.round(asNumber(a) / factor) * factor).toFixed(10)));
  },
  '@abs': (ev, args) => pairwise(args[0], 0, (a) => Math.abs(asNumber(a))),
  '@modulo': (ev, args) => pairwise(args[0], args[1], (a, b) => asNumber(a) % asNumber(b)),
  '@sum': (ev, args) => args.reduce((s, l) => s + toList(l).reduce((t, x) => t + (asNumber(x) || 0), 0), 0),
  '@max': (ev, args) => Math.max(...args.flatMap((l) => toList(l).map(asNumber))),
  '@min': (ev, args) => Math.min(...args.flatMap((l) => toList(l).map(asNumber))),
  '@elements': (ev, args) => {
    const l = toList(args[0]);
    return l.length === 1 && l[0] === '' ? 0 : l.length;
  },
  '@subset': (ev, args) => {
    const l = toList(args[0]);
    const n = asNumber(toList(args[1])[0]);
    const out = n >= 0 ? l.slice(0, n) : l.slice(n);
    return out.length === 1 ? out[0] : out.length === 0 ? '' : out;
  },
  '@unique': (ev, args) => {
    if (args.length === 0) {
      return `${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1e6).toString(36).toUpperCase()}`;
    }
    const seen = new Set();
    const out = [];
    for (const x of toList(args[0])) {
      const k = asText(x);
      if (!seen.has(k)) {
        seen.add(k);
        out.push(x);
      }
    }
    return out.length === 1 ? out[0] : out;
  },
  '@ismember': (ev, args) => {
    const set = toList(args[1]).map(asText);
    return toList(args[0]).every((a) => set.includes(asText(a))) ? 1 : 0;
  },
  '@isnotmember': (ev, args) => {
    const set = toList(args[1]).map(asText);
    return toList(args[0]).every((a) => !set.includes(asText(a))) ? 1 : 0;
  },
  '@member': (ev, args) => {
    const set = toList(args[1]).map(asText);
    const idx = set.indexOf(asText(toList(args[0])[0]));
    return idx + 1;
  },
  '@select': (ev, args) => {
    const n = asNumber(toList(args[0])[0]);
    return args[Math.min(Math.max(1, n), args.length - 1)];
  },
  '@now': (ev) => ev.now(),
  '@today': (ev) => ev.today(),
  '@yesterday': (ev) => {
    const d = ev.today();
    d.setDate(d.getDate() - 1);
    d.dateOnly = true;
    return d;
  },
  '@tomorrow': (ev) => {
    const d = ev.today();
    d.setDate(d.getDate() + 1);
    d.dateOnly = true;
    return d;
  },
  '@date': (ev, args) => {
    if (args.length === 1) {
      const d = parseDateValue(toList(args[0])[0]);
      if (!d) {
        return new FormulaErrorValue('Invalid date');
      }
      const out = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      out.dateOnly = true;
      return out;
    }
    const d = new Date(asNumber(toList(args[0])[0]), asNumber(toList(args[1])[0]) - 1, asNumber(toList(args[2])[0]));
    d.dateOnly = true;
    return d;
  },
  '@year': (ev, args) => pairwise(args[0], 0, (a) => {
    const d = parseDateValue(a);
    return d ? d.getFullYear() : new FormulaErrorValue('Not a date');
  }),
  '@month': (ev, args) => pairwise(args[0], 0, (a) => {
    const d = parseDateValue(a);
    return d ? d.getMonth() + 1 : new FormulaErrorValue('Not a date');
  }),
  '@day': (ev, args) => pairwise(args[0], 0, (a) => {
    const d = parseDateValue(a);
    return d ? d.getDate() : new FormulaErrorValue('Not a date');
  }),
  '@weekday': (ev, args) => pairwise(args[0], 0, (a) => {
    const d = parseDateValue(a);
    return d ? d.getDay() + 1 : new FormulaErrorValue('Not a date');
  }),
  '@hour': (ev, args) => pairwise(args[0], 0, (a) => {
    const d = parseDateValue(a);
    return d ? d.getHours() : 0;
  }),
  '@adjust': (ev, args) => {
    const [y, mo, d, h, mi, s] = [1, 2, 3, 4, 5, 6].map((i) => (args[i] === undefined ? 0 : asNumber(toList(args[i])[0]) || 0));
    return pairwise(args[0], 0, (a) => {
      const base = parseDateValue(a);
      if (!base) {
        return new FormulaErrorValue('Not a date');
      }
      const out = new Date(base.getTime());
      out.setFullYear(out.getFullYear() + y, out.getMonth() + mo, out.getDate() + d);
      out.setHours(out.getHours() + h, out.getMinutes() + mi, out.getSeconds() + s);
      if (base.dateOnly && h === 0 && mi === 0 && s === 0) {
        out.dateOnly = true;
      }
      return out;
    });
  },
  '@businessdays': (ev, args) => {
    const a = parseDateValue(toList(args[0])[0]);
    const b = parseDateValue(toList(args[1])[0]);
    if (!a || !b) {
      return new FormulaErrorValue('Not a date');
    }
    let n = 0;
    const cur = new Date(a.getTime());
    while (cur <= b) {
      if (cur.getDay() !== 0 && cur.getDay() !== 6) {
        n++;
      }
      cur.setDate(cur.getDate() + 1);
    }
    return n;
  },
  '@zone': () => 5,
  '@username': (ev) => ev.ctx.userName || 'Anonymous',
  '@name': (ev, args) => pairwise(args[1], 0, (a) => notesName(a, asText(toList(args[0])[0]))),
  '@userroles': (ev) => (ev.ctx.roles && ev.ctx.roles.length ? ev.ctx.roles : ''),
  '@usernameslist': (ev) => [ev.ctx.userName || 'Anonymous'].concat(ev.ctx.roles || []),
  '@isnewdoc': (ev) => (ev.ctx.isNewDoc ? 1 : 0),
  '@isdocbeingedited': (ev) => (ev.ctx.isEditing ? 1 : 0),
  '@isdocbeingsaved': (ev) => (ev.ctx.isSaving ? 1 : 0),
  '@documentuniqueid': (ev) => ev.doc.unid || '',
  '@noteid': (ev) => ev.doc.noteid || '',
  '@created': (ev) => parseDateValue(ev.doc.created) || ev.now(),
  '@modified': (ev) => parseDateValue(ev.doc.modified) || ev.now(),
  '@accessed': (ev) => ev.now(),
  '@attachments': (ev) => (ev.doc.files ? ev.doc.files.length : 0),
  '@attachmentnames': (ev) => (ev.doc.files && ev.doc.files.length ? ev.doc.files.map((f) => f.name) : ''),
  '@doclength': (ev) => (ev.ctx.docLength !== undefined ? ev.ctx.docLength : JSON.stringify(ev.doc.items || {}).length),
  '@docnumber': (ev) => ev.ctx.docNumber || '',
  '@dbname': (ev) => [ev.ctx.serverName || '', ev.ctx.dbPath || ''],
  '@dbtitle': (ev) => ev.ctx.dbTitle || '',
  '@replicaid': (ev) => ev.ctx.replicaId || '',
  '@servername': (ev) => ev.ctx.serverName || '',
  '@getprofilefield': (ev, args) => {
    if (!ev.ctx.profileField) {
      return new FormulaErrorValue('No profile access');
    }
    const v = ev.ctx.profileField(asText(toList(args[0])[0]), asText(toList(args[1])[0]));
    return v === undefined || v === null ? '' : v;
  },
  '@dblookup': (ev, args) => {
    if (!ev.ctx.dbLookup) {
      return new FormulaErrorValue('No database access');
    }
    const [, db, view, key, col] = args;
    const v = ev.ctx.dbLookup(db, asText(toList(view)[0]), key, col, args[5]);
    return v === undefined || v === null ? new FormulaErrorValue('Entry not found in index') : v;
  },
  '@dbcolumn': (ev, args) => {
    if (!ev.ctx.dbColumn) {
      return new FormulaErrorValue('No database access');
    }
    const [, db, view, col] = args;
    const v = ev.ctx.dbColumn(db, asText(toList(view)[0]), col);
    return v === undefined || v === null ? new FormulaErrorValue('View not found') : v;
  },
  '@environment': (ev, args) => (ev.ctx.environment ? ev.ctx.environment[asText(toList(args[0])[0])] || '' : ''),
  '@platform': () => 'Harness',
  '@version': () => '1200',
  '@iscategory': () => '',
  '@isexpandable': () => '',
  '@docchildren': (ev) => (ev.ctx.docChildren !== undefined ? ev.ctx.docChildren : 0),
  '@docdescendants': (ev) => (ev.ctx.docChildren !== undefined ? ev.ctx.docChildren : 0),
  '@isresponsedoc': (ev) => (ev.doc.parent ? 1 : 0),
  '@sort': (ev, args) => {
    const l = toList(args[0]).slice();
    const desc = args.length > 1 && /descending/i.test(asText(toList(args[1])[0]));
    l.sort((a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : asText(a).localeCompare(asText(b))));
    return desc ? l.reverse() : l;
  },
  '@keywords': (ev, args) => {
    const words = toList(args[1]).map(asText);
    const found = [];
    for (const a of toList(args[0])) {
      for (const w of words) {
        if (new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(asText(a)) && !found.includes(w)) {
          found.push(w);
        }
      }
    }
    return found.length ? found : '';
  },
};

// --- public API -------------------------------------------------------------------------------

const cache = new Map();

function compile(src) {
  if (!cache.has(src)) {
    cache.set(src, parse(src));
  }
  return cache.get(src);
}

/** Evaluate a formula; returns the formula's value (list values as arrays, dates as Date). */
function evaluate(src, ctx) {
  const ev = new Evaluator(ctx);
  const result = ev.run(compile(src));
  return { value: result, fieldWrites: ev.fieldWrites, select: ev.selectResult };
}

/** Evaluate a SELECT formula against a document. */
function selects(src, doc, ctx) {
  const ev = new Evaluator({ ...ctx, doc });
  const r = ev.run(compile(src));
  const prog = compile(src);
  if (prog.statements.some((s) => s.type === 'select')) {
    return ev.selectResult;
  }
  return truthy(r);
}

/**
 * Run an input-validation formula. Returns { ok: true } or { ok: false, message }.
 * Formulas that evaluate to something other than @Success/@Failure (legacy habit:
 * returning a number) are treated as success, exactly as Domino does.
 */
function validate(src, ctx) {
  const ev = new Evaluator(ctx);
  const r = ev.run(compile(src));
  if (r instanceof Failure) {
    return { ok: false, message: r.message };
  }
  return { ok: true };
}

/** Run an input-translation formula and return the translated value. */
function translate(src, ctx) {
  const ev = new Evaluator(ctx);
  const r = ev.run(compile(src));
  if (r instanceof Failure) {
    return ctx.doc.items[ctx.fieldName];
  }
  return r instanceof FormulaErrorValue ? '' : r;
}

module.exports = {
  tokenize,
  parse,
  compile,
  evaluate,
  validate,
  translate,
  selects,
  Evaluator,
  Failure,
  FormulaErrorValue,
  FormulaError,
  SUCCESS,
  FUNCTIONS,
  matchesToRegExp,
  parseDateValue,
  formatDate,
  toList,
  asText,
  asNumber,
  truthy,
};
