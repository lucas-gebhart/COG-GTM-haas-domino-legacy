# HAAS — Domino design handover

> **Synthetic stand-in.** Nothing in `nsf/` is an export of a real Army system. It is a plausible
> HCL Domino / XPages design, written the way a two-database Domino application of 2004–2024
> vintage would look after a `Tools > DXL Utilities > Exporter` run, so that a migration team has
> realistic source to discover, inventory, and port. Where public facts about the real mission
> exist (DD Form 1348-6, DODAAC/UIC, the 60–75 day awards goal, the public URL shapes) they are
> reflected; everything else is invented.

This document is written as the handover a departing Domino developer would leave. It walks the
design database by database, then lists the **known warts** — the numbered list that the
`' wart #n` comments in the LotusScript and the `$Comment` items on views refer to.

---

## 1. Servers, databases, replication

| | |
|---|---|
| Server | `CN=HAAS-APP01/O=TACOM`, Domino 12.0.2 FP2 on Windows Server 2019 (`notes.ini.sample`) |
| Databases | `haas\heraldry.nsf` (replica `C1258A1F00305C22`) and `haas\vetmedals.nsf` (replica `C1258A1F00305D71`) |
| Side databases | `haas\haaslog.nsf` (agent + XPages audit log, form `AgentLog`), `haas\archive\heraldry_arch.nsf`, `haas\archive\vetmedals_arch.nsf` |
| Templates | Both databases inherit from **no** template (`database.properties.dxl` → `fromtemplate=''`). Design changes are made directly in production with Designer; there is no dev/test replica. |
| Replication | Single replica each. The disaster-recovery replica on `HAAS-APP02` was decommissioned in 2019; the replication history is still visible in the database properties. |
| Full-text index | **None** on either database. Every `db.Search` in the agents is a linear scan. |
| Web | One Web Site document, host `heraldry.example.mil`; the legacy host `heraldryhome.example.mil` is a URL-mapping to `heraldry.nsf` (`httpd.cnf.sample`). |

## 2. heraldry.nsf — Heraldry requisitions

**Purpose.** Unit supply / S4 personnel submit DD Form 1348-6 requisitions for heraldic items
(guidons, distinguishing flags, streamers, organizational colors, insignia). TACOM staff review and
approve; approved requests are released to a contract vendor; the vendor reports production and
shipment; requesters check status by document number. SES flag requests are a separate
form/workflow.

### 2.1 Forms

| Form | Alias | Role | Notes |
|---|---|---|---|
| `Request` | `req` | DD1348-6 header | Document number = requisitioner DODAAC + Julian date + 4-digit serial (`HAASCommon.FormatDocNumber`). `Status` keyword. Locked after release (`Queryopen` blocks edit mode, `Readers`/`Authors` fields narrow to `[TACOM]` + vendor). Action bar: Save, Submit, Approve, Release to Vendor, Cancel, Print DD1348-6. |
| `RequestLine` | `line` | Response to Request | One per requisition line: NSN or exception item, unit of issue, quantity, unit price, heraldic item ref. Quantity limits come from `HeraldicItem.MaxQty`. |
| `SESFlagRequest` | `ses` | SES flag ordering | Separate approval chain (SES administrative office), separate queue view. |
| `Vendor` | `vendor` | Contract vendors | `VendorKey` = CAGE code (5 alnum). Access list drives the `Heraldry-Vendors` group entries. |
| `HeraldicItem` | `item` | Catalog | NSN-like stock numbers (`8345-01-…` for flags, `8455-…` insignia), unit of issue, unit price, lead time, `MaxQty`. |
| `Requester` | `rqstr` | Unit POC | Keyed on DODAAC + e-mail. |
| `Profile` | | Config | Profile document: keywords (statuses, RPDs, project codes, fund codes), serial counters, mail settings. |
| `sfRequesterPOC` | | Subform | Shared POC block used on `Request` and `SESFlagRequest`. |

### 2.2 Views

`RequestsByStatus` (categorised by `Status`, the operational view), `RequestsByUnit` (by UIC),
`RequestsByDODAAC`, `OpenVendorWork` (per-vendor queue, categorised by `VendorKey`),
`StatusInquiry` (flat lookup keyed on `DocumentNumber`, Anonymous readable — the *only* Anonymous
surface), `SESFlagQueue`, `HeraldicCatalog`, `($All)`, `($Lookups)` (keyword lookups from
Profile).

### 2.3 Agents

| Agent | Trigger | What it does |
|---|---|---|
| `ReleaseToVendor` | Actions menu, selected docs | Validates vendor, sets `ReleasedDate`/`ReleasedBy`, status → `Released to Vendor`, narrows Readers/Authors, mails vendor (`HAASMail.SendVendorRelease`). |
| `CancelRequest` | Actions menu | Refuses if released (error 4091 text below), else status → `Cancelled`, notifies requester. |
| `SendStatusMail` | New/modified docs, 30 min | Mails requester POC on status change. |
| `RebuildStatusInquiryIndex` | Manual (Notes client only — exceeds the 60 s web agent timeout) | Rebuilds the `StatusInquiry` view and re-keys documents whose `DocumentNumber` was edited. |

**Legacy error text** (in `HAASCommon.lss`, `HAASRequest.jss`, `ModifyRequest.xsp`, and the harness):

```
This request has been released to the vendor and can no longer be modified or cancelled.
Contact TACOM Clothing & Heraldry PSID for assistance. (Error 4091)
```

### 2.4 XPages

`HeraldryHome.xsp`, `Request.xsp`, `ModifyRequest.xsp`, `StatusInquiry.xsp`, `SESFlag.xsp`,
`VendorQueue.xsp`, `Login.xsp` (EAMS-A SAML explanation stub), custom controls `ccLayout.xsp`
and `ccStatusBanner.xsp`, SSJS libraries `HAASStatus.jss` and `HAASRequest.jss`.
`xsp.properties` and `faces-config.xml` are the Designer-generated files with the managed beans
the pages reference (the Java for those beans lives in `haas-xsp-1.4.2.jar` on the server and is
**not** in this export — see wart #13).

## 3. vetmedals.nsf — Veteran awards cases

**Purpose.** HRC or NPRC determines a veteran's entitlement and transmits an electronic
authorization file. `ImportAuthorizationFile` turns each record into an `AwardsCase` with
`AwardLine` responses, de-duplicating `Requester` documents. CSRs work the case through
Engraving → Assembly/QC → Warehouse → Shipped → Closed. `NightlyAging` flags cases against the
60/75-day goal.

### 3.1 Forms

| Form | Alias | Role | Notes |
|---|---|---|---|
| `AwardsCase` | `case` | Case header | `CaseNumber` = `VMA-YYYY-NNNNNN`. `Stage` keyword. Embedded `(CaseLines)` view. `Querysave` enforces `IsValidStageTransition`. Fulfilment dates per stage, `AgingFlag`, `StatusHistory` multi-value. |
| `AwardLine` | `aline` | Response | Award/decoration (keyword table on Profile), qty 1–3, set type, devices, engrave Y/N + text (≤ 40, upper case), authority. |
| `Requester` | `vreq` | Veteran / NOK | Synthetic PII only. `LookupKey = UPPER(last)|UPPER(first)|zip5` is the dedupe key (wart #2). |
| `AuthorizationFile` | `auth` | Transmission record | Raw file attached in `FileBody` (`$FILE`), import counters, import log. |
| `EngravingJob` | `eng` | Shop work order | Linked to the case by `CaseNumber` text, not by response hierarchy (wart #5). |
| `ShipmentRecord` | `ship` | Shipment | Carrier, tracking, dates; `ShipDateText` legacy copy (wart #3). |
| `CaseNote` | `note` | Response | Rich-text note; author may edit for one hour, then `[Admin]` only. |
| `Profile` | | Config | Stages, aging thresholds, awards keyword table (`Name|CODE|Category|Engrave`), serial counters, import/archive paths, mail settings. |

### 3.2 Views

`CasesByStage` (categorised by `Stage`, shows response lines), `CasesByAuthDate` (by
authorization month — exposes wart #3), `AgingCases` (`AgingFlag != ""`, categorised Red/Amber),
`EngravingQueue`, `AssemblyQueue`, `WarehousePick`, `ShipConfirm`, `CSRLookup` (combined
requester + case lookup), `($All)`, `($Lookups)`, `(CaseLines)` (embedded), `($AuthFiles)`.

### 3.3 Agents

| Agent | Trigger | What it does |
|---|---|---|
| `ImportAuthorizationFile` | Daily 04:15 + manual | Parses HRC fixed-width (`01/10/20/99` records) or NPRC pipe-delimited (`NPRC-AWD` header, `C`/`A`/`T` records) files. Layouts are documented at the top of the `.lss`. Creates cases/lines, dedupes requesters, writes an import log to the `AuthorizationFile` document. |
| `NightlyAging` | Daily 02:00 | `DaysOpen`, `DaysInStage`, `AgingFlag` (Amber > 60, Red > 75, from Profile); mails summary. |
| `SendStatusMail` | New/modified, 30 min | Status e-mail to requester when `Requester.Email` present. |
| `ArchiveClosedCases` | Weekly Sun 01:00 | Moves cases closed > 730 days and related docs to the archive replica. |
| `(AdvanceStage)` | Hidden, from action buttons | Moves selected cases one stage forward with role checks; creates `EngravingJob` / `ShipmentRecord` as needed. |

### 3.4 XPages

`CaseView.xsp` (CSR case detail with stage strip and actions), `EngravingQueue.xsp`,
`CSRLookup.xsp`; custom controls `ccLayout.xsp` / `ccStatusBanner.xsp` (copies of the heraldry
ones — wart #7); SSJS `HAASCase.jss`.

## 4. Security model

* **ACL** (`acl.dxl` in each database): `-Default-` No Access; `Anonymous` Reader on heraldry.nsf
  only (for `StatusInquiry`), No Access on vetmedals.nsf. Groups `TACOM-CHPSID-Staff` (Editor),
  `Heraldry-Vendors` (Author, `[Vendor]`), `HAAS-Admins` (Manager), `HAAS-Auditors` (Reader,
  `[ReadOnlyAudit]`), `LocalDomainServers` (Manager), plus individual user entries that pre-date
  the groups.
* **Roles**: `[TACOM]`, `[DLA]`, `[Vendor]`, `[CSR]`, `[Engraver]`, `[Assembler]`, `[Warehouse]`,
  `[Admin]`, `[ReadOnlyAudit]`, `[Importer]` (vetmedals only), `[SESApprover]` (heraldry only).
* **Readers/Authors fields**: every document carries `DocReaders` (computed from roles + the
  requesting unit / vendor / CSR) and most carry `DocAuthors`. A request released to a vendor is
  readable by `[TACOM]`, `[ReadOnlyAudit]`, `LocalDomainServers` and that vendor's key only.
* **Authentication**: EAMS-A SAML through Domino's SAML IdP catalog; Domino sets `DOMRELAYSTATE`
  to remember the requested URL across the redirect. `Login.xsp` only explains this to the user.
  Nothing in this repository is the real IdP configuration.
* **Agent signing**: all scheduled agents are signed by the server ID so `LocalDomainServers` in
  every Readers field is what lets them see documents.

## 5. Known warts

The numbers are referenced from code comments (`' wart #n`) and view `$Comment` items.
`export/DATA-QUALITY-NOTES.md` gives the exact counts present in the synthetic export.

| # | Wart | Where | Consequence for migration |
|---|---|---|---|
| 1 | **Free-text status / stage values.** `Request.Status` and `AwardsCase.Stage` were editable text until the 2009 redesign; variants like `Rel to Vendor`, `REL`, `released`, `Assembly`, `QC`, `Engrave` survive on old documents. `HAASCommon.NormalizeStatus` maps the ones we know about. | `Request`, `AwardsCase`; `RequestsByStatus`, `CasesByStage` categories | Needs a mapping table; categorised views show the variants as separate categories. |
| 2 | **Duplicated requester documents.** Dedupe key is `UPPER(last)|UPPER(first)|zip5`; suffixes (`Jr.`), middle initials in the first-name field, ZIP+4 vs ZIP5 and NOK-vs-veteran entries all defeat it. ~8% of requesters are duplicates of another. | `Requester` (both dbs), `ImportAuthorizationFile`, `CSRLookup` | Merge on a stronger key before load; keep a crosswalk of old `RequesterID`s. |
| 3 | **Mixed date formats.** `AuthorizationDate`, `EnteredDate`, `ShippedDate` were text fields until 2009; `3/4/2008`, `2008-03-04`, `04 MAR 08`, `20080304` all occur. `ShipmentRecord.ShipDateText` is the legacy copy. `HAASCommon.ParseLegacyDate` handles the known shapes. | `AwardsCase`, `ShipmentRecord`, `Request.EnteredDate` (a few) | Parse with the same rules; the `CasesByAuthDate` view puts text dates in a `(text date)` category. |
| 4 | **Deleted-but-referenced vendor.** Vendor `1K7Q3` (Colonial Flag & Banner Works) was deleted in 2018 after contract end; ~2% of released requests still carry that `VendorKey`. `OpenVendorWork` shows them under a category with no vendor document; `@DbLookup` of the vendor name errors and the column shows the key. | `Request.VendorKey`, `Vendor` | Re-create an inactive vendor row or map to `(unknown vendor)`. |
| 5 | **Orphaned response / child documents.** `RequestLine` and `AwardLine` are responses; deleting a parent in the Notes client without "delete responses" leaves orphans (`@IsResponseDoc` true, no parent). `EngravingJob` and `ShipmentRecord` are linked by `CaseNumber` text only. | `RequestLine`, `AwardLine`, `EngravingJob`, `ShipmentRecord` | Load children with a nullable parent FK; report orphans. |
| 6 | **Attachments referenced by `$FILE`.** `AuthorizationFile.FileBody` (raw transmissions), `Request.Attachments` (scanned DD1348-6, justification memos), `SESFlagRequest.Attachments`. The DXL export carries `<item name='$FILE'>` with file name and size, and the binary is in the NSF only. Some `$FILE` items reference names that no longer exist in the note (partial DAOS restore, 2020). | DXL export | Extract via `NotesEmbeddedObject.ExtractFile` before decommissioning; expect misses. |
| 7 | **Copied, drifted shared code.** `HAASCommon.lss`, `ccLayout.xsp`, `ccStatusBanner.xsp` were copied from heraldry.nsf into vetmedals.nsf, not shared via a template. The vetmedals copy has `SafeGetDate`/`ParseLegacyDate`; the heraldry copy has `IsReleased`/`FormatDocNumber`. | `scriptlibs/`, `customcontrols/` | Treat each database's copy as authoritative for that database. |
| 8 | **Business rules in three languages.** Validations exist as `@Formula` (forms), LotusScript (`HAASValidation.lss` / `HAASAwards.lss`) and SSJS (`HAASRequest.jss` / `HAASCase.jss`). They have drifted slightly (e.g. the SSJS UIC check allows lower case before translation; the LotusScript stage table allows `Assembly/QC → Engraving`, the SSJS does not). | `forms/`, `scriptlibs/` | The DXL formula is authoritative for Notes client behaviour, the `.jss` for web. |
| 9 | **Non-transactional serial numbers.** `NextSerial` read-increment-saves a profile field. Concurrent saves have produced ~30 duplicate `DocumentNumber`s and a handful of duplicate `CaseNumber`s. | `HAASCommon.NextSerial`, `Profile` | Do not assume `DocumentNumber` / `CaseNumber` is unique; use UNID as the natural key. |
| 10 | **Readers-field lock-out.** `DocReaders` is computed from roles *and* the requesting unit's DODAAC group / vendor key. When a vendor was removed from the ACL (2018) its released requests became invisible to everyone but `[TACOM]` and the server. Users see "document count" mismatches between views and `($All)`. | `Request`, `AwardsCase` | Export with a server ID; expect view counts to differ from document counts. |
| 11 | **`$UpdatedBy` polluted by agents.** `NightlyAging` saves every open case every night, so `$UpdatedBy` on old cases is dominated by `CN=HAAS-APP01/O=TACOM` and `$Revisions` has thousands of entries on long-open cases. | `AwardsCase` | Do not use `$UpdatedBy(last)` as "last human editor"; use `LastModifiedBy`. |
| 12 | **No full-text index; linear agent scans.** `NightlyAging`, `ArchiveClosedCases` and `(AdvanceStage)` fall back to `db.Search`, ~4 min on 3,000 open cases; `AMgr_NightMaxRunTime` was raised to 60 min in 2017. | `notes.ini.sample`, agents | Irrelevant after migration, but explains the 02:00 schedule and why the aging flags are "as of last night". |
| 13 | **Java not in the export.** `faces-config.xml` references managed beans and a phase listener in `haas-xsp-1.4.2.jar`, deployed to `jvm/lib/ext` on the server. Source for the jar was in a departed contractor's workspace. | `faces-config.xml`, `xsp.properties` | Behaviour is reproducible from the SSJS and LotusScript; the jar only added audit logging and converters. |
| 14 | **Stale ACL entries.** Individual user entries for people who separated (e.g. `CN=Ret Hamlin/OU=CHPSID/O=TACOM`, 2019) were never removed; a `[DLA]` role exists with no members since the DLA hand-off never happened. | `acl.dxl` | Rebuild access from the groups, not the individual entries. |

## 6. Handover checklist for the migration team

1. Start from `docs/DESIGN-INVENTORY.md` (generated by `tools/inventory.js`) for the counts.
2. Read `nsf/*/formulas/validations.md` for the business rules, then `formulas/catalogue.md` for
   every formula verbatim.
3. Use `export/dxl/*.dxl` as the record-level truth and `export/csv/*.csv` as the flattened,
   load-ready form. `export/DATA-QUALITY-NOTES.md` enumerates the defects above with counts.
4. `export/authorization-files/` are the inbound interface samples; the parser in
   `ImportAuthorizationFile.lss` is the interface specification.
5. Run the harness (`npm start`, port 8088) to see how users experience each design element.
