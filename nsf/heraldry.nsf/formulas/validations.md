# heraldry.nsf — @Formula catalogue

Extracted from the form DXL (`forms/*.dxl`) so the migration team can port each rule without reading
Domino XML. The same rules are duplicated in `scriptlibs/HAASValidation.lss` (back-end / agents) and
`scriptlibs/HAASRequest.jss` (XPages) — three copies that have drifted slightly over the years; the
DXL is authoritative for the Notes client, the `.jss` for the web.

## Input translation (normalization before validation)

| Form | Field | Formula |
|------|-------|---------|
| Request, SESFlagRequest, Requester, Vendor | `DODAAC`, `UIC`, `VendorKey` | `@UpperCase(@Trim(x))` |
| Request | `RPD` | `@Right("00" + @Trim(RPD); 2)` |
| Request | `FundCode`, `ProjectCode` | `@UpperCase(@Trim(x))` |
| sfRequesterPOC, Requester | `RequesterEmail`, `Email` | `@LowerCase(@Trim(x))` |
| HeraldicItem | `StockNumber` | `@Trim(StockNumber)` |

## Input validation

### DODAAC (Request block 1; also SESFlagRequest, Requester)
```
@If(@Trim(DODAAC) = ""; @Failure("DODAAC is required (block 1).");
    @Length(DODAAC) != 6; @Failure("DODAAC must be exactly 6 characters.");
    !@Matches(DODAAC; "{A-Z0-9}{A-Z0-9}{A-Z0-9}{A-Z0-9}{A-Z0-9}{A-Z0-9}");
    @Failure("DODAAC must be 6 alphanumeric characters (A-Z, 0-9).");
    @Success)
```

### UIC (Request; optional on SESFlagRequest)
```
@If(@Trim(UIC) = ""; @Failure("UIC is required.");
    @Length(UIC) != 6; @Failure("UIC must be exactly 6 characters.");
    @Left(UIC; 1) != "W"; @Failure("Army UICs begin with W.");
    !@Matches(UIC; "W{A-Z0-9}{A-Z0-9}{A-Z0-9}{A-Z0-9}{A-Z0-9}");
    @Failure("UIC must be W followed by 5 alphanumeric characters.");
    @Success)
```

### Requisition Priority Designator (Request)
```
@If(!@IsMember(RPD; "01":"02":"03":"04":"05":"06":"07":"08":"09":"10":"11":"12":"13":"14":"15");
    @Failure("Requisition Priority Designator must be 01 through 15.");
    @Success)
```

### Request type (Request)
```
@If(!@IsMember(RequestType; "Guidon":"Distinguishing Flag":"Organizational Colors":"Streamer":"Insignia":"Other Heraldic Item");
    @Failure("Select the type of heraldic item requested."); @Success)
```

### Required text fields (Request)
```
@If(@Trim(UnitName) = ""; @Failure("Unit designation is required."); @Length(UnitName) > 120; @Failure("Unit designation may not exceed 120 characters."); @Success)
@If(@Trim(@Implode(ShipToAddress; " ")) = ""; @Failure("Ship-to address is required."); @Success)
```

### Requester POC (sfRequesterPOC — shared by Request and SESFlagRequest)
```
@If(@Trim(RequesterName) = ""; @Failure("Requester name is required.");
    @Length(RequesterName) > 80; @Failure("Requester name may not exceed 80 characters."); @Success)

@If(@Trim(RequesterEmail) = ""; @Failure("An e-mail address is required for status notifications.");
    !@Contains(RequesterEmail; "@") | @Length(RequesterEmail) > 120; @Failure("E-mail address is not valid.");
    !@Ends(RequesterEmail; ".mil") & !@Ends(RequesterEmail; ".gov"); @Failure("E-mail must be a .mil or .gov address.");
    @Success)
```

### Line item (RequestLine)
```
@If(@Trim(NSN) = "" & @Trim(ExceptionData) = ""; @Failure("Enter either an NSN or exception data describing the non-NSN item.");
    @Trim(NSN) != "" & !@Matches(NSN; "{0-9}{0-9}{0-9}{0-9}-{0-9}{0-9}-{0-9}{0-9}{0-9}-{0-9}{0-9}{0-9}{0-9}");
    @Failure("NSN must be in the format 9999-99-999-9999.");
    @Length(ExceptionData) > 250; @Failure("Exception data may not exceed 250 characters.");
    @Success)

@If(!@IsMember(UnitOfIssue; "EA":"SE":"PR":"KT"); @Failure("Unit of issue must be EA, SE, PR or KT."); @Success)

@If(!@IsNumber(Quantity); @Failure("Quantity must be a whole number.");
    Quantity < 1; @Failure("Quantity must be at least 1.");
    Quantity != @Integer(Quantity); @Failure("Quantity must be a whole number.");
    @Trim(ItemKey) != "" &
      Quantity > @TextToNumber(@Text(@DbLookup("Notes":"NoCache"; ""; "HeraldicCatalog"; ItemKey; 5)));
      @Failure("Quantity exceeds the maximum per request for this item (see HeraldicItem.MaxQtyPerRequest). Submit a separate request or contact TACOM.");
    Quantity > 500; @Failure("Quantity may not exceed 500 on a single line.");
    @Success)
```

### SES flag (SESFlagRequest)
```
@If(!@IsNumber(Quantity) | Quantity < 1; @Failure("Quantity must be at least 1.");
    Quantity > 2; @Failure("SES flag requests are limited to 2 per executive per request."); @Success)
@If(!@IsMember(ExecutiveTier; "Tier 1":"Tier 2":"Tier 3"); @Failure("Select the SES tier."); @Success)
```

### Catalog / vendor master data
```
HeraldicItem.StockNumber : @Matches(StockNumber; "{0-9}{0-9}{0-9}{0-9}-{0-9}{0-9}-{0-9}{0-9}{0-9}-{0-9}{0-9}{0-9}{0-9}")
HeraldicItem.MaxQtyPerRequest : MaxQtyPerRequest >= 1 & MaxQtyPerRequest <= 500
Vendor.VendorKey (CAGE) : @Length(VendorKey) = 5 & @Matches(VendorKey; "{0-9A-Z}{0-9A-Z}{0-9A-Z}{0-9A-Z}{0-9A-Z}")
Vendor.ContractNumber : @Begins(ContractNumber; "SPE")   (DLA Troop Support)
Vendor.LeadTimeDays : 15..60
```

## Computed values

| Field | Formula | Note |
|-------|---------|------|
| `Request.DocumentNumber` | `DODAAC + JulianDate + @Right("0000" + @Text(serial); 4)` | 14 chars; serial from Profile (not transactional — duplicates exist) |
| `Request.EstimatedShipDate` | `@Adjust(ReleasedDate; 0; 0; VendorLeadTimeDays; 0; 0; 0)` | |
| `Request.LineCount` / `TotalValue` | `@Elements(@DbLookup(...))`, `@Sum(...)` on `($All)` | recomputed on save only |
| `RequestLine.ExtendedPrice` | `@Round(Quantity * UnitPrice; 2)` | |
| `Request.StatusInquiryKey` | `@UpperCase(DocumentNumber) + "\|" + @UpperCase(DODAAC) + "\|" + @UpperCase(UIC)` | rebuilt nightly |
| `Request.DocReaders` (Readers) | `@Trim(@Unique("[TACOM]":"[DLA]":"[Admin]":"[ReadOnlyAudit]":"LocalDomainServers":EnteredBy:@If(VendorKey != ""; "Vendor-" + VendorKey; "")))` | |
| `Request.DocAuthors` (Authors) | `@If(IsReleased; "[TACOM]":"[Admin]":"Vendor-" + VendorKey; "[TACOM]":"[Admin]":EnteredBy)` | requester loses edit on release |
| `HeraldicItem.FSC` / `NIIN` | `@Left(StockNumber; 4)` / `@ReplaceSubstring(@Right(StockNumber; 11); "-"; "")` | |

## Status model (Request)

```
Draft -> Submitted -> Under Review -> Approved -> Released to Vendor -> In Production -> Shipped -> Complete
                 \-> Cancelled (allowed from any state before Released to Vendor)
```
Released check (`IsReleased`): `@IsMember(Status; "Released to Vendor":"In Production":"Shipped":"Complete":"Cancelled") | @Text(ReleasedDate) != ""`.

Legacy error text on blocked modify/cancel:
`This request has been released to the vendor and can no longer be modified or cancelled. Contact TACOM Clothing & Heraldry PSID for assistance. (Error 4091)`

## Hide-when formulas (selection)

| Where | Formula | Effect |
|-------|---------|--------|
| Request "TACOM Processing" section | `!@IsMember("[TACOM]":"[DLA]":"[Admin]"; @UserRoles)` | staff only |
| Request "Edit" action | `@IsMember(Status; "Released to Vendor":"In Production":"Shipped":"Complete":"Cancelled")` | |
| Request "Release to Vendor" action | `!@IsMember("[TACOM]"; @UserRoles) \| @IsMember(Status; ...released...)` | |
| SESFlagRequest "Approve" action | `!@IsMember("[SESApprover]"; @UserRoles) \| Status != "Submitted"` | |
| Vendor/HeraldicItem "Edit" action | `!@IsMember("[TACOM]":"[Admin]"; @UserRoles)` | |
| ccLayout nav "Vendor" group | `HAASStatus.hasRole('[Vendor]') \|\| HAASStatus.hasRole('[TACOM]')` (SSJS) | |
