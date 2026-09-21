'use strict';

/**
 * Minimal, dependency-free XML parser tuned for Domino DXL and XPages (.xsp) markup.
 *
 * Produces a plain object tree: { name, attrs, children, text }.  Text nodes are
 * represented as strings inside `children`.  Comments, processing instructions,
 * the DOCTYPE and CDATA sections are handled; namespaces are kept in the tag name
 * (e.g. "xp:inputText") because XPages markup relies on the prefix.
 *
 * Deliberately conservative: it throws on malformed input instead of guessing, so
 * that a corrupt export is noticed early by the harness and the test-suite.
 */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s) {
  if (s.indexOf('&') === -1) {
    return s;
  }
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, ent) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, ent) ? ENTITIES[ent] : m;
  });
}

function parseAttrs(s) {
  const attrs = {};
  const re = /([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    attrs[m[1]] = decodeEntities(m[2] !== undefined ? m[2] : m[3]);
  }
  return attrs;
}

class XmlError extends Error {
  constructor(msg, pos) {
    super(`${msg} (offset ${pos})`);
    this.name = 'XmlError';
    this.offset = pos;
  }
}

function parse(xml) {
  const root = { name: '#document', attrs: {}, children: [] };
  const stack = [root];
  let i = 0;
  const n = xml.length;

  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) {
      const tail = xml.slice(i);
      if (tail.trim() !== '' && stack.length > 1) {
        stack[stack.length - 1].children.push(decodeEntities(tail));
      }
      break;
    }
    if (lt > i) {
      const text = xml.slice(i, lt);
      if (stack.length > 1) {
        stack[stack.length - 1].children.push(decodeEntities(text));
      }
    }
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      if (end === -1) {
        throw new XmlError('Unterminated comment', lt);
      }
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      if (end === -1) {
        throw new XmlError('Unterminated CDATA section', lt);
      }
      stack[stack.length - 1].children.push(xml.slice(lt + 9, end));
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2);
      if (end === -1) {
        throw new XmlError('Unterminated processing instruction', lt);
      }
      i = end + 2;
      continue;
    }
    if (xml.startsWith('<!DOCTYPE', lt) || xml.startsWith('<!doctype', lt)) {
      // DOCTYPE may contain an internal subset in [...]
      let depth = 0;
      let j = lt;
      for (; j < n; j++) {
        const ch = xml[j];
        if (ch === '[') {
          depth++;
        } else if (ch === ']') {
          depth--;
        } else if (ch === '>' && depth === 0) {
          break;
        }
      }
      if (j >= n) {
        throw new XmlError('Unterminated DOCTYPE', lt);
      }
      i = j + 1;
      continue;
    }
    const gt = findTagEnd(xml, lt);
    if (gt === -1) {
      throw new XmlError('Unterminated tag', lt);
    }
    const raw = xml.slice(lt + 1, gt);
    if (raw[0] === '/') {
      const name = raw.slice(1).trim();
      const top = stack.pop();
      if (!top || top.name !== name) {
        throw new XmlError(`Mismatched closing tag </${name}> (open: <${top ? top.name : 'none'}>)`, lt);
      }
    } else {
      const selfClosing = raw.endsWith('/');
      const body = selfClosing ? raw.slice(0, -1) : raw;
      const sp = body.search(/[\s]/);
      const name = sp === -1 ? body : body.slice(0, sp);
      const attrs = sp === -1 ? {} : parseAttrs(body.slice(sp));
      const el = { name, attrs, children: [] };
      stack[stack.length - 1].children.push(el);
      if (!selfClosing) {
        stack.push(el);
      }
    }
    i = gt + 1;
  }
  if (stack.length !== 1) {
    throw new XmlError(`Unclosed element <${stack[stack.length - 1].name}>`, n);
  }
  return root;
}

/** Find the '>' that closes the tag starting at `lt`, honouring quoted attribute values. */
function findTagEnd(xml, lt) {
  let quote = null;
  for (let j = lt + 1; j < xml.length; j++) {
    const ch = xml[j];
    if (quote) {
      if (ch === quote) {
        quote = null;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return j;
    }
  }
  return -1;
}

// --- tree helpers -----------------------------------------------------------------------------

function isElement(node) {
  return typeof node === 'object' && node !== null && typeof node.name === 'string';
}

function children(node, name) {
  if (!node) {
    return [];
  }
  return node.children.filter((c) => isElement(c) && (name === undefined || c.name === name));
}

function child(node, name) {
  return children(node, name)[0] || null;
}

/** Depth-first search for all descendant elements with the given name (or all if omitted). */
function descendants(node, name) {
  const out = [];
  const walk = (el) => {
    for (const c of el.children) {
      if (isElement(c)) {
        if (name === undefined || c.name === name) {
          out.push(c);
        }
        walk(c);
      }
    }
  };
  if (node) {
    walk(node);
  }
  return out;
}

/** Concatenated text of a node and all its descendants. */
function text(node) {
  if (node === null || node === undefined) {
    return '';
  }
  if (typeof node === 'string') {
    return node;
  }
  let out = '';
  for (const c of node.children) {
    out += typeof c === 'string' ? c : text(c);
  }
  return out;
}

/** Text of the direct string children only. */
function ownText(node) {
  return node ? node.children.filter((c) => typeof c === 'string').join('') : '';
}

function rootElement(doc) {
  return children(doc)[0] || null;
}

function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
}

module.exports = { parse, XmlError, isElement, children, child, descendants, text, ownText, rootElement, decodeEntities, escapeXml };
