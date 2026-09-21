'use strict';

/**
 * Renders DXL <view> designs against the document store, the way the Domino HTTP task
 * renders ?OpenView: the selection formula picks the documents, column formulas produce
 * the cells, sorted/categorized columns group the rows, response documents hang under
 * their parents, and Start/Count paginate.
 *
 * Also provides the @Formula runtime context (@DbLookup, @DbColumn, @GetProfileField)
 * backed by the store, so form and view formulas from the DXL run unmodified.
 */

const F = require('./formula');
const H = require('./html');

const DEFAULT_COUNT = 40;
const MAX_COUNT = 500;

function findView(design, name) {
  const want = String(name || '').toLowerCase();
  return design.views.find((v) => v.name.toLowerCase() === want
    || (v.aliases || []).some((a) => a.toLowerCase() === want)) || null;
}

function findForm(design, name) {
  const want = String(name || '').toLowerCase();
  return design.forms.find((f) => f.name.toLowerCase() === want
    || (f.aliases || []).some((a) => a.toLowerCase() === want)) || null;
}

class ViewEngine {
  constructor(design, db, opts = {}) {
    this.design = design;
    this.db = db;
    this.now = opts.now || null;
    this.compiled = new Map();
    this.rowCache = new Map();
  }

  compile(src) {
    let p = this.compiled.get(src);
    if (!p) {
      p = F.compile(src);
      this.compiled.set(src, p);
    }
    return p;
  }

  /** @Formula evaluation context for a document in this database. */
  context(doc, extra = {}) {
    return {
      doc,
      now: this.now ? this.now() : undefined,
      dbPath: this.db.meta.path || this.db.name,
      dbTitle: this.db.meta.title || this.db.name,
      replicaId: this.db.meta.replicaId || '',
      serverName: 'CN=HAAS-APP01/O=TACOM',
      docChildren: doc && doc.unid ? this.db.responses(doc.unid).length : 0,
      profileField: (profileName, fieldName) => {
        const p = this.db.profile();
        if (!p) {
          return '';
        }
        const v = p.items[fieldName];
        return v === undefined ? '' : v;
      },
      dbLookup: (dbSpec, viewName, key, col) => this.dbLookup(viewName, key, col),
      dbColumn: (dbSpec, viewName, col) => this.dbColumn(viewName, col),
      ...extra,
    };
  }

  eval(src, doc, extra) {
    if (!src) {
      return '';
    }
    const ev = new F.Evaluator(this.context(doc, extra));
    try {
      return ev.run(this.compile(src));
    } catch (e) {
      if (e instanceof F.FormulaError) {
        return new F.FormulaErrorValue(e.message);
      }
      throw e;
    }
  }

  /** Documents selected by the view's SELECT formula. */
  selected(view) {
    const prog = this.compile(view.selection || 'SELECT @All');
    const hasSelect = prog.statements.some((s) => s.type === 'select');
    const out = [];
    for (const doc of this.db.all()) {
      const ev = new F.Evaluator(this.context(doc));
      let r;
      try {
        r = ev.run(prog);
      } catch {
        continue;
      }
      const ok = hasSelect ? ev.selectResult : F.truthy(r);
      if (ok) {
        out.push(doc);
      }
    }
    return out;
  }

  cellValue(col, doc) {
    if (col.formula) {
      const v = this.eval(col.formula, doc);
      return v instanceof F.FormulaErrorValue ? '' : v;
    }
    const v = doc.items[col.itemName];
    return v === undefined ? '' : v;
  }

  /** Row objects: { doc, cells[], category, isResponse } for every selected document. */
  rows(view) {
    const key = `${view.name}@${this.db.version}`;
    const cached = this.rowCache.get(key);
    if (cached) {
      return cached;
    }
    for (const k of [...this.rowCache.keys()]) {
      if (!k.endsWith(`@${this.db.version}`)) {
        this.rowCache.delete(k);
      }
    }
    const cols = view.columns.filter((c) => !c.hidden || c.sort);
    const docs = this.selected(view);
    const selectedUnids = new Set(docs.map((d) => d.unid));
    const rows = docs.map((doc) => ({
      doc,
      cells: cols.map((c) => this.cellValue(c, doc)),
      isResponse: Boolean(view.showResponseHierarchy && doc.parent && selectedUnids.has(doc.parent)),
    }));
    const sortCols = cols.map((c, i) => ({ c, i })).filter((x) => x.c.sort);
    const cmp = (a, b) => {
      for (const { c, i } of sortCols) {
        const av = sortKey(a.cells[i]);
        const bv = sortKey(b.cells[i]);
        if (av < bv) {
          return c.sort === 'descending' ? 1 : -1;
        }
        if (av > bv) {
          return c.sort === 'descending' ? -1 : 1;
        }
      }
      return a.doc.created < b.doc.created ? -1 : a.doc.created > b.doc.created ? 1 : 0;
    };
    const result = { cols, rows, sortCols };
    if (view.showResponseHierarchy) {
      const byParent = new Map();
      const top = [];
      for (const r of rows) {
        if (r.isResponse) {
          if (!byParent.has(r.doc.parent)) {
            byParent.set(r.doc.parent, []);
          }
          byParent.get(r.doc.parent).push(r);
        } else {
          top.push(r);
        }
      }
      top.sort(cmp);
      for (const list of byParent.values()) {
        list.sort(cmp);
      }
      result.top = top;
      result.responses = byParent;
    } else {
      rows.sort(cmp);
      result.top = rows;
      result.responses = new Map();
    }
    this.rowCache.set(key, result);
    return result;
  }

  /** @DbLookup(class; server:db; view; key; column) against the first sorted column. */
  dbLookup(viewName, key, col) {
    const view = findView(this.design, viewName);
    if (!view) {
      return new F.FormulaErrorValue(`View '${viewName}' not found`);
    }
    const { cols, top } = this.rows(view);
    const keyIdx = cols.findIndex((c) => c.sort);
    const idx = keyIdx < 0 ? 0 : keyIdx;
    const keys = F.toList(key).map((k) => F.asText(k).toUpperCase());
    const out = [];
    for (const r of top) {
      const cellKeys = F.toList(r.cells[idx]).map((k) => F.asText(k).toUpperCase());
      if (cellKeys.some((k) => keys.includes(k))) {
        out.push(...F.toList(columnValue(r, cols, col)));
      }
    }
    if (out.length === 0) {
      return new F.FormulaErrorValue('Entry not found in index');
    }
    return out.length === 1 ? out[0] : out;
  }

  dbColumn(viewName, col) {
    const view = findView(this.design, viewName);
    if (!view) {
      return new F.FormulaErrorValue(`View '${viewName}' not found`);
    }
    const { cols, top } = this.rows(view);
    const out = [];
    for (const r of top) {
      out.push(...F.toList(columnValue(r, cols, col)));
    }
    return [...new Set(out.map((v) => (typeof v === 'string' ? v : F.asText(v))))];
  }

  /** Render a view as a Domino-style HTML table. */
  render(view, opts = {}) {
    const { cols, top, responses } = this.rows(view);
    const visible = cols.map((c, i) => ({ c, i })).filter((x) => !x.c.hidden);
    const start = Math.max(1, Number(opts.start) || 1);
    const count = Math.min(MAX_COUNT, Math.max(1, Number(opts.count) || DEFAULT_COUNT));
    const catIdx = visible.findIndex((x) => x.c.categorized);
    let filter = opts.filter || null;
    if (opts.restrictToCategory && catIdx >= 0) {
      const want = String(opts.restrictToCategory);
      const idx = visible[catIdx].i;
      const inner = filter;
      filter = (r) => (H.fmtValue(r.cells[idx]) || '(Not Categorized)') === want && (!inner || inner(r));
    }
    const filteredTop = filter ? top.filter(filter) : top;
    const collapsed = Boolean(opts.collapsed) && catIdx >= 0;
    const catOf = (r) => H.fmtValue(r.cells[visible[catIdx].i]) || '(Not Categorized)';
    let total;
    let pageRows;
    let unit = 'document(s)';
    if (collapsed) {
      // Domino pages a collapsed view by its visible (category) rows, not by the documents beneath them
      const groups = new Map();
      for (const r of filteredTop) {
        const cat = catOf(r);
        if (!groups.has(cat)) {
          groups.set(cat, []);
        }
        groups.get(cat).push(r);
      }
      total = groups.size;
      pageRows = [...groups.values()].slice(start - 1, start - 1 + count).flat();
      unit = `categor${total === 1 ? 'y' : 'ies'} (${filteredTop.length} documents)`;
    } else {
      total = filteredTop.length;
      pageRows = filteredTop.slice(start - 1, start - 1 + count);
    }
    const baseHref = opts.baseHref || `/${this.db.name}/${encodeURIComponent(view.name)}?OpenView${opts.restrictToCategory ? `&RestrictToCategory=${encodeURIComponent(opts.restrictToCategory)}` : ''}${collapsed ? '&CollapseView' : ''}`;
    const docHref = opts.docHref || ((doc) => `/${this.db.name}/0/${doc.unid}?OpenDocument`);

    const out = [];
    out.push(`<div class="viewToolbar">${opts.toolbar || ''}<span class="viewNav">${navLinks(baseHref, start, count, total)}</span></div>`);
    out.push('<table class="dominoView" border="1" cellpadding="2" cellspacing="0" width="100%">');
    out.push('<thead><tr>');
    for (const { c } of visible) {
      out.push(`<th${c.width ? ` width="${Math.round(c.width * 8)}"` : ''} class="${c.sort ? 'sortable' : ''}">${H.esc(c.title || '')}${c.sort ? `<span class="sortIcon">${c.sort === 'descending' ? '&#9660;' : '&#9650;'}</span>` : ''}</th>`);
    }
    out.push('</tr></thead><tbody>');

    let lastCat = null;
    let catId = 0;
    for (const r of pageRows) {
      if (catIdx >= 0) {
        const cat = H.fmtValue(r.cells[visible[catIdx].i]) || '(Not Categorized)';
        if (cat !== lastCat) {
          catId += 1;
          lastCat = cat;
          const n = filteredTop.filter((x) => (H.fmtValue(x.cells[visible[catIdx].i]) || '(Not Categorized)') === cat).length;
          const catHref = `/${this.db.name}/${encodeURIComponent(view.name)}?OpenView&RestrictToCategory=${encodeURIComponent(cat)}`;
          out.push(`<tr class="catRow" data-cat="c${catId}"><td colspan="${visible.length}"><a href="#" class="twisty" data-target="c${catId}" aria-expanded="${collapsed ? 'false' : 'true'}">${collapsed ? '&#9654;' : '&#9660;'}</a> <a class="catLink" href="${H.attr(catHref)}"><b>${H.esc(cat)}</b></a> <span class="catCount">(${n})</span></td></tr>`);
        }
      }
      out.push(renderRow(r, visible, catIdx, catId, docHref, false, responses.has(r.doc.unid), collapsed));
      const kids = responses.get(r.doc.unid) || [];
      for (const k of kids) {
        out.push(renderRow(k, visible, catIdx, catId, docHref, true, false, collapsed));
      }
    }
    if (pageRows.length === 0) {
      out.push(`<tr><td colspan="${visible.length}" class="emptyView">No documents found</td></tr>`);
    }
    out.push('</tbody></table>');
    out.push(`<div class="viewFooter">${total} ${unit} &middot; showing ${total ? start : 0}-${Math.min(total, start + count - 1)} &middot; <span class="viewNav">${navLinks(baseHref, start, count, total)}</span></div>`);
    return out.join('\n');
  }
}

function renderRow(r, visible, catIdx, catId, docHref, isResponse, hasKids, collapsed) {
  const tds = [];
  const responseCols = visible.filter((x) => x.c.responsesOnly);
  if (isResponse && responseCols.length) {
    const first = visible[0];
    tds.push(`<td class="respIndent">${first.c.categorized ? '' : ''}</td>`);
    const rc = responseCols[0];
    tds.push(`<td colspan="${visible.length - 1}" class="respCell"><a href="${H.attr(docHref(r.doc))}">${H.esc(H.fmtValue(r.cells[rc.i]))}</a></td>`);
  } else {
    let linked = false;
    visible.forEach(({ c, i }, pos) => {
      if (c.responsesOnly) {
        tds.push('<td></td>');
        return;
      }
      if (pos === catIdx && c.categorized) {
        tds.push('<td class="catCell"></td>');
        return;
      }
      let text = H.fmtValue(r.cells[i]);
      if (c.totals === 'total' || /Price|Value|Postage/.test(c.itemName || '')) {
        text = typeof r.cells[i] === 'number' ? H.money(r.cells[i]) : text;
      }
      if (!linked && text !== '') {
        tds.push(`<td class="${H.attr(c.align || 'left')}">${hasKids ? '<span class="respTwisty">&#9662;</span> ' : ''}<a href="${H.attr(docHref(r.doc))}">${H.esc(text)}</a></td>`);
        linked = true;
      } else {
        tds.push(`<td class="${H.attr(c.align || 'left')}">${H.esc(text)}</td>`);
      }
    });
  }
  return `<tr class="${isResponse ? 'respRow' : 'docRow'}${catIdx >= 0 ? ` cat-c${catId}` : ''}"${collapsed ? ' hidden' : ''}>${tds.join('')}</tr>`;
}

function navLinks(baseHref, start, count, total) {
  const sep = baseHref.includes('?') ? '&' : '?';
  const parts = [];
  const prev = Math.max(1, start - count);
  if (start > 1) {
    parts.push(`<a href="${H.attr(`${baseHref}${sep}Start=1&Count=${count}`)}">&laquo; First</a>`);
    parts.push(`<a href="${H.attr(`${baseHref}${sep}Start=${prev}&Count=${count}`)}">&lsaquo; Previous</a>`);
  }
  if (start + count <= total) {
    parts.push(`<a href="${H.attr(`${baseHref}${sep}Start=${start + count}&Count=${count}`)}">Next &rsaquo;</a>`);
  }
  parts.push(`<a href="${H.attr(`${baseHref}${sep}Start=${start}&Count=${Math.min(MAX_COUNT, count * 2)}`)}">Expand</a>`);
  return parts.join(' | ');
}

function columnValue(row, cols, col) {
  if (typeof col === 'number') {
    const idx = Math.round(col) - 1;
    return row.cells[idx] === undefined ? '' : row.cells[idx];
  }
  const name = F.asText(col);
  const i = cols.findIndex((c) => c.itemName === name);
  if (i >= 0) {
    return row.cells[i];
  }
  const v = row.doc.items[name];
  return v === undefined ? '' : v;
}

function sortKey(v) {
  if (Array.isArray(v)) {
    return sortKey(v[0]);
  }
  if (typeof v === 'number') {
    return v;
  }
  if (v instanceof Date) {
    return v.getTime();
  }
  return String(v === undefined || v === null ? '' : v).toUpperCase();
}

module.exports = { ViewEngine, findView, findForm, DEFAULT_COUNT, MAX_COUNT };
