'use strict';

/**
 * HTML helpers and the page chrome for the emulated Domino web UI.
 *
 * Everything that reaches the browser passes through esc() (or attr()). The only
 * Cognition-branded element is the thin harness banner at the top of every page; the
 * emulated application below it is deliberately unbranded, in the style of a Domino 8.5/9
 * web application with XPages (Dojo-era) widgets.
 */

const HARNESS_BANNER_TEXT = 'Rendering harness \u2014 synthetic Domino/XPages application, not an HCL Domino server';

function esc(v) {
  if (v === null || v === undefined) {
    return '';
  }
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const attr = esc;

function fmtValue(v) {
  if (Array.isArray(v)) {
    return v.map(fmtValue).join(', ');
  }
  if (v === null || v === undefined) {
    return '';
  }
  if (typeof v === 'number') {
    return Number.isInteger(v) ? String(v) : v.toFixed(2);
  }
  if (v instanceof Date) {
    return fmtDate(v);
  }
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/.test(s)) {
    return fmtDate(s);
  }
  return s;
}

/** Domino web default: mm/dd/yyyy hh:mm AM/PM. */
function fmtDate(v) {
  if (!v) {
    return '';
  }
  const s = String(v);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
  if (m) {
    const date = `${m[2]}/${m[3]}/${m[1]}`;
    if (m[4] !== undefined) {
      let h = Number(m[4]);
      const ampm = h >= 12 ? 'PM' : 'AM';
      h = h % 12 || 12;
      return `${date} ${String(h).padStart(2, '0')}:${m[5]} ${ampm}`;
    }
    return date;
  }
  if (v instanceof Date) {
    return fmtDate(v.toISOString());
  }
  return s;
}

function money(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) {
    return '';
  }
  return `$${x.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

function option(value, label, selected) {
  return `<option value="${attr(value)}"${selected ? ' selected' : ''}>${esc(label === undefined ? value : label)}</option>`;
}

function select(name, values, current, opts = {}) {
  const out = [`<select name="${attr(name)}" id="${attr(opts.id || name)}" class="xspComboBox"${opts.size ? ` size="${opts.size}"` : ''}>`];
  if (opts.blank) {
    out.push(option('', opts.blank === true ? '' : opts.blank, !current));
  }
  for (const v of values) {
    const [value, label] = Array.isArray(v) ? v : [v, v];
    out.push(option(value, label, String(current) === String(value)));
  }
  out.push('</select>');
  return out.join('');
}

function input(name, value, opts = {}) {
  return `<input type="${opts.type || 'text'}" name="${attr(name)}" id="${attr(opts.id || name)}" value="${attr(value)}" size="${opts.size || 30}" maxlength="${opts.maxlength || 255}" class="xspInputFieldEditBox"${opts.readonly ? ' readonly' : ''}${opts.extra || ''}>`;
}

function button(label, opts = {}) {
  const type = opts.type || 'submit';
  const name = opts.name ? ` name="${attr(opts.name)}"` : '';
  const value = opts.value !== undefined ? ` value="${attr(opts.value)}"` : '';
  const cls = opts.className || 'xspButtonCommand';
  return `<button type="${type}"${name}${value} class="${cls}">${esc(label)}</button>`;
}

function link(href, label, cls) {
  return `<a href="${attr(href)}"${cls ? ` class="${attr(cls)}"` : ''}>${esc(label)}</a>`;
}

function linkButton(href, label) {
  return `<a href="${attr(href)}" class="xspButtonCommand lnkButton">${esc(label)}</a>`;
}

/** Domino-style field error block (what a failed @Failure looks like on the web). */
function errorBlock(messages, title) {
  if (!messages || messages.length === 0) {
    return '';
  }
  return `<div class="xspMessage"><table class="dominoError" border="0" cellpadding="4"><tr><td class="errIcon">&#9888;</td><td>
<b>${esc(title || 'Form processing error')}</b><ul>${messages.map((m) => `<li>${esc(m)}</li>`).join('')}</ul></td></tr></table></div>`;
}

function infoBlock(message, opts = {}) {
  if (!message) {
    return '';
  }
  return `<div class="xspMessage xspMessageInfo"><table class="dominoInfo" border="0" cellpadding="4"><tr><td class="infoIcon">&#8505;</td><td>${opts.raw ? message : esc(message)}</td></tr></table></div>`;
}

function fieldTable(rows) {
  const out = ['<table class="formTable" border="0" cellpadding="2" cellspacing="0">'];
  for (const r of rows) {
    if (r.section) {
      out.push(`<tr><td colspan="4" class="sectionHead">${esc(r.section)}</td></tr>`);
      continue;
    }
    const cells = r.cells || [r];
    out.push('<tr>');
    for (const c of cells) {
      out.push(`<td class="fieldLabel"${c.labelColspan ? ` colspan="${c.labelColspan}"` : ''}>${esc(c.label)}${c.required ? '<span class="req">*</span>' : ''}</td>`);
      out.push(`<td class="fieldValue"${c.colspan ? ` colspan="${c.colspan}"` : ''}>${c.raw ? c.value : esc(c.value)}${c.help ? `<div class="fieldHelp">${esc(c.help)}</div>` : ''}</td>`);
    }
    if (cells.length === 1 && !r.colspan) {
      out.push('<td class="fieldLabel"></td><td class="fieldValue"></td>');
    }
    out.push('</tr>');
  }
  out.push('</table>');
  return out.join('\n');
}

/**
 * Full page shell: harness banner, Notes-blue header bar, left navigation, content, footer.
 * db: 'heraldry.nsf' | 'vetmedals.nsf' | null (for /design, /names.nsf)
 */
function page(opts) {
  const {
    title,
    db,
    content,
    user,
    nav,
    breadcrumb,
    appTitle,
    actions,
  } = opts;
  const app = appTitle || (db === 'vetmedals.nsf' ? 'Veteran Medals & Awards' : db === 'heraldry.nsf' ? 'Heraldry Automation System' : 'HAAS');
  const navHtml = (nav || []).map((n) => (n.heading
    ? `<div class="navHead">${esc(n.heading)}</div>`
    : `<a class="navLink${n.current ? ' navCurrent' : ''}" href="${attr(n.href)}">${esc(n.label)}</a>`)).join('\n');
  const actionBar = actions && actions.length
    ? `<div class="actionBar">${actions.map((a) => (a.form
      ? `<form method="post" action="${attr(a.href)}" class="inlineForm">${a.hidden ? Object.entries(a.hidden).map(([k, v]) => `<input type="hidden" name="${attr(k)}" value="${attr(v)}">`).join('') : ''}<button type="submit" class="actionButton">${esc(a.label)}</button></form>`
      : `<a class="actionButton" href="${attr(a.href)}">${esc(a.label)}</a>`)).join('')}</div>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)} - ${esc(app)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" type="text/css" href="/domino.css">
<link rel="stylesheet" type="text/css" href="/xsp.css">
<link rel="icon" href="/favicon.ico">
</head>
<body class="xspView tundra">
<div id="harnessBanner" role="note"><span class="hbText">${esc(HARNESS_BANNER_TEXT)}</span><span class="hbBrand"><img src="/brand/cognition-lockup-black.svg" alt="Cognition" height="12"></span></div>
<div id="dominoHeader">
  <table width="100%" border="0" cellspacing="0" cellpadding="0"><tr>
    <td class="hdrTitle"><span class="hdrApp">${esc(app)}</span><br><span class="hdrSub">U.S. Army TACOM ILSC Clothing &amp; Heraldry PSID &middot; Philadelphia, PA</span></td>
    <td class="hdrUser" align="right">${user ? `${esc(user.name)}${user.roles && user.roles.length ? ` <span class="hdrRoles">${esc(user.roles.join(' '))}</span>` : ''} &nbsp;|&nbsp; <a href="/names.nsf?Logout">Log Out</a>` : '<a href="/names.nsf?Login">Log In</a>'}<br><span class="hdrServer">HAAS-APP01/TACOM &middot; ${esc(db || 'names.nsf')}</span></td>
  </tr></table>
</div>
<div id="dominoMenu"><a href="/heraldry.nsf/HeraldryHome.xsp">Heraldry</a> | <a href="/vetmedals.nsf/CasesByStage?OpenView">Veteran Medals</a> | <a href="/design">Design</a> | <a href="/agents">Agents</a> | <a href="/names.nsf?Login">Login</a></div>
<table id="dominoBody" width="100%" border="0" cellspacing="0" cellpadding="0"><tr>
<td id="dominoNav" valign="top">${navHtml}</td>
<td id="dominoContent" valign="top"><div id="dominoContentInner">
${breadcrumb ? `<div class="breadcrumb">${breadcrumb.map((b, i) => (i < breadcrumb.length - 1 && b.href ? `<a href="${attr(b.href)}">${esc(b.label)}</a>` : `<span>${esc(b.label)}</span>`)).join(' &raquo; ')}</div>` : ''}
${actionBar}
<h1 class="pageTitle">${esc(title)}</h1>
${content}
</div></td></tr></table>
<div id="dominoFooter">Heraldry &amp; Awards Automation System &middot; Domino 9.0.1 FP10 / XPages &middot; For Official Use Only (synthetic data) &middot; <a href="/design">Design inventory</a></div>
<script src="/twisty.js"></script>
</body>
</html>`;
}

module.exports = {
  esc,
  attr,
  fmtValue,
  fmtDate,
  money,
  select,
  input,
  button,
  link,
  linkButton,
  errorBlock,
  infoBlock,
  fieldTable,
  page,
  HARNESS_BANNER_TEXT,
};
