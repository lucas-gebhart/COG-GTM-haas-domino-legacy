# vetmedals.nsf — @Formula catalogue (narrative)

The complete, machine-extracted list of every `@Formula` in this database (default values, input
translations, input validations, computed values, hide-whens, view selection and column formulas)
is generated from the DXL by `tools/inventory.js` into [`catalogue.md`](catalogue.md). Do not edit
that file by hand. This page is the developer narrative for the rules the migration team asks about most.

## Workflow stage rules

Stage values (free-text in early documents, keyword since 2009): `Authorized`, `Engraving`,
`Assembly/QC`, `Warehouse`, `Shipped`, `Closed`, plus `On Hold` and `Cancelled`.

Permitted transitions are enforced in three places that must agree by hand
(`scriptlibs/HAASAwards.lss` → `IsValidStageTransition`, `scriptlibs/HAASCase.jss` → `nextStage`,
and the `AwardsCase` form `Querysave`):

| From | To |
|------|----|
| Authorized | Engraving, Assembly/QC (when no engravable line), On Hold, Cancelled |
| Engraving | Assembly/QC, On Hold, Cancelled |
| Assembly/QC | Warehouse, Engraving (QC fail → rework), On Hold, Cancelled |
| Warehouse | Shipped, On Hold, Cancelled |
| Shipped | Closed |
| On Hold | any stage except Closed (normally back to `PriorStage`) |
| Closed, Cancelled | none (Admin may reopen via the Notes client) |

## Field validations (from `forms/*.dxl`)

### AwardsCase
```
CaseNumber      @Matches(CaseNumber; "VMA-{0-9}{0-9}{0-9}{0-9}-{0-9}{0-9}{0-9}{0-9}{0-9}{0-9}")
Stage           @IsMember(Stage; @DbLookup("Notes":"NoCache"; ""; "($Lookups)"; "Stages"; 2))
VeteranLastName @Trim != "" and @Length <= 60
VeteranFirstName@Trim != "" and @Length <= 40
ShipToZIP       @Matches(ShipToZIP; "{0-9}{0-9}{0-9}{0-9}{0-9}") | @Matches(ShipToZIP; "{0-9}{0-9}{0-9}{0-9}{0-9}-{0-9}{0-9}{0-9}{0-9}")
AuthorizationDate @IsTime(AuthorizationDate) & AuthorizationDate <= @Today
```

### AwardLine
```
AwardName       required, @Length <= 100
Quantity        1 <= Quantity <= 3   ("Replacement awards are limited to one set")
EngravingText   required when Engrave = "Yes"; @Length <= 40; upper case (translation @UpperCase(@Trim()))
StockNumber     @Matches(StockNumber; "{0-9}{0-9}{0-9}{0-9}-{0-9}{0-9}-{0-9}{0-9}{0-9}-{0-9}{0-9}{0-9}{0-9}")
```

### Requester
```
LastName/FirstName  required, letters, space, apostrophe, hyphen, period only; <= 60 / 40
ZIP                 5 or 5+4 digits
Email               @Matches(@LowerCase(Email); "+@+.+") when present
Phone               digits, space, hyphen, parentheses; 10-14 chars
LookupKey (computed) @UpperCase(@Trim(LastName)) + "|" + @UpperCase(@Trim(FirstName)) + "|" + @Left(ZIP; 5)
```

### EngravingJob
```
CaseNumber      VMA-YYYY-NNNNNN
Items           1..12 entries
EngravingText   <= 40, upper case
```

### ShipmentRecord
```
CaseNumber      VMA-YYYY-NNNNNN
ShipToZIP       5 or 5+4 digits
TrackingNumber  alphanumeric, 10-34 chars
```

### CaseNote
```
Summary         required, <= 200
DocAuthors      author may edit for one hour: @If(@Adjust(NoteDate;0;0;0;1;0;0) > @Now; NoteAuthor : "[Admin]"; "[Admin]")
```

### Profile
```
AgingAmberDays  1 <= AgingAmberDays < AgingRedDays   (defaults 60 / 75)
```

## Computed status / aging

```
AgingFlag   set by agents/NightlyAging.lss, not by formula:
            DaysOpen > AgingRedDays -> "Red"; > AgingAmberDays -> "Amber"; else ""
DaysOpen    @Integer((@Today - EnteredDate) / 86400)         (display-only column in CasesByStage)
```

## Hide-whens of note

* `AwardsCase` fulfilment table rows hide until their stage is reached:
  `Stage = "Authorized"` hides the Engraving row, etc. (`hide='...' ` attributes with `<code event='hidewhen'>`).
* `AwardsCase` Readers field is hidden in all modes (`hide='read edit print preview'`).
* Action bar buttons: `@If(Stage != "Engraving"; @True; !@IsMember("[Engraver]"; @UserRoles))` and so on
  — one per stage, one per role.
