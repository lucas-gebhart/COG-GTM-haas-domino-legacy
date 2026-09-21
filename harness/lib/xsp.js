'use strict';

/**
 * XPages (.xsp) reader.  Extracts the things the harness and the design inventory care
 * about: page title, data sources, control census, SSJS bindings, custom-control usage,
 * resources (script libraries / stylesheets) and the field bindings of input controls.
 */

const xml = require('./xml');

const INPUT_CONTROLS = new Set(['xp:inputText', 'xp:inputTextarea', 'xp:comboBox', 'xp:radioGroup', 'xp:checkBox', 'xp:checkBoxGroup', 'xp:listBox', 'xp:fileUpload', 'xp:inputRichText', 'xp:dateTimeHelper']);

const SSJS_RE = /#\{javascript:([\s\S]*?)\}(?=\s*$|["'\]])/g;

function extractSsjs(source) {
  const out = [];
  let m;
  const re = /#\{javascript:/g;
  while ((m = re.exec(source)) !== null) {
    // balanced-brace scan so nested object literals do not truncate the expression
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < source.length && depth > 0) {
      if (source[i] === '{') {
        depth++;
      } else if (source[i] === '}') {
        depth--;
      }
      i++;
    }
    out.push(source.slice(m.index + m[0].length, i - 1).trim());
  }
  return out;
}

function bindingField(binding) {
  const m = /^#\{(\w+)\.(\w+)\}$/.exec(String(binding || '').trim());
  return m ? { source: m[1], field: m[2] } : null;
}

function parseXsp(content, fileName) {
  const doc = xml.parse(content);
  const root = xml.rootElement(doc);
  if (!root || root.name !== 'xp:view') {
    throw new Error(`${fileName || 'xsp'}: root element must be <xp:view>`);
  }
  const all = xml.descendants(root);
  const controlCounts = {};
  for (const el of all) {
    if (el.name.startsWith('xp:this') || el.name.startsWith('xc:this')) {
      continue;
    }
    controlCounts[el.name] = (controlCounts[el.name] || 0) + 1;
  }
  const dataSources = [];
  for (const el of all) {
    if (el.name === 'xp:dominoDocument') {
      dataSources.push({ type: 'dominoDocument', var: el.attrs.var || '', formName: el.attrs.formName || '', action: el.attrs.action || '', computeWithForm: el.attrs.computeWithForm || '' });
    } else if (el.name === 'xp:dominoView') {
      dataSources.push({ type: 'dominoView', var: el.attrs.var || '', viewName: el.attrs.viewName || '', categoryFilter: el.attrs.categoryFilter || '' });
    }
  }
  const inputs = all
    .filter((el) => INPUT_CONTROLS.has(el.name))
    .map((el) => ({ control: el.name, id: el.attrs.id || '', value: el.attrs.value || '', maxlength: el.attrs.maxlength ? Number(el.attrs.maxlength) : null, field: bindingField(el.attrs.value) }));
  const buttons = all.filter((el) => el.name === 'xp:button').map((el) => ({ id: el.attrs.id || '', value: el.attrs.value || '' }));
  const customControls = [...new Set(all.filter((el) => el.name.startsWith('xc:') && !el.name.startsWith('xc:this') && el.name !== 'xc:property' && el.name !== 'xc:designerExtension').map((el) => el.name.slice(3)))];
  const resources = all.filter((el) => el.name === 'xp:script' || el.name === 'xp:styleSheet').map((el) => ({ type: el.name.slice(3), href: el.attrs.src || el.attrs.href || '', clientSide: el.attrs.clientSide === 'true' }));
  const ssjs = extractSsjs(content);
  const isCustomControl = /customcontrols\//.test(fileName || '') || all.some((el) => el.name === 'xc:designerExtension' || el.name === 'xc:property');
  return {
    kind: isCustomControl ? 'customcontrol' : 'xpage',
    file: fileName || '',
    name: (fileName || '').split('/').pop().replace(/\.xsp$/i, ''),
    pageTitle: root.attrs.pageTitle || '',
    rendered: root.attrs.rendered || '',
    dataSources,
    controlCounts,
    controls: Object.values(controlCounts).reduce((a, b) => a + b, 0),
    inputs,
    buttons,
    customControls,
    resources,
    ssjsBlocks: ssjs.length,
    ssjsLines: ssjs.reduce((n, s) => n + s.split('\n').filter((l) => l.trim()).length, 0),
    ssjs,
    lines: content.split(/\r?\n/).length,
    viewPanels: all.filter((el) => el.name === 'xp:viewPanel').map((el) => ({ id: el.attrs.id || '', value: el.attrs.value || '', columns: xml.children(el, 'xp:viewColumn').length })),
  };
}

module.exports = { parseXsp, extractSsjs, bindingField, SSJS_RE, INPUT_CONTROLS };
