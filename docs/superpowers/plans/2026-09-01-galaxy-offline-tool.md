# Galaxy Offline Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a portable offline Galaxy Log Windows EXE and update AMRS so both sides exchange a five-column CSV with deterministic newer-file replacement.

**Architecture:** Keep the existing AMRS PWA and Worker as the cloud-connected source of truth. Add a self-contained C# WinForms application under a separate `galaxy-log-offline` project that shares the documented CSV contract through duplicated, independently tested parsing logic; the EXE never references cloud code or network APIs. AMRS imports a CSV as a full snapshot only when its file timestamp is newer than the current local snapshot.

**Tech Stack:** Existing vanilla JavaScript PWA, Cloudflare Worker, C# WinForms, .NET self-contained single-file publish, Node test runner, PowerShell packaging checks.

**Spec:** `docs/superpowers/specs/2026-09-01-galaxy-offline-tool-design.md`

## Global Constraints

- CSV columns are exactly `SN, SN末4位, 指定 Log 日期, 取 Log 日期, 狀態`; no 備註 column is exported.
- CSV uses UTF-8 BOM, RFC 4180 quoting, comma delimiter, and CRLF line endings.
- Offline EXE performs no network requests, token access, installation, elevation, or telemetry.
- A newer imported CSV replaces the complete local snapshot; an equal or older CSV never overwrites it.
- No real SN, customer data, credentials, or absolute personal paths may enter fixtures, release output, logs, or documentation.
- Every AMRS frontend asset change bumps `index.html` app version and `sw.js` cache/asset markers together.

---

### Task 1: Lock the shared CSV contract in AMRS

**Files:**
- Modify: `galaxy-log.js` (`tasksToRows`, CSV import/export and snapshot metadata)
- Modify: `tests/galaxy-log.test.mjs` (contract and timestamp replacement tests)

**Interfaces:**
- Produces `tasksToRows(tasks)` with five columns and `tasksToCsv(tasks)` with the exact CSV encoding.
- Produces `mergeImportedSnapshot(state, parsed, fileModifiedAt)` that either replaces all tasks or retains the current snapshot with a reason.

- [ ] **Step 1: Write the failing tests** for five-column output and newer/older file replacement, including a full SN, repeated dates, and a no-log status.
- [ ] **Step 2: Run `node --test tests/galaxy-log.test.mjs --test-name-pattern="CSV|snapshot"` and confirm the new replacement test fails before implementation.
- [ ] **Step 3: Implement the snapshot metadata (`importedFileModifiedAt`, `snapshotSource`) and full-snapshot replacement while preserving existing cloud sync outbox behavior.
- [ ] **Step 4: Run the focused tests and then `node --test tests/*.test.mjs`.
- [ ] **Step 5: Commit the AMRS CSV contract change with `git commit -m "固定 Galaxy 離線 CSV 契約"`.

### Task 2: Update AMRS cloud wording and offline handoff controls

**Files:**
- Modify: `galaxy-log.js` (`shell`, button labels, notices)
- Modify: `tests/index-integration.test.mjs` and `tests/galaxy-log.test.mjs`
- Modify: `index.html`, `sw.js` (version/cache markers)

**Interfaces:**
- UI labels are `下載雲端資料` for the cloud read action and `同步至雲端` for the cloud write action.
- Existing cloud transport actions remain `galaxyLogOverview` and `syncGalaxyLog`; only visible copy changes.

- [ ] **Step 1: Add failing assertions for the exact two labels and updated status messages.
- [ ] **Step 2: Run `node --test tests/index-integration.test.mjs tests/galaxy-log.test.mjs` and confirm the label assertions fail.
- [ ] **Step 3: Change shell, busy, pending, and offline guidance text without changing action IDs or behavior.
- [ ] **Step 4: Bump all frontend markers consistently and run syntax plus integration tests.
- [ ] **Step 5: Commit with `git commit -m "更新 Galaxy 雲端操作文字"`.

### Task 3: Create the offline EXE core and WinForms UI

**Files:**
- Create: `galaxy-log-offline/GalaxyLogOffline.csproj`
- Create: `galaxy-log-offline/Program.cs`
- Create: `galaxy-log-offline/CsvContract.cs`
- Create: `galaxy-log-offline/MainForm.cs`
- Create: `galaxy-log-offline/MainForm.Designer.cs`
- Create: `galaxy-log-offline/README.txt`
- Create: `galaxy-log-offline/tests/CsvContractTests.cs`

**Interfaces:**
- `CsvContract.Parse(string content)` returns a snapshot containing ordered `GalaxyTask` records and source timestamp metadata.
- `CsvContract.Serialize(IReadOnlyList<GalaxyTask> tasks)` returns UTF-8 BOM CSV with the five exact columns.
- `CsvContract.ReplaceIfNewer(LocalSnapshot current, ImportedSnapshot incoming)` returns the chosen complete snapshot and a user-facing decision message.
- `MainForm` exposes Import CSV, Export CSV, search, status filter, complete, no-log, reopen, and summary controls without any cloud controls.

- [ ] **Step 1: Write synthetic C# tests for BOM/quoted CSV parsing, full SN plus末4位, duplicate SN dates, status transitions, and newer/older replacement.
- [ ] **Step 2: Run the tests and confirm the replacement and no-log date cases fail before implementation.
- [ ] **Step 3: Implement the pure CSV contract with invariant date normalization, stable row identity, `YYYY-MM-DD` completion dates, and `YYYY-MM-DD 已檢查無log` serialization.
- [ ] **Step 4: Implement the dark AMRS-style WinForms layout and event handlers using only local file dialogs and in-memory state.
- [ ] **Step 5: Add explicit no-network boundaries: no `HttpClient`, no cloud URLs, no token fields, and no background network work.
- [ ] **Step 6: Run the C# tests and manually exercise import, search, mark, reopen, and export with synthetic CSV.

### Task 4: Package and verify the portable EXE

**Files:**
- Create: `galaxy-log-offline/build-release.ps1`
- Create: `galaxy-log-offline/release/.gitkeep` (release directory only; generated EXE remains ignored until release handoff)
- Modify: `galaxy-log-offline/README.txt`

**Interfaces:**
- Build command: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\build-release.ps1` from `galaxy-log-offline`.
- Output: versioned `GalaxyLogOffline_vX.Y.Z.exe`, self-contained Windows x64, single file, no console window.

- [ ] **Step 1: Add packaging checks for self-contained publish, no-console output, and exclusion of fixtures, secrets, and absolute paths.
- [ ] **Step 2: Run the packaging checks before publishing and confirm they fail until the project is configured.
- [ ] **Step 3: Publish the EXE and copy only the executable plus README into the release folder.
- [ ] **Step 4: Launch the packaged EXE with networking disabled, import/export a synthetic CSV, and verify no network process/request is created.
- [ ] **Step 5: Inspect the release folder and run `git diff --check`; commit with `git commit -m "製作 Galaxy 完全離線工具"`.

### Task 5: End-to-end handoff verification and production release

**Files:**
- Test: `tests/galaxy-log.test.mjs`, `tests/index-integration.test.mjs`, `galaxy-log-offline/tests/CsvContractTests.cs`
- Verify: `index.html`, `sw.js`, `galaxy-log-offline/release/`

- [ ] **Step 1: Run AMRS JavaScript syntax and full tests.
- [ ] **Step 2: Run offline EXE unit tests and packaged launch checks.
- [ ] **Step 3: Inspect the final scoped diff and confirm no unrelated files or sensitive data are included.
- [ ] **Step 4: Push the AMRS repository and deploy only the Worker if its code changed.
- [ ] **Step 5: Verify live AMRS HTML, Galaxy JS, Service Worker version, and release artifact name; report any physical Surface behavior that cannot be simulated.
