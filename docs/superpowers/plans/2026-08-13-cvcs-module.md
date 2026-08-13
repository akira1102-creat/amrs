# CVCS Module and Permission Tokens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the approved CVCS data-entry, query, broken-parts/follow-up, and permission-token workflows to AMRS while preserving the existing Deploy ID as a temporary non-admin universal token.

**Architecture:** Keep CVCS inside the current static AMRS PWA but isolate its client behavior in a testable `cvcs.js` module. Add dedicated Worker domain/repository actions backed by one independent Google Sheet, mirror those contracts in GAS, and store token hashes/permissions in D1. The Worker remains primary and GAS remains a compatible fallback for data actions; authorization remains server-enforced.

**Tech Stack:** Static HTML/CSS/JavaScript PWA, Node test runner, Cloudflare Worker and D1, Google Sheets API, Google Apps Script.

## Global Constraints

- Follow `docs/superpowers/specs/2026-08-13-cvcs-module-design.md` exactly.
- Do not embed or commit real credentials, tokens, Deploy IDs, spreadsheet IDs, or equipment identifiers.
- Worker and GAS fallback data contracts must remain synchronized.
- Existing Deploy ID remains a non-admin universal legacy token until a separate explicit deactivation request.
- The complete administrator or user token is displayed only once; storage contains only a SHA-256 hash.
- Apply server-side permission checks to every protected endpoint, not only frontend navigation.
- Use stable Submission IDs and reconciliation for unknown submission outcomes.
- Increment visible PWA version and service-worker cache identifiers together.
- Use test-first changes and synthetic fixtures.

---

### Task 1: CVCS Domain Contracts and Sheet Schema

**Files:**
- Create: `worker/src/cvcs-domain.mjs`
- Create: `worker/test/cvcs-domain.test.mjs`
- Modify: `worker/src/config.mjs`
- Modify: `worker/test/config.test.mjs`

**Interfaces:**
- Produces `CVCS_PROPERTIES`, `CVCS_RECORD_HEADERS`, `CVCS_BROKEN_PARTS_HEADERS`, `CVCS_OPTION_SHEETS`, `normalizeCvcsRecord`, `cvcsRecordToValues`, `cvcsRecordFromRow`, `getCvcsRecordPage`, `normalizeCvcsBrokenPart`, `cvcsBrokenPartToValues`, `cvcsBrokenPartFromRow`, and `getCvcsBrokenPartsPage`.
- Extends runtime config with optional-at-start but required-for-CVCS `cvcsSheetId`.

- [ ] Write failing domain tests for required fields, default PM, fixed choices, date normalization, custom optional values, exact/fuzzy S/N filtering, keyword filtering, sorting, pagination, blank preservation, broken-parts-only/follow-up-only records, and blue follow-up status.
- [ ] Run `npm.cmd test -- cvcs-domain.test.mjs` and verify failures are due to missing CVCS exports.
- [ ] Implement the minimal domain functions and constants with no SAE/TAE schema coupling.
- [ ] Run the CVCS domain/config tests and then the full Worker suite.
- [ ] Commit the task.

### Task 2: Permission Token Storage and Server Authorization

**Files:**
- Create: `worker/migrations/0003_access_tokens.sql`
- Create: `worker/src/access-tokens.mjs`
- Create: `worker/test/access-tokens.test.mjs`
- Modify: `worker/src/auth.mjs`
- Modify: `worker/src/api.mjs`
- Modify: `worker/test/api.test.mjs`
- Modify: `worker/src/crypto.mjs`

**Interfaces:**
- Produces `PERMISSIONS = { schedule, ae, cvcs, admin }`, token creation/lookup/list/update/revoke helpers, and session claims containing `tokenId`, `permissions`, and `legacy`.
- `/session` accepts `{ token }` while retaining `{ deployId }` compatibility.
- Admin actions: `listAccessTokens`, `createAccessToken`, `updateAccessToken`, `deleteAccessToken`.

- [ ] Write failing tests proving token hashes are stored instead of plaintext, the generated token is returned only at creation, permissions are normalized, suspended/deleted tokens fail, last use updates, ordinary and legacy sessions cannot administer tokens, and route permissions are enforced.
- [ ] Run targeted tests and verify expected failures.
- [ ] Add the D1 migration and token repository using parameterized SQL and SHA-256 base64url hashes.
- [ ] Extend session issuance/validation so fresh protected requests re-check token status; retain the legacy Deploy ID hash path with all non-admin permissions.
- [ ] Add administrator mutation routing and reject privilege escalation.
- [ ] Run targeted and full Worker tests.
- [ ] Commit the task.

### Task 3: Worker CVCS Repository and API Actions

**Files:**
- Modify: `worker/src/repository.mjs`
- Modify: `worker/src/api.mjs`
- Modify: `worker/src/state.mjs`
- Modify: `worker/test/repository.test.mjs`
- Modify: `worker/test/api.test.mjs`
- Modify: `worker/test/state.test.mjs`

**Interfaces:**
- GET actions: `cvcsOptions`, `cvcsRecords`, `cvcsBrokenParts`.
- POST actions: `updateCvcsOptions`, `submitCvcsRecords`, `updateCvcsRecord`, `deleteCvcsRecord`, `bulkUpdateCvcsRecords`, `bulkDeleteCvcsRecords`, `submitCvcsBrokenParts`, `updateCvcsBrokenPart`, `deleteCvcsBrokenPart`, `bulkUpdateCvcsBrokenParts`.
- Uses stable record snapshots and hidden Submission ID columns.

- [ ] Write failing repository/API tests for all actions, permission rejection, server-side filtering/pagination, cache invalidation, shared option lists, paired Reason/Action mapping, stale-row rejection, narrow write locks, idempotent retries, partial chunks, and reconciliation.
- [ ] Run targeted tests and verify the failures.
- [ ] Add CVCS table readers/initializers, hidden identity columns, cache scopes, option-list mutations, record CRUD/bulk operations, and broken-parts/follow-up operations.
- [ ] Integrate CVCS submissions with existing operation/submission status tracking without changing SAE/TAE behavior.
- [ ] Run targeted and full Worker tests plus `npm.cmd run check`.
- [ ] Commit the task.

### Task 4: GAS Fallback Parity and Sheet Bootstrap

**Files:**
- Modify: `D:/Vibe Coding/amrs-gas/code.js`
- Create: `worker/test/gas-parity.test.mjs`
- Create: `scripts/bootstrap-cvcs-sheet.gs`

**Interfaces:**
- GAS accepts the same CVCS action names and payload fields as Worker.
- `bootstrapCvcsSheet()` creates the nine approved visible worksheets, headers, formats, filters, frozen rows, and protected hidden Submission ID columns in the active CVCS spreadsheet.

- [ ] Write a failing static/contract parity test that checks each Worker CVCS action, canonical field, status value, and option sheet exists in GAS and bootstrap source.
- [ ] Run the parity test and verify failure.
- [ ] Implement CVCS reads/writes, pagination, stale checks, idempotency, locking, option updates, and cache invalidation in GAS without exposing Token administration through GAS.
- [ ] Add the idempotent Sheet bootstrap function and ensure reruns preserve existing data.
- [ ] Run GAS syntax checks, parity tests, and full Worker tests.
- [ ] Commit changes in each repository separately with synchronized messages; push both configured remotes.

### Task 5: Client Credential Transport and Permission State

**Files:**
- Modify: `cloud-api.js`
- Modify: `tests/cloud-api.test.mjs`
- Create: `access-control.js`
- Create: `tests/access-control.test.mjs`

**Interfaces:**
- Transport reads a stored personal token first and legacy Deploy ID second.
- `/session` response stores non-sensitive session claims and permissions.
- `AccessControl` exposes `can(permission)`, `isAdmin()`, `setCredential()`, `clearCredential()`, and token administration request helpers.

- [ ] Write failing tests for token-first login, legacy fallback, permission persistence/expiry, 401 sign-out, no plaintext token in logs, and admin helper requests.
- [ ] Run the tests and verify expected failures.
- [ ] Update transport/session storage while preserving GAS fallback URL resolution from the legacy Deploy ID.
- [ ] Implement the standalone access-control module.
- [ ] Run client tests and Worker tests.
- [ ] Commit the task.

### Task 6: CVCS Frontend Module and Navigation

**Files:**
- Create: `cvcs.js`
- Create: `tests/cvcs.test.mjs`
- Modify: `index.html`

**Interfaces:**
- `CvcsApp` owns Property pages, form state, searchable combos, per-Property queues, submission, option editors, record query, broken-parts/follow-up query, CRUD/bulk operations, export configuration, and locally persisted display preferences.
- Existing global navigation calls `CvcsApp.openEntry(property)`, `CvcsApp.openQuery()`, and `CvcsApp.openBrokenParts()`.

- [ ] Write failing unit tests for required/default fields, Property derivation, ranking, complete Reason mapping, custom-value behavior, independent queues, submission IDs, part/follow-up combinations, status colors, exact/fuzzy search parameters, blank row omission, and display preference persistence.
- [ ] Run the client tests and verify expected failures.
- [ ] Implement pure state/domain helpers in `cvcs.js`, then add DOM rendering and API calls using existing AMRS components and progress dialogs.
- [ ] Add the CVCS navigation group, five Property pages, query and broken-parts destinations, responsive cards, editors, selection/bulk tools, and Excel/PDF field selection.
- [ ] Gate all CVCS navigation and actions through `AccessControl.can('cvcs')`.
- [ ] Verify only one navigation item is active and mobile cards do not horizontally scroll.
- [ ] Run client tests and static syntax checks.
- [ ] Commit the task.

### Task 7: Token Management UI and Login Migration

**Files:**
- Create: `token-admin.js`
- Create: `tests/token-admin.test.mjs`
- Modify: `index.html`

**Interfaces:**
- Admin page lists token suffix, label, note, permissions, status, created time, and last-use time.
- Create shows the full token once; edit changes label/note/permissions/status; delete requires confirmation.

- [ ] Write failing tests for one-time display, permission controls, no full-token rendering in lists, ordinary-user hiding, suspended-token sign-out, and legacy credential migration.
- [ ] Run tests and verify expected failures.
- [ ] Change setup copy from Deploy ID to Token while accepting existing saved Deploy IDs automatically.
- [ ] Implement the administrator-only page and actions with clear create/copy acknowledgment.
- [ ] Apply Work Schedule, SAE/TAE, CVCS, and admin visibility rules without leaving direct navigation bypasses.
- [ ] Run all client tests and static checks.
- [ ] Commit the task.

### Task 8: Provisioning, End-to-End Verification, Release, and Deployment

**Files:**
- Modify: `manifest.json`
- Modify: `sw.js`
- Modify: `index.html`
- Modify: `worker/wrangler.jsonc` only if a non-secret binding declaration is required
- Modify: deployment configuration through secret/config commands, never source literals

**Interfaces:**
- One new CVCS Google Sheet is shared with the configured service account and its ID is added to protected Worker/GAS configuration.
- One administrator token is provisioned and displayed once to the user.

- [ ] Create the CVCS Google Sheet and run the bootstrap function; verify all nine visible worksheets, headers, hidden Submission IDs, filters, formatting, and permissions.
- [ ] Apply the D1 migration and verify tables/indexes remotely.
- [ ] Configure `cvcsSheetId` and required secrets without printing them into logs or source.
- [ ] Provision the first administrator token through a backend-only command and present it once through an approved private channel.
- [ ] Run `node --test tests/*.test.mjs`, `npm.cmd test`, `npm.cmd run check`, GAS syntax checks, and final diff inspection.
- [ ] Bump the visible app version and service-worker cache key, then deploy Worker, GAS fallback, and GitHub Pages/PWA through the established release paths.
- [ ] Verify live health, token login, permission rejection, one CVCS submit/reconcile cycle, record query/edit/delete, broken-parts follow-up, exports, legacy Deploy ID compatibility, desktop layout, and phone layout.
- [ ] Commit and push the release; report any physical-device checks not performed.
