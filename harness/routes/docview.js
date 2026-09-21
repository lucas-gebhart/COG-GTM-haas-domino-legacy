'use strict';

/**
 * Generic ?OpenDocument rendering: the Domino web server renders a document through its
 * form. The harness does the same using the parsed DXL form (field order/types) and falls
 * back to a raw item dump for items the form does not define (a very Domino situation).
 */

const H = require('../lib/html');

const SYSTEM_ITEMS = new Set(['Form', 'DocReaders', 'DocAuthors', 'CaseReaders', 'CaseAuthors', 'Readers', 'Authors', 'LookupKey', 'LineKey', 'FileKey', 'StatusInquiryKey', 'LockedForModification']);

function humanize(name) {
  return name
    .replace(/^\$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/\bDODAAC\b|\bUIC\b|\bRPD\b|\bNSN\b|\bZIP\b|\bQC\b|\bMI\b|\bPOC\b|\bCSR\b|\bETA\b|\bSES\b/g, (m) => m)
    .replace(/_/g, ' ');
}

function findForm(design, name) {
  return design.forms.find((f) => f.name === name || (f.aliases || []).includes(name)) || null;
}

function valueCell(field, v) {
  if (Array.isArray(v)) {
    if (field && /History|Log|Items|Contents/.test(field.name)) {
      return `<div class="multiValue">${v.map((x) => H.esc(H.fmtValue(x))).join('<br>')}</div>`;
    }
    return H.esc(v.map(H.fmtValue).join('; '));
  }
  if (field && field.type === 'richtext') {
    return `<div class="richText">${H.esc(H.fmtValue(v)).replace(/\n/g, '<br>')}</div>`;
  }
  if (typeof v === 'number' && field && /Price|Value|Postage/.test(field.name)) {
    return H.esc(H.money(v));
  }
  return H.esc(H.fmtValue(v));
}

/** Two-column Domino layout table of the document's items in form order. */
function itemsTable(design, doc, opts = {}) {
  const form = findForm(design, doc.form);
  const rows = [];
  const seen = new Set();
  const fields = form ? form.fields : [];
  const pairs = [];
  for (const f of fields) {
    if (SYSTEM_ITEMS.has(f.name) || f.readers || f.authors) {
      continue;
    }
    seen.add(f.name);
    if (doc.items[f.name] === undefined && !opts.showEmpty) {
      continue;
    }
    pairs.push({ label: humanize(f.name), value: valueCell(f, doc.items[f.name]), raw: true });
  }
  const extras = Object.keys(doc.items).filter((k) => !seen.has(k) && !SYSTEM_ITEMS.has(k) && !k.startsWith('$'));
  for (let i = 0; i < pairs.length; i += 2) {
    rows.push({ cells: pairs.slice(i, i + 2) });
  }
  const out = [H.fieldTable(rows)];
  if (extras.length) {
    out.push('<div class="sectionHead">Items not defined on the form (legacy / agent-written)</div>');
    out.push(H.fieldTable(extras.map((k) => ({ label: k, value: valueCell(null, doc.items[k]), raw: true, colspan: 3 }))));
  }
  return out.join('\n');
}

function systemTable(doc, dbName) {
  const rows = [
    { cells: [{ label: 'UNID', value: doc.unid }, { label: 'Note ID', value: doc.noteid }] },
    { cells: [{ label: 'Form', value: doc.form }, { label: 'Parent UNID', value: doc.parent ? `<a href="/${H.attr(dbName)}/0/${H.attr(doc.parent)}?OpenDocument">${H.esc(doc.parent)}</a>` : '(none)', raw: true }] },
    { cells: [{ label: 'Created', value: H.fmtValue(doc.created) }, { label: 'Modified', value: `${H.fmtValue(doc.modified)} (seq ${doc.sequence})` }] },
    { cells: [{ label: '$UpdatedBy', value: doc.updatedBy.join('<br>'), raw: true }, { label: '$Revisions', value: doc.revisions.map(H.fmtValue).join('<br>'), raw: true }] },
    { cells: [{ label: 'Readers', value: doc.readers.length ? doc.readers.join('; ') : '(no readers field - visible to all with Reader access)' }, { label: 'Authors', value: doc.authors.join('; ') }] },
  ];
  if (doc.files && doc.files.length) {
    rows.push({ label: '$FILE', value: doc.files.map((f) => `<a href="/${H.attr(dbName)}/0/${H.attr(doc.unid)}/$File/${H.attr(encodeURIComponent(f.name || f))}">${H.esc(f.name || f)}</a>${f.size ? ` (${f.size} bytes)` : ''}`).join('<br>'), raw: true, colspan: 3 });
  }
  return `<div class="twistySection"><a href="#" class="twisty" data-target="sysItems" aria-expanded="false">&#9654;</a> <b>Document properties ($UpdatedBy, $Revisions, Readers, $FILE)</b></div><div id="sysItems" class="twistyBody" hidden>${H.fieldTable(rows)}</div>`;
}

function responsesTable(dbName, responses, columns) {
  if (!responses.length) {
    return '';
  }
  const out = [`<table class="dominoView" border="1" cellpadding="3" cellspacing="0" width="100%"><tr>${columns.map((c) => `<th>${H.esc(c.title)}</th>`).join('')}</tr>`];
  for (const r of responses) {
    out.push(`<tr>${columns.map((c, i) => `<td>${i === 0 ? `<a href="/${H.attr(dbName)}/0/${H.attr(r.unid)}?OpenDocument">` : ''}${c.render ? c.render(r) : H.esc(H.fmtValue(r.items[c.item]))}${i === 0 ? '</a>' : ''}</td>`).join('')}</tr>`);
  }
  out.push('</table>');
  return out.join('\n');
}

module.exports = { humanize, findForm, itemsTable, systemTable, responsesTable, valueCell, SYSTEM_ITEMS };
