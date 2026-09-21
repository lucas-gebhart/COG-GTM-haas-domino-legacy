'use strict';

/**
 * Persistent document store for the render harness.
 *
 * On first start the store is seeded from the DXL document exports under export/dxl/
 * (the same artifacts the migration team receives) and persisted as JSON under
 * harness/data/<db>.json.  Subsequent starts load the JSON, so changes made through the
 * harness survive restarts; `npm run reset` deletes the JSON and re-seeds from the export.
 *
 * Documents keep the shape produced by dxl.documentFromElement():
 *   { unid, noteid, sequence, form, parent, created, modified, items, readers, authors,
 *     files, updatedBy, revisions }
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const dxl = require('./dxl');

const DATABASES = {
  'heraldry.nsf': 'heraldry-documents.dxl',
  'vetmedals.nsf': 'vetmedals-documents.dxl',
};

function nowIso(clock) {
  return (clock ? clock() : new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function newUnid() {
  return crypto.randomBytes(16).toString('hex').toUpperCase();
}

class Database {
  constructor(name, meta, documents) {
    this.name = name;
    this.meta = meta || {};
    this.documents = [];
    this.byUnid = new Map();
    this.byForm = new Map();
    this.children = new Map();
    this.nextNoteId = 0x1000;
    this.version = 0;
    this.onChange = null;
    for (const d of documents || []) {
      this.index(d);
    }
  }

  index(doc) {
    this.documents.push(doc);
    this.byUnid.set(doc.unid, doc);
    if (!this.byForm.has(doc.form)) {
      this.byForm.set(doc.form, []);
    }
    this.byForm.get(doc.form).push(doc);
    if (doc.parent) {
      if (!this.children.has(doc.parent)) {
        this.children.set(doc.parent, []);
      }
      this.children.get(doc.parent).push(doc);
    }
    const nid = parseInt(doc.noteid, 16);
    if (Number.isFinite(nid) && nid >= this.nextNoteId) {
      this.nextNoteId = nid + 4;
    }
  }

  get(unid) {
    return this.byUnid.get(String(unid || '').toUpperCase()) || null;
  }

  all(form) {
    return form ? this.byForm.get(form) || [] : this.documents;
  }

  responses(unid, form) {
    const list = this.children.get(unid) || [];
    return form ? list.filter((d) => d.form === form) : list;
  }

  profile() {
    return this.all('Profile')[0] || null;
  }

  profileValue(name, fallback) {
    const p = this.profile();
    if (!p || p.items[name] === undefined || p.items[name] === '') {
      return fallback;
    }
    return p.items[name];
  }

  /** Profile counter, incremented non-transactionally exactly like HAASCommon.NextSerial. */
  nextSerial(counter, opts = {}) {
    const p = this.profile();
    const n = Number(p.items[counter] || 1);
    this.update(p, { [counter]: n + 1 }, { user: opts.user || 'Anonymous', clock: opts.clock });
    return n;
  }

  /** First document of `form` whose item equals value (case-insensitive for strings). */
  findOne(form, itemName, value) {
    const want = String(value).toUpperCase();
    return this.all(form).find((d) => {
      const v = d.items[itemName];
      if (Array.isArray(v)) {
        return v.some((x) => String(x).toUpperCase() === want);
      }
      return v !== undefined && String(v).toUpperCase() === want;
    }) || null;
  }

  findAll(form, itemName, value) {
    const want = String(value).toUpperCase();
    return this.all(form).filter((d) => {
      const v = d.items[itemName];
      if (Array.isArray(v)) {
        return v.some((x) => String(x).toUpperCase() === want);
      }
      return v !== undefined && String(v).toUpperCase() === want;
    });
  }

  /** Create a new document (NotesDatabase.CreateDocument + Save). */
  create(form, items, opts = {}) {
    const ts = nowIso(opts.clock);
    const doc = {
      unid: newUnid(),
      noteid: this.nextNoteId.toString(16).toUpperCase().padStart(8, '0'),
      sequence: 1,
      form,
      parent: opts.parent || '',
      created: ts,
      modified: ts,
      items: { Form: form, ...items },
      readers: [],
      authors: [],
      files: [],
      updatedBy: [opts.user || 'Anonymous'],
      revisions: [ts],
    };
    this.nextNoteId += 4;
    this.applyProtectionFields(doc);
    this.index(doc);
    this.touch();
    return doc;
  }

  /** Update items on an existing document (NotesDocument.ReplaceItemValue + Save). */
  update(doc, items, opts = {}) {
    const ts = nowIso(opts.clock);
    Object.assign(doc.items, items);
    for (const [k, v] of Object.entries(items)) {
      if (v === undefined || v === null) {
        delete doc.items[k];
      }
    }
    doc.modified = ts;
    doc.sequence = (doc.sequence || 1) + 1;
    doc.updatedBy = doc.updatedBy.concat(opts.user || 'Anonymous').slice(-20);
    doc.revisions = doc.revisions.concat(ts).slice(-20);
    this.applyProtectionFields(doc);
    this.touch();
    return doc;
  }

  applyProtectionFields(doc) {
    const readers = [];
    const authors = [];
    for (const name of ['DocReaders', 'Readers', 'CaseReaders']) {
      if (doc.items[name] !== undefined) {
        readers.push(...[].concat(doc.items[name]));
      }
    }
    for (const name of ['DocAuthors', 'Authors', 'CaseAuthors']) {
      if (doc.items[name] !== undefined) {
        authors.push(...[].concat(doc.items[name]));
      }
    }
    doc.readers = readers;
    doc.authors = authors;
  }

  remove(unid) {
    const doc = this.get(unid);
    if (!doc) {
      return false;
    }
    this.documents = this.documents.filter((d) => d !== doc);
    this.byUnid.delete(doc.unid);
    this.byForm.set(doc.form, (this.byForm.get(doc.form) || []).filter((d) => d !== doc));
    if (doc.parent && this.children.has(doc.parent)) {
      this.children.set(doc.parent, this.children.get(doc.parent).filter((d) => d !== doc));
    }
    this.touch();
    return true;
  }

  counts() {
    const out = {};
    for (const [form, docs] of [...this.byForm.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      out[form] = docs.length;
    }
    return out;
  }

  touch() {
    this.version += 1;
    if (this.onChange) {
      this.onChange(this);
    }
  }

  toJSON() {
    return { name: this.name, meta: this.meta, documents: this.documents };
  }
}

class Store {
  constructor({ dataDir, exportDir, log } = {}) {
    this.dataDir = dataDir || path.join(__dirname, '..', 'data');
    this.exportDir = exportDir || path.join(__dirname, '..', '..', 'export', 'dxl');
    this.log = log || (() => {});
    this.dbs = new Map();
    this.dirty = new Set();
    this.timer = null;
    this.saveDelayMs = 250;
    this.seededFromExport = [];
  }

  static open(opts) {
    const s = new Store(opts);
    s.load();
    return s;
  }

  dataFile(dbName) {
    return path.join(this.dataDir, `${dbName.replace(/\.nsf$/, '')}.json`);
  }

  load() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    for (const [dbName, exportFile] of Object.entries(DATABASES)) {
      const file = this.dataFile(dbName);
      let db;
      if (fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        db = new Database(dbName, raw.meta, raw.documents);
        this.dbs.set(dbName, db);
        this.log('store.load', { db: dbName, documents: raw.documents.length, source: file });
      } else {
        const exportPath = path.join(this.exportDir, exportFile);
        const parsed = dxl.parseDocumentExport(fs.readFileSync(exportPath, 'utf8'));
        db = new Database(dbName, { ...parsed.database, seededFrom: path.relative(process.cwd(), exportPath) }, parsed.documents);
        this.dbs.set(dbName, db);
        this.seededFromExport.push(dbName);
        this.writeNow(dbName);
        this.log('store.seed', { db: dbName, documents: parsed.documents.length, source: exportPath });
      }
      db.onChange = () => this.markDirty(dbName);
    }
  }

  db(name) {
    const db = this.dbs.get(name);
    if (!db) {
      throw new Error(`Unknown database ${name}`);
    }
    return db;
  }

  get heraldry() {
    return this.db('heraldry.nsf');
  }

  get vetmedals() {
    return this.db('vetmedals.nsf');
  }

  /** Mark a database changed; persisted after a short debounce (or on flush()). */
  markDirty(dbName) {
    this.dirty.add(dbName);
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, this.saveDelayMs);
      if (this.timer.unref) {
        this.timer.unref();
      }
    }
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const dbName of this.dirty) {
      this.writeNow(dbName);
    }
    this.dirty.clear();
  }

  writeNow(dbName) {
    const db = this.db(dbName);
    const file = this.dataFile(dbName);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db.toJSON()));
    fs.renameSync(tmp, file);
  }

  /** Delete persisted JSON so the next open() re-seeds from the export. */
  static reset(dataDir) {
    const dir = dataDir || path.join(__dirname, '..', 'data');
    const removed = [];
    for (const dbName of Object.keys(DATABASES)) {
      const file = path.join(dir, `${dbName.replace(/\.nsf$/, '')}.json`);
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
        removed.push(file);
      }
    }
    return removed;
  }
}

module.exports = { Store, Database, DATABASES, newUnid };
