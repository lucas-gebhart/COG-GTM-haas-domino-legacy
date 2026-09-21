# HAAS — Heraldry & Awards Automation System (synthetic legacy application)

**This repository is a synthetic stand-in.** It is the "legacy source" half of a legacy-to-ServiceNow
modernization reference application. Nothing in it comes from, or claims knowledge of, the real
internal design of any U.S. Army system. The mission facts (who does what, which forms and identifiers
are used, how long a case is meant to take) come from public sources; every design element, every line of
LotusScript, and every document in the export was written or generated for this repository. All personal
names, SSNs, addresses and unit points of contact are invented.

HAAS models the U.S. Army TACOM ILSC Clothing & Heraldry Product Support Integration Directorate (PSID)
"Medals, Awards & Heraldry" mission as an **HCL Domino / XPages** application family:

| Database | Mission | Public-source basis |
|---|---|---|
| `heraldry.nsf` — *Heraldry Automation System* | Unit supply / S4 personnel (identified by DODAAC and UIC) requisition flags, guidons, streamers, colors and insignia on **DD Form 1348-6**; requests may be modified or cancelled until released to a vendor; a status inquiry function exists; **SES flag** ordering is a distinct workflow; TACOM, DLA and vendor users get separate access. | Archived public Heraldry pages (`heraldryhome.nsf/HeraldryHome.xsp`, `StatusInquiry.xsp`, `ModifyRequest.xsp`, `heraldry.nsf/request?OpenForm`) |
| `vetmedals.nsf` — *Veteran Medals & Awards Case System* | NPRC (St. Louis) or Army HRC determines eligibility and sends an electronic **authorization file**; PSID fulfils: customer service, engraving, assembly/QC, warehouse pick, ship. Historic target: complete a case within ~60–75 days of entry. | Public TACOM / Veteran Medals program descriptions |

### Why Domino

The public front doors of both programs redirect to Army EAMS-A SAML and set Domino's `DOMRELAYSTATE` relay
cookie; archived pages link to `.nsf/…?OpenForm`, `?OpenDocument`, `?OpenView` and `.xsp` URLs and load
XPages Dojo resources under `/xsp/.ibmxspres/`; the same URL family is visible from ~2006 (classic Notes web
forms) through ~2013–2024 (XPages). That is enough to model the legacy as Domino/XPages rather than a .NET or
SAP estate — and no more than that: the actual internal design is unknown and is **not** represented here.

## Repository map

```
nsf/                         Domino design source, laid out like a Designer/DXL export
  heraldry.nsf/              database.properties.dxl, acl.dxl, forms/, subforms/, views/, agents/ (.lss + .dxl),
                             scriptlibs/ (.lss + .jss), xpages/, customcontrols/, formulas/, xsp.properties, faces-config.xml
  vetmedals.nsf/             same layout for the veteran awards case database
  README-design.md           developer handover: design walkthrough, known warts, operational notes
  notes.ini.sample           server settings the design assumes (HTTP, SAML, agent manager)
export/                      what a migration team receives
  dxl/                       heraldry-documents.dxl, vetmedals-documents.dxl (<document form=…><item name=…>)
  csv/                       one flattened CSV per form (heraldry-Request.csv, vetmedals-AwardsCase.csv, …)
  authorization-files/       4 HRC/NPRC-style inbound authorization transmissions ImportAuthorizationFile parses
  DATA-QUALITY-NOTES.md      every intentional defect, with counts, so the target side can prove it fixed them
tools/
  generate_fixtures.py       deterministic generator (seed 20040218, as-of 2026-09-01) for everything under export/
  inventory.js               design-inventory generator -> docs/DESIGN-INVENTORY.md (and --check for drift)
  screens.js                 docs/SCREENS.md generator from docs/screens/captions.tsv (and --check for drift)
harness/                     Node rendering harness: serves the app in a browser with the classic Domino web look
  server.js, reset.js        npm start / npm run reset
  lib/                       DXL + XSP parsers, @Formula interpreter, document store, view renderer, agents, audit log
  routes/                    Domino-style URL handlers (?OpenForm, ?OpenView, ?OpenDocument, *.xsp, /design, /agents)
  public/                    local CSS/JS only (domino.css, xsp.css, twisty.js, icons, harness-banner brand asset)
  test/                      node:test suites (parsers, formulas, importer, aging, store, every route)
docs/
  DESIGN-INVENTORY.md        generated: every form/field/validation, view/selection/column, agent, XPage, ACL role
  SCREENS.md + screens/      generated: screenshots of every harness page and workflow state, captions.tsv
```

## Running it

Requirements: Node >= 20 and Python 3 (generator only). No network access is needed at any point; the
harness loads no external resources.

```bash
npm ci                          # eslint only; the harness itself has no runtime dependencies
npm run lint && npm test        # ESLint + node:test (parsers, formulas, importer, aging, store, routes)
npm start                       # http://localhost:8088/  (HTTP; the Secure cookie flag is set as production Domino would)
npm run reset                   # drop harness/data/*.json and reseed the store from export/
python3 tools/generate_fixtures.py   # regenerate export/ byte-identically
npm run inventory               # regenerate docs/DESIGN-INVENTORY.md (node tools/inventory.js --check verifies)
npm run screens                 # regenerate docs/SCREENS.md from docs/screens/captions.tsv
```

Sign in at `/names.nsf?Login`. Production would authenticate through EAMS-A SAML; the harness offers a
table of synthetic identities (TACOM heraldry lead, CSR, engraver, assembler, warehouse, DLA liaison, unit
S4, vendor, automation account) and issues a `DomAuthSessId` cookie (HttpOnly, Secure, SameSite=Strict,
15-minute idle timeout). There are no passwords anywhere in the repository.

### Pages and Domino-style URLs

| Area | URL |
|---|---|
| Heraldry home (XPage) | `/heraldry.nsf/HeraldryHome.xsp` |
| DD Form 1348-6 request form | `/heraldry.nsf/Request?OpenForm` → `POST …/Request?CreateDocument` |
| Modify / cancel a request | `/heraldry.nsf/ModifyRequest.xsp?documentId=<unid>` |
| Status inquiry (by document number, DODAAC, UIC) | `/heraldry.nsf/StatusInquiry.xsp` |
| SES flag request and approval queue | `/heraldry.nsf/SESFlag.xsp` |
| Vendor work queue (release / acknowledge / ship) | `/heraldry.nsf/VendorQueue.xsp?vendor=<key>` |
| Any view | `/heraldry.nsf/RequestsByStatus?OpenView` (`&ExpandView`, `&CollapseView`, `&RestrictToCategory=`, `&Start=&Count=`) |
| Any document | `/heraldry.nsf/0/<unid>?OpenDocument` (also `/<view>/<unid>?OpenDocument`) |
| Attachments | `/heraldry.nsf/0/<unid>/$File/<name>` (stub: binary content is not in the export) |
| Awards cases by stage | `/vetmedals.nsf/CasesByStage?OpenView`, `AgingCases`, `WarehousePick`, `ShipConfirm`, … |
| CSR case detail (advance stage, hold, note, engraving, shipment) | `/vetmedals.nsf/CaseView.xsp?documentId=<unid>` |
| Engraving queue | `/vetmedals.nsf/EngravingQueue.xsp` |
| CSR lookup (case number, name, SSN last-4) | `/vetmedals.nsf/CSRLookup.xsp` |
| Login stub (EAMS-A SAML explanation) | `/names.nsf?Login`, `/names.nsf?Logout` |
| Design inventory ("discovery" screen) | `/design`, `/design/<db>/<type>/<name>` |
| Agents menu (`NightlyAging`, `ImportAuthorizationFile` with file upload) | `/agents` |
| Audit log viewer | `/audit` (reads `harness/logs/audit.jsonl`) |

### What the harness actually does

* Parses the DXL forms, views and agents and the `.xsp` XPages under `nsf/` at startup; the form field
  definitions, keyword lists, input-validation and input-translation `@Formulas`, view selection and column
  formulas, and `Readers`/`Authors` fields drive the rendered pages. The `@Formula` subset is interpreted
  server-side (`harness/lib/formula.js`) so the validations shown are the ones in the DXL.
* Seeds a persistent JSON store from `export/dxl/*.dxl` (19,384 documents) on first start; every create,
  modify, cancel, release, stage change and agent run is written to the store and to `harness/logs/audit.jsonl`
  as JSON.
* Enforces the legacy business rules: DD1348-6 validation (DODAAC, UIC, RPD 01–15, quantity limits per
  heraldic item), modify/cancel blocked after vendor release with the legacy error text (`Error 4091`),
  stage progression Authorized → Engraving → Assembly/QC → Warehouse → Shipped → Closed with role-gated
  transitions, SES flag approval, aging thresholds (60/75 days), and the HRC/NPRC authorization import with
  requester de-duplication and duplicate-transmission detection.
* Security hygiene even for a harness: allow-list input validation and length limits, HTML-escaping of all
  output, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'self'`,
  `Strict-Transport-Security`, `Referrer-Policy`, `Cache-Control: no-store`, generic public error pages with
  detailed internal logging, and no secrets.

The emulated application is deliberately unbranded and old-fashioned (Notes-blue header, `<table border=1>`
views with twisties, gray 2000s buttons, Verdana/Arial). The only harness-owned element is the thin top
banner: *"Rendering harness — synthetic Domino/XPages application, not an HCL Domino server."*

## Fixture volumes

Generated by `tools/generate_fixtures.py` (fixed seed; output is byte-identical between runs):

| heraldry.nsf | count | vetmedals.nsf | count |
|---|---:|---|---:|
| Request (DD1348-6) | 800 | AwardsCase | 3,000 |
| RequestLine | 2,000 | AwardLine | 7,000 |
| SESFlagRequest | 60 | Requester (veteran / next of kin) | 2,500 |
| Vendor | 12 | AuthorizationFile | 40 |
| HeraldicItem | 120 | EngravingJob | 400 |
| Requester (unit POC) | 350 | ShipmentRecord | 2,200 |
| Profile | 1 | CaseNote | 900 |
| | | Profile | 1 |
| **total** | **3,343** | **total** | **16,041** |

Dates span 2004–2026. Award names, Army unit designations, DODAAC/UIC formats, NSN-style stock numbers and
lead-time bands are realistic; people, SSNs and addresses are synthetic. The intentional defects (≈8%
duplicate requesters, orphaned lines and shipments, duplicate authorizations, unknown award codes, quantities
over limit, mixed date formats, a deleted-but-referenced vendor, `$FILE` references without bytes,
agent-polluted `$UpdatedBy`, …) are enumerated with counts in
[`export/DATA-QUALITY-NOTES.md`](export/DATA-QUALITY-NOTES.md).

## Domino → ServiceNow concept map

The reason a Domino estate converts systematically rather than by rewrite:

| Domino / XPages | ServiceNow (Fluent / SDK) |
|---|---|
| NSF database | Scoped application |
| Form (`Request`, `AwardsCase`, `AwardLine`) | Table + form layout |
| View / folder (selection formula, categorized columns) | List view / report / dashboard |
| Document with `$Fields` | Record with typed, referenced columns |
| `Readers` / `Authors` fields, ACL roles | ACLs + roles + groups |
| `@Formula` input validation / translation | UI policy / client script / data policy |
| LotusScript / SSJS agent | Business rule / Script Include |
| Scheduled agent (`NightlyAging`, `ArchiveClosedCases`) | Scheduled job / Flow Designer trigger |
| Mail-in workflow, status e-mails (`SendStatusMail`) | Flow Designer + Notification |
| Attachments (`$FILE`) | `sys_attachment` |
| XPages (`.xsp`) UI | Workspace (staff) + portal (requesters) |
| Domino SAML → EAMS-A | ServiceNow SAML SSO (same IdP) |
| DXL / CSV export | Import Sets + transform maps (reconciled) |

## What the migration team receives

1. **`nsf/`** — the design source of truth: two databases with ACLs, 15 forms, 21 views, 9 agents (LotusScript
   with DXL trigger wrappers), 8 script libraries (LotusScript + SSJS), 10 XPages and 4 custom controls, plus
   `formulas/` catalogues and `README-design.md` describing the design and its known warts the way a
   departing Domino developer would.
2. **`export/`** — the data: full DXL document exports (with `$UpdatedBy`, `$Revisions`, `Readers`, `Form`,
   `$FILE` items), one CSV per form, sample authorization transmissions, and `DATA-QUALITY-NOTES.md`.
3. **`docs/DESIGN-INVENTORY.md`** — the generated sizing inventory (fields, validations, selection formulas,
   columns, agent triggers and LoC, ACL roles) and **`/design`** in the harness, which renders the same
   inventory interactively.
4. **`harness/`** — a way to *see* the legacy behaviour (forms, validations, views, workflow, agents) without
   an HCL Domino server, and a reference for what the target must reproduce.

## Verification

`npm run lint && npm test` run 78 tests: DXL/XSP parsing of every design element, the `@Formula` port
(including the input-validation formulas taken from the DXL), the authorization-file importer against the
shipped samples, the aging job, store persistence, and route tests for every URL above including the
security envelope. `python3 tools/generate_fixtures.py` run twice yields identical SHA-256 sums for every
file under `export/`. [`docs/SCREENS.md`](docs/SCREENS.md) holds a screenshot of every page and workflow state.
