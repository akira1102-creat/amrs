# Broken Parts Bulk Edit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add safe multi-select bulk editing to both Broken Parts list surfaces while preserving single-record editing, pagination, export, UOD, and Hold behavior.

**Architecture:** Add a dedicated `bulkUpdateBrokenPartsRecords` mutation to Worker and GAS. Both backends validate selected snapshots before writing complete updated rows. The frontend keeps independent selection maps for the data-entry modal and navigation page, then shares one responsive bulk-edit modal and one submit path.

**Tech Stack:** Static HTML/CSS/JavaScript PWA, Cloudflare Worker JavaScript, Google Sheets API, Google Apps Script, Node test runner, Playwright CLI.

## Global Constraints

- Every editable Broken Parts field except `Serial No.` is eligible for bulk editing.
- Empty controls mean the field is not changed.
- Both Broken Parts list entry points use the same modal and backend contract.
- Worker and GAS fallback behavior must stay synchronized.
- Selected snapshots must be checked before any write; stale rows are rejected.
- No batch-delete control is added.
- Cached frontend changes increment the visible version and service-worker cache identifier.

---

### Task 1: Worker Bulk Mutation

**Files:**
- Modify: `worker/test/repository.test.mjs`
- Modify: `worker/src/repository.mjs`

**Interfaces:**
- Consumes: `brokenPartsRecordFromRow(row, rowNumber)`, `brokenPartsRecordToValues(record)`, `validateHoldDates(record)`.
- Produces: `repository.postAction({ action: "bulkUpdateBrokenPartsRecords", company, records, changes }) -> { success: true, saved }`.

- [ ] **Step 1: Write failing repository tests**

Add tests with literal fixtures that assert:

```js
const result = await repository.postAction({
  action: "bulkUpdateBrokenPartsRecords",
  company: "SCL",
  records: [snapshotRow2, snapshotRow3],
  changes: { bpRepairDay: "2026/08/11", bpRemark: "completed" },
});
assert.equal(result.saved, 2);
assert.equal(sheet.values[1][7], "2026/08/11");
assert.equal(sheet.values[2][9], "completed");
```

Add separate tests proving a stale snapshot produces no write and `serialNo` in `changes` is rejected.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
node --test worker/test/repository.test.mjs
```

Expected: FAIL because `bulkUpdateBrokenPartsRecords` is not routed and returns the normal insertion path or an unknown-action result.

- [ ] **Step 3: Implement the Worker mutation**

Import `brokenPartsRecordFromRow`. Add `bulkUpdateBrokenPartsRecords(payload)` that:

```js
const allowed = [
  "casino", "model", "brokenParts", "bpDesc", "bpColC", "bpQty",
  "bpRepairDay", "date", "bpRemark", "bpUodActivationDate",
  "bpUodUnlockDate", "bpUodUnlockDay", "bpHoldDate", "bpHoldReleaseDate",
];
```

Reject non-empty keys outside this list, canonicalize UOD aliases, reject empty changes and duplicate row numbers, refresh the sheet, compare each current A:N value to the selected snapshot, validate merged hold dates, then send all updated A:N row ranges through one `valuesBatchUpdate` call. Invalidate company caches and return `{ success: true, saved: targets.length }`.

Route the new action from `postAction`.

- [ ] **Step 4: Verify GREEN and full Worker checks**

Run:

```powershell
npm.cmd test
npm.cmd run check
```

Expected: all tests pass and Wrangler dry-run succeeds.

---

### Task 2: GAS Fallback Mutation

**Files:**
- Modify: `D:/Vibe Coding/amrs-gas/code.js`

**Interfaces:**
- Consumes: the same `bulkUpdateBrokenPartsRecords` payload used by Worker.
- Produces: `{ success: true, saved }` or `{ success: false, message }` through `doPost`.

- [ ] **Step 1: Add the GAS action route**

In `doPost`, route `bulkUpdateBrokenPartsRecords` through `withWriteLock`:

```js
if (!Array.isArray(data) && data.action === 'bulkUpdateBrokenPartsRecords') {
  return jsonOut(withWriteLock(function() {
    return bulkUpdateBrokenPartsRecords(data.company, data.records || [], data.changes || {});
  }));
}
```

- [ ] **Step 2: Implement equivalent validation and update behavior**

Read A:N without the Broken Parts cache, reject unsupported keys and duplicate rows, compare every selected snapshot with its current row, normalize the UOD alias, merge and validate all records before writing, update each validated row under the script lock, clear the company Broken Parts cache, and return the saved count.

- [ ] **Step 3: Run GAS syntax validation**

Run:

```powershell
node --check code.js
```

Expected: exit code 0.

---

### Task 3: Shared Frontend Selection and Bulk Modal

**Files:**
- Modify: `index.html`
- Modify: `sw.js`

**Interfaces:**
- Consumes: both `_bpListRecords` and `_bpPageRecords` plus `bulkUpdateBrokenPartsRecords`.
- Produces: `toggleBrokenPartsSelection(scope, index, checked)`, `toggleBrokenPartsPageSelection(scope)`, `openBrokenPartsBulkEdit(scope)`, and `saveBrokenPartsBulkEdit()`.

- [ ] **Step 1: Add toolbar and modal markup**

Add a selection toolbar to both list surfaces with a select-all checkbox, selected count, and disabled `批量修改` button. Add one `bpBulkEditModal` containing CASINO, Model, Parts No., JP/EN names, Qty, Repair Day, Found Day, Remark, UOD Activation Date, UOD Unlock Date, Hold Date, and Hold Release Date. Use the existing waiting buttons for `Waiting` and `Wait for Unlock`.

- [ ] **Step 2: Add independent selection state**

Create two maps keyed by row number:

```js
const _bpListSelectedRecords = new Map();
const _bpPageSelectedRecords = new Map();
```

Render a checkbox on each non-editing card. Select-all affects only cards on the current page. Preserve selection during pagination, but clear it when the user applies a new filter, changes company, or completes an update.

- [ ] **Step 3: Add the shared bulk-edit controller**

Build non-empty `changes`, canonicalizing the UOD input to `bpUodUnlockDate`. Reject an empty change set client-side, confirm the selected count, disable the save button while pending, submit one mutation, and on success clear only the active scope selection and force-refresh its current page. On failure preserve selection and modal values.

- [ ] **Step 4: Add responsive styles**

Use the existing card title/action spacing, 44px minimum touch targets, two columns on desktop, and one column on mobile. Ensure checkboxes, selected counts, and modal buttons do not overflow at 390px width.

- [ ] **Step 5: Increment cached frontend versions**

Update:

```js
const _APP_BUMP = '2026.08.11-04';
const _APP_VERSION = 'v1.064';
const CACHE = 'amrs-v1064';
```

- [ ] **Step 6: Validate inline scripts and static diff**

Extract each inline script body and compile it with `new Function`, run `node --check cloud-api.js`, and run `git diff --check`.

Expected: no syntax or whitespace errors.

---

### Task 4: Rendered Workflow Verification

**Files:**
- Test: live/local rendered `index.html`

**Interfaces:**
- Consumes: completed frontend and synthetic backend responses.
- Produces: evidence that desktop and mobile workflows remain usable.

- [ ] **Step 1: Start a local static server**

Use an available port and load the app with the existing stored authentication/deployment setup or synthetic route interception.

- [ ] **Step 2: Verify desktop behavior**

At a desktop viewport, check both Broken Parts list entry points: select one card, select all current page, open the modal, set at least one field, verify one mutation payload, and verify successful refresh clears selection.

- [ ] **Step 3: Verify mobile behavior**

At approximately 390x844, confirm the toolbar wraps cleanly, card checkboxes remain visible, the modal is one column, date/waiting controls fit, and save remains reachable without horizontal scrolling.

- [ ] **Step 4: Check console and screenshots**

Confirm no page errors or failed local assets. Save screenshots only as temporary verification artifacts and remove them before committing.

---

### Task 5: Release and Live Verification

**Files:**
- Review all modified files.

**Interfaces:**
- Consumes: passing Worker, GAS, static, and rendered checks.
- Produces: deployed Worker/GAS/frontend release.

- [ ] **Step 1: Inspect the scoped diff**

Run `git status --short`, `git diff --stat`, and `git diff --check`. Confirm no unrelated files are included.

- [ ] **Step 2: Deploy Worker and GAS**

Run:

```powershell
npx.cmd wrangler deploy
npx.cmd @google/clasp push
```

Expected: Worker reports a new version ID and clasp reports both GAS files pushed.

- [ ] **Step 3: Commit and push the coherent change**

Commit the implementation and tests with a concise Cantonese message, then push `main`.

- [ ] **Step 4: Verify GitHub Pages and live cache identifiers**

Wait for the Pages workflow for the implementation commit to finish successfully. Fetch cache-busted `index.html` and `sw.js`, confirming `v1.064`, `2026.08.11-04`, and `amrs-v1064` are live.
