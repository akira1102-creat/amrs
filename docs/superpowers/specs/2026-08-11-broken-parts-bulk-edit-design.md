# Broken Parts Bulk Edit Design

## Goal

Add the same select-and-bulk-edit workflow used by the maintenance-record search page to both Broken Parts list surfaces:

- the Broken Parts list opened from a company data-entry page;
- the Broken Parts list opened from the left navigation.

Users can update any editable field except `Serial No.`. An empty control means that field is not changed.

## Approaches Considered

### 1. Submit one full-row update per selected card

This reuses the existing single-record endpoint, but it can overwrite a colleague's newer Sheet edit with stale values from the browser and produces multiple requests.

### 2. Reuse the maintenance-record bulk endpoint

This gives a familiar API shape, but the main maintenance table and Broken Parts table have different schemas, identities, statuses, and validation rules. Extending one endpoint across both tables would make its contract ambiguous.

### 3. Add a dedicated Broken Parts bulk endpoint

This is the selected approach. One request carries the selected record snapshots and only the non-empty changes. The backend verifies every target before making one batch write. Worker and GAS fallback implement the same contract.

## User Interface

Each non-editing Broken Parts card gains a selection checkbox. Both list toolbars gain:

- a current-page select-all checkbox;
- an `已選 N 筆` count;
- a `批量修改` button disabled when nothing is selected.

Selection remains while moving between pages of the same company and filter result. It is cleared when the company changes, the user applies a new filter, or an update succeeds. The two list surfaces keep separate selections so opening the data-entry modal cannot accidentally modify selections made on the navigation page.

The bulk editor uses the existing modal style and responsive two-column/one-column grid. It includes every editable field except `Serial No.`:

- CASINO;
- Model;
- Parts No.;
- Required Parts (JP);
- Required Parts (EN);
- Qty;
- Repair Day;
- Found Day;
- Remark;
- UOD Activation Date;
- UOD Unlock Date;
- Hold Date;
- Hold Release Date.

Blank means `不更改`. Date inputs use the existing date picker. Repair Day supports `Waiting`; UOD Unlock Date supports `Wait for Unlock`. The user must provide at least one change before submission.

The modal shows the number of selected records and asks for one confirmation before applying the update. Batch deletion is not added because the request is specifically for batch modification and deletion is materially more destructive.

## Data Contract

The frontend posts:

```json
{
  "action": "bulkUpdateBrokenPartsRecords",
  "company": "SYNTHETIC_COMPANY",
  "records": [{ "rowNumber": 2, "serialNo": "1001" }],
  "changes": { "bpRepairDay": "2026/08/11" }
}
```

`records` contains the complete selected snapshots already loaded by the page. `changes` contains only non-empty values. The UOD alias is normalized to the canonical `bpUodUnlockDate` storage column while response records continue exposing both legacy aliases for compatibility.

## Backend Safety

Worker and GAS fallback both:

1. validate the company, selected records, row numbers, allowed fields, dates, and hold-date ordering;
2. refresh the Broken Parts sheet rather than trusting a cached copy;
3. verify each row still matches the selected snapshot before any write;
4. reject duplicate or missing row targets;
5. prepare all changed cells and write them as one batch operation;
6. invalidate Broken Parts and related company caches;
7. return the number of saved records.

No partial write occurs when validation or stale-record checking fails before the batch request.

## Error Handling

- No selected records: keep the button disabled.
- No non-empty changes: show `請至少選擇一項修改`.
- A row changed in Sheet: show `記錄已被修改，請重新載入` and reload the current list.
- Backend or connection failure: keep the selection and modal values so the user can retry deliberately.
- Success: close the modal, clear that surface's selection, force-refresh the current page, and show the saved count.

## Verification

Automated tests cover:

- allowed fields update all selected rows;
- `Serial No.` and unknown fields are rejected;
- empty changes are rejected;
- duplicate targets are rejected;
- stale rows cause no write;
- UOD waiting/date aliases write the correct column;
- Worker and GAS source pass syntax checks.

Rendered checks cover both list entry points on desktop and phone widths, including select-all, cross-page selection count, modal layout, waiting controls, successful refresh, and disabled state with no selection.

Cached frontend assets require the visible app version and service-worker cache identifier to be incremented.
