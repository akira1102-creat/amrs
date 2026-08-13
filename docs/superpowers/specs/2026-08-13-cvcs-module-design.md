# CVCS Module and Token Access Design

## Goal

Add CVCS as an independent product module inside the existing AMRS PWA without mixing its records, option lists, searches, or broken-parts workflow with the existing SAE/TAE data model.

The module provides:

- five Property-specific data-entry pages;
- a shared, editable set of CVCS option lists;
- queued and idempotent record submission;
- independent record search, editing, deletion, bulk operations, and export;
- an independent broken-parts and follow-up workflow;
- PIN plus permission-token authentication, including an administrator-only token management page;
- a temporary compatibility path that treats the existing Deploy ID as a universal legacy token until it is explicitly disabled.

This document defines the approved design only. It does not authorize implementation, production-data changes, Google Sheet creation, deployment, or legacy Deploy ID deactivation.

## Selected Architecture

CVCS remains inside the current AMRS PWA so users keep one installed application, one navigation system, and one PIN entry flow. It is implemented as an independent module with its own form component, routes/actions, validation, caches, and Google Sheet file.

This approach is preferred over treating CVCS as another SAE/TAE company because the schemas and maintenance workflow are materially different. A separate standalone PWA is unnecessary and would duplicate installation, authentication, navigation, release, and maintenance work.

The Cloudflare Worker remains the primary data path. The GAS implementation remains a compatible fallback and must use the same request contracts, validation rules, authorization checks, and idempotency behavior.

## Navigation and Page Structure

### Data Entry

Add a top-level collapsible `CVCS` group under Data Entry. It contains five separate Property pages:

- Venetian;
- Londoner;
- Sands;
- Plaza;
- Parisian.

Each page uses the same CVCS form component. The selected page supplies `Property` automatically, so the form does not show a separate Property control.

Desktop uses the existing persistent sidebar. Mobile uses the existing hamburger navigation. Navigation must keep exactly one active item highlighted.

### Query Destinations

Add two independent CVCS destinations under Data Query:

- `CVCS Data Query`;
- `CVCS Broken Parts / Follow-up List`.

CVCS records do not contribute to existing SAE/TAE monthly statistics, daily statistics, schedule counts, or other product-specific summaries unless separately requested later.

## Data-Entry Form

Labels use Chinese first and English second, for example `子位置 Sub Location`.

| Field | Control | Required | Default | Source |
| --- | --- | --- | --- | --- |
| Property | Hidden, page-derived value | Yes | Selected page | Navigation |
| 日期 Date | Date picker | Yes | Today | User-editable, cannot be cleared |
| 地點 Location | Fixed dropdown | Yes | None | Cage, TG, Card Room, Other |
| 子位置 Sub Location | Searchable editable combo | No | Blank | Shared option list, custom text allowed |
| 季度 Quarter | Fixed dropdown | No | None | Q1, Q2, Q3, Q4 |
| 機型 Model | Fixed dropdown | Yes | None | SOT, SCP, Reader |
| 機身號碼 S/N | Text input | Yes | Blank | User-entered |
| 天線尺寸 Antenna Size | Searchable editable combo | No | Blank | Shared option list, custom text allowed |
| 天線狀態 Antenna Status | Searchable editable combo | No | Blank | Shared option list, custom text allowed |
| 版本 Version | Searchable editable combo | No | Blank | Shared option list, custom text allowed |
| 原因 Reason | Searchable editable combo | Yes | PM | Paired mapping, custom text allowed |
| 處理方法及備註 Action Taken & Notes | Searchable editable combo | No | Mapped value when applicable | Paired mapping, custom text allowed |
| 更換零件 Parts Change | Searchable editable combo | No | Blank | Shared option list, custom text allowed |

### Searchable Combo Behavior

Searchable editable combos retain all choices while ranking them as:

1. options related to the typed text;
2. frequently used options;
3. all remaining options.

Selecting an option closes the dropdown. A custom value may be entered even when it is not in the list. A custom record value is not automatically added to the shared option list; only the explicit list editor changes shared options.

Frequency ranking is derived from CVCS records and is not written into the option worksheets.

### Reason and Action Mapping

Reason and Action Taken & Notes use one editable two-column mapping, matching the established SAE/TAE behavior:

- selecting a complete mapped Reason fills its paired Action Taken & Notes;
- partial typing alone does not overwrite Action Taken & Notes;
- users may manually modify either value;
- the list editor manages Reason and Action pairs together.

### Queue and Submission

CVCS supports single-record entry only. It does not include an Excel paste or batch-entry form.

Each Property page has its own pending queue. Users can:

- add a record to the queue;
- edit or delete a queued record;
- select all queued records and delete the selection;
- submit all queued records.

Queues for different Properties must never mix. Submission uses chunks with visible progress and a stable hidden submission identifier per record. If the browser loses the response after a successful write, reconciliation checks the identifier before allowing a retry so the same record is not appended twice.

`Parts Change` is only a value on the main maintenance record. It never creates a broken-parts record automatically.

## Google Sheet Design

Create one independent CVCS Google Sheet file with nine visible worksheets in this order:

1. `CVCS Records`;
2. `Sub Location`;
3. `Antenna Size`;
4. `Antenna Status`;
5. `Version`;
6. `Reason Action Mapping`;
7. `Parts Change`;
8. `CVCS Broken Parts`;
9. `CVCS Parts List`.

All five Property pages share these option worksheets.

### CVCS Records

Visible columns:

| Column | Header |
| --- | --- |
| A | Property |
| B | Date |
| C | Location |
| D | Sub Location |
| E | Quarter |
| F | Model |
| G | S/N |
| H | Antenna Size |
| I | Antenna Status |
| J | Version |
| K | Reason |
| L | Action Taken & Notes |
| M | Parts Change |

The table does not contain PO Number, Inspector, Error Description, or Box ID.

An app-managed Submission ID is stored in a hidden protected column. It is excluded from normal coworker editing, PWA display, searches, and exports.

### Editable Option Worksheets

`Sub Location`, `Antenna Size`, `Antenna Status`, `Version`, and `Parts Change` each use column A with header `Option`.

`Reason Action Mapping` uses:

- column A: `Reason`;
- column B: `Action Taken & Notes`.

Each list editor supports add, edit, delete, drag ordering, and A-Z sorting. Changes invalidate the relevant cached option list immediately.

### CVCS Broken Parts

Visible columns:

| Column | Header |
| --- | --- |
| A | Property |
| B | Model |
| C | S/N |
| D | Parts No. |
| E | Required Parts (EN) |
| F | Qty |
| G | Repair Day |
| H | Found Day |
| I | Remark |
| J | Request Follow-up Date |
| K | Follow-up Completed Date |

There is no Japanese part-name column and no UOD or Hold workflow. A hidden protected Submission ID supports idempotent submission.

### CVCS Parts List

Visible columns:

- `Parts No.`;
- `Required Parts (EN)`.

The worksheet is initially created with headers only. The user will populate the parts later.

### Sheet Formatting

All worksheets use a header row, freeze row 1, enable filters where appropriate, apply date formatting to date columns, and use practical column widths. Hidden application metadata must not appear in exports or routine user-facing operations.

## Broken Parts and Follow-up Workflow

The main CVCS form contains a collapsible `Broken Parts / Follow-up` section. A user may create:

- a broken-parts entry only;
- a follow-up request only;
- both in the same operation.

Part-specific quantity and repair controls appear only after a part is selected. If no part is selected, no empty part fields are written. This permits a follow-up request without a required part.

`Request Following Up` is a button inside this section. Activating it copies the maintenance Date into `Request Follow-up Date`. Completion is recorded later by editing `Follow-up Completed Date` in the broken-parts/follow-up list.

Status presentation:

- `Waiting Parts`: orange-yellow;
- `Repaired`: green;
- `Following Up`: blue;
- `Follow-up Completed`: green.

The independent list supports:

- Property, S/N, part, and status filters;
- newest/oldest sorting;
- server-side pagination and selectable page size;
- cards that omit blank fields;
- edit and delete;
- bulk edit;
- selectable-field Excel and PDF export with blank columns omitted;
- `View Records`, opening the matching CVCS maintenance records with the same edit and delete capabilities as the main CVCS query.

## CVCS Data Query

The query defaults to all Properties and provides:

- Date, defaulting to unrestricted;
- Property;
- Location;
- Quarter;
- Model;
- S/N;
- a keyword search covering Sub Location, Antenna fields, Version, Reason, Action Taken & Notes, and Parts Change.

S/N search is exact by default. Fuzzy search must be explicitly enabled before partial or general text matching is used.

Results use responsive cards and omit blank fields. Features include:

- newest/oldest sorting;
- server-side pagination and selectable page size;
- one, two, or three cards per row on desktop;
- locally persisted display-field, page-size, and card-density preferences;
- record editing and deletion;
- searchable editable combos inside the editor;
- selection, select-all, bulk edit, and bulk delete;
- Excel and PDF export after choosing fields;
- export title `CVCS Maintenance Record`;
- no blank export columns;
- persistent progress feedback until an export or bulk operation finishes.

## PIN and Permission-Token Authentication

### Login Flow

All users continue entering the existing six-digit PIN. The second credential changes from a deployment identifier to a permission token:

1. enter the PIN;
2. enter a personal token;
3. validate token status and permissions on the server;
4. expose only the permitted functions.

The token permission groups are:

- Work Schedule;
- SAE/TAE;
- CVCS.

Frontend navigation visibility is a convenience only. Every read, search, submit, edit, delete, bulk operation, option-list operation, and export-data request must enforce the same permission on the server.

### Token Management Page

An administrator-only page supports:

- creating a token;
- attaching a coworker label or operational note;
- enabling any combination of the three permission groups;
- showing status, creation time, last-use time, and token suffix only;
- suspending and reactivating a token;
- permanently deleting a token.

The complete token is displayed only once at creation. The server stores only a strong one-way token hash, never a recoverable token value.

Suspension or deletion takes effect on the next protected operation, not merely at the next app launch. An affected device is signed out and cannot continue using previously visible pages.

Only a dedicated administrator token can access token management. Ordinary tokens cannot create administrators or elevate their own permissions. A lost administrator token is replaced through a backend-only administrative procedure.

### Legacy Deploy ID Transition

The existing Deploy ID is temporarily accepted as a `Legacy Universal Token` with access to:

- Work Schedule;
- SAE/TAE;
- CVCS.

It has no token-management permission. Existing devices may continue using their stored Deploy ID without immediate re-entry. There is no automatic expiry date. Legacy acceptance is disabled only after the user gives a separate explicit instruction.

The legacy value must not be copied into new reusable documentation, logs, exports, client-visible configuration, or source control.

## Backend Contracts and Performance

CVCS uses dedicated backend actions rather than overloading SAE/TAE record contracts. The implementation plan should define paired Worker and GAS actions for:

- option-list reads and administration;
- record submit, query, update, delete, and bulk operations;
- broken-parts/follow-up submit, query, update, delete, and bulk operations;
- token validation and administrator-only token management.

Performance requirements:

- cache shared option lists for a short period;
- invalidate affected caches after edits;
- apply filters, sorting, and pagination on the server;
- avoid downloading complete worksheets for routine page loads;
- keep separate cache namespaces for CVCS records, options, and broken-parts data;
- avoid global locks around read-only operations;
- keep write locks as narrow as possible.

## Concurrency and Data Safety

Every submitted main record and broken-parts/follow-up record carries a stable Submission ID generated before the request. Both Worker and GAS fallback must:

1. validate authorization and input;
2. check whether the Submission ID already exists;
3. append only missing records;
4. return existing-record confirmation for a repeated identifier;
5. support client reconciliation after an unknown network outcome.

Concurrent users must not overwrite or duplicate one another's writes. Update, delete, and bulk operations validate a fresh record snapshot or equivalent version marker before writing. If another user or direct Sheet editor has changed the target, the operation stops and asks the client to refresh instead of overwriting newer data.

Chunked submission displays progress and retains unresolved queued records if only part of a request is confirmed. A generic connection error must not encourage blind resubmission before reconciliation completes.

## Error Handling

- Invalid or revoked token: sign out and show a clear access message.
- Missing permission: hide the destination and reject direct API access.
- Invalid required CVCS fields: keep the form values and identify the field.
- Option-list save failure: preserve unsaved editor values.
- Unknown submission outcome: reconcile by Submission ID before showing retry.
- Stale record during edit/delete/bulk operation: cancel the write and reload the affected data.
- Partial chunk completion: remove only confirmed items from the pending queue.
- Export failure: keep the field selection and close progress only after an explicit success or failure result.

## Verification and Acceptance

### Authentication and Authorization

- PIN plus ordinary token login succeeds.
- Each permission group independently controls both navigation and backend operations.
- A suspended or deleted token stops working on its next protected request.
- An ordinary token cannot access token administration or elevate itself.
- The administrator can create, label, permission, suspend, reactivate, and delete tokens.
- The complete token is shown only once and is not recoverable from storage.
- Legacy Deploy ID continues working as a universal non-admin token until explicitly disabled.

### Data Entry and Submission

- Each Property page supplies the correct Property and keeps an independent queue.
- Date defaults to today and cannot be cleared.
- Location, Model, S/N, and Reason are required; Reason defaults to PM.
- Searchable combos rank matches, then frequent options, then others.
- Custom values save to records without silently changing shared lists.
- A complete mapped Reason fills Action Taken & Notes; partial typing does not.
- Queue edit, delete, select-all-delete, chunk progress, and retry reconciliation work.
- Simultaneous devices and response-loss retries do not create duplicate rows.

### Broken Parts and Follow-up

- A part-only record, follow-up-only record, and combined record all save correctly.
- Empty part fields are not written when no part is selected.
- Status colors match the approved scheme, including blue `Following Up`.
- Completion dates change the displayed status correctly.
- Search, filters, pagination, edit, delete, bulk edit, record viewing, and exports work.

### Query and Export

- Default scope searches all Properties.
- Exact S/N search excludes partial matches unless fuzzy search is enabled.
- Editing preserves searchable/custom controls.
- Delete and bulk delete require confirmation and update the visible results.
- Pagination, page size, card density, and locally persisted preferences work on desktop and mobile.
- Excel and PDF include only selected nonblank columns and use the approved title.

### Release Checks

- Worker automated tests cover authorization, validation, idempotency, pagination, stale updates, and token lifecycle.
- Worker and GAS fallback contracts are checked for parity.
- Syntax and targeted frontend tests pass.
- Desktop and mobile rendered flows are verified.
- PWA visible version and service-worker cache identifier are incremented together when implementation changes cached assets.
- Deployment and live verification occur only in the later implementation phase after the written implementation plan is approved.

## Out of Scope

- Populating the CVCS Parts List beyond headers;
- importing CVCS records through Excel or a paste-based batch form;
- mixing CVCS into existing SAE/TAE statistics or schedule counts;
- adding PO Number, Inspector, Error Description, or Box ID to CVCS;
- automatically adding custom record text to shared option lists;
- disabling the legacy Deploy ID without a new explicit instruction;
- implementing or deploying any part of this design during the design-only phase.
