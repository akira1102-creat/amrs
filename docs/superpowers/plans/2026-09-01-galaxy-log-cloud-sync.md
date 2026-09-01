# Galaxy Log Cloud Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with verification checkpoints.

**Goal:** Make Galaxy Log use the user-provided Google Sheet as its cloud source while preserving offline local work and automatic cloud upload for online Excel/CSV imports.

**Architecture:** The browser keeps a normalized Galaxy task snapshot plus an idempotent mutation outbox in localStorage. The existing authenticated AMRS Worker reads and upserts a dedicated `Galaxy Log` worksheet in the configured Galaxy spreadsheet, so Google credentials never reach the PWA. The frontend reads cloud data when online, renders the local snapshot when offline, immediately syncs queued Excel/CSV imports when online, and lets field changes wait for the Sync action.

**Tech Stack:** Static HTML/CSS/JavaScript PWA, localStorage, existing `createDualTransport`, Cloudflare Worker ESM repository/API, Google Sheets API wrapper, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-01-galaxy-log-cloud-sync-design.md`

## Global Constraints

- Use the existing AMRS Worker session and AE permission; do not add browser Google credentials.
- Keep the supplied spreadsheet ID in protected Worker configuration, never in frontend source, localStorage, logs, tests, or exports.
- Support any number of repeated three-column groups: SN last four, target log date, completed log date.
- Keep Excel/CSV import and export behavior working.
- Offline completion and reopening must update the UI immediately and remain queued until Sync succeeds.
- Stable task IDs must include the source group position so identical SN/date pairs in different groups remain separate.
- Conflicts are surfaced and not silently overwritten.
- Every production asset change must bump `index.html` app bump/query markers and `sw.js` cache marker before pushing.

## File Map

- Modify `galaxy-log.js`: task normalization, three-column cloud parsing/serialization, local outbox, cloud fetch/sync actions, status UI, and sync event handling.
- Modify `galaxy-log.css`: sync button, cloud/offline/conflict indicators, and responsive status styling.
- Modify `index.html`: pass the existing dual transport into Galaxy Log and bump release asset versions after implementation.
- Modify `worker/src/config.mjs`: read an optional protected Galaxy spreadsheet ID from runtime configuration without exposing its value.
- Modify `worker/src/repository.mjs`: read/normalize the `Galaxy Log` tab and upsert sync mutations under a write lock.
- Modify `worker/src/api.mjs`: classify and route `galaxyLogOverview` and `syncGalaxyLog` actions.
- Modify `worker/test/config.test.mjs`: cover Galaxy spreadsheet configuration validation.
- Modify `worker/test/repository.test.mjs`: cover three-column read, idempotent upsert, and conflict results using synthetic sheets.
- Modify `worker/test/api.test.mjs`: cover action permission/routing and mutation lock behavior.
- Modify `tests/galaxy-log.test.mjs`: cover group parsing, outbox transitions, cloud merge, and conflict preservation.
- Modify `tests/index-integration.test.mjs`: cover transport injection and sync button wiring.
- Modify `docs/superpowers/specs/2026-09-01-galaxy-log-cloud-sync-design.md`: correct any wording discovered during implementation if needed.

---

### Task 1: Add failing pure-function tests for three-column cloud data and outbox behavior

**Files:**
- Modify: `tests/galaxy-log.test.mjs`
- Modify: `tests/index-integration.test.mjs`

**Interfaces:**
- `parseGalaxyColumnGroups(rows, options) -> { tasks, issues }`
- `tasksToColumnGroups(tasks) -> string[][]`
- `createMutationOutbox(state, mutation) -> normalizedState`
- `mergeCloudTasks(localTasks, cloudTasks, outbox) -> { tasks, conflicts }`
- `pendingMutations(state) -> mutation[]`

- [ ] **Step 1: Write the failing tests**

  Add tests that pass a six-column matrix with two repeated groups and assert two stable tasks, including group positions in IDs. Add a test that serializes two tasks back to six columns with the completed date in the third/sixth cells. Add tests that completion creates one outbox mutation, repeated completion does not duplicate the same mutation, and a cloud completion is retained while a local pending task is merged. Add a test that a different local/cloud completed date returns one conflict and keeps the outbox mutation. Add an integration assertion that `ensureGalaxyLogApp()` supplies the existing dual transport.

- [ ] **Step 2: Run tests and verify the expected RED state**

  Run `npm test -- tests/galaxy-log.test.mjs tests/index-integration.test.mjs` from `D:\Vibe Coding\amrs`. Expected failure: the new exported helpers and transport option do not exist yet.

### Task 2: Implement pure parsing, serialization, normalized state, and outbox helpers

**Files:**
- Modify: `galaxy-log.js`

**Interfaces:**
- Export the four helpers named in Task 1.
- Extend normalized state with `cloudTasks`, `outbox`, `lastCloudSyncAt`, `lastCloudError`, and `conflicts` while accepting old `_amrs_galaxy_log_v1` values.

- [ ] **Step 1: Implement the smallest parser/serializer for repeated groups**

  Parse every three cells from row 1 onward, normalize the serial to its last four digits, normalize both dates, skip a completely empty group, and emit an issue for a non-empty group without a serial or valid target date. Serialize tasks sorted by their stored group position into rows with headers `SN末4位`, `指定 Log 日期`, `取 Log 日期`, repeating triples.

- [ ] **Step 2: Implement idempotent outbox helpers and cloud merge**

  Give each mutation a deterministic key composed of task ID plus changed field values. Replace an existing queued mutation for the same task/action instead of appending duplicates. Merge cloud tasks by stable task ID; preserve local pending mutations, retain cloud completion when local has no conflicting completion, and return explicit conflicts for differing non-empty completion dates.

- [ ] **Step 3: Run the focused tests and verify GREEN**

  Run `npm test -- tests/galaxy-log.test.mjs tests/index-integration.test.mjs`; all new helper tests and the existing Galaxy tests must pass.

### Task 3: Add Worker configuration, repository read, and sync upsert

**Files:**
- Modify: `worker/src/config.mjs`
- Modify: `worker/src/repository.mjs`
- Modify: `worker/test/config.test.mjs`
- Modify: `worker/test/repository.test.mjs`

**Interfaces:**
- Runtime config exposes `galaxyLogSheetId` from `parsed.galaxyLogSheetId` or `env.GALAXY_LOG_SHEET_ID`; missing value returns a clear server configuration error only when a Galaxy action is called.
- Repository exposes `getGalaxyLogOverview()` and `syncGalaxyLog(payload)` through `getAction`/`postAction`.

- [ ] **Step 1: Write failing Worker tests**

  Extend the synthetic config with `galaxyLogSheetId: "galaxy-log"`. Add a repository test whose sheet contains `A1:F3` repeated groups and assert overview returns two normalized tasks. Add a sync test that upserts a completed date, repeats the same mutation idempotently, and returns `conflict` when the synthetic cloud row has a different non-empty completed date. Add a config test for env override and a missing-config error at action time.

- [ ] **Step 2: Run the focused Worker tests and verify RED**

  Run `npm test -- --test-name-pattern="Galaxy|galaxy"` in `D:\Vibe Coding\amrs\worker`. Expected failure: the config property and repository actions are not implemented.

- [ ] **Step 3: Implement configuration and sheet helpers**

  Add a protected `galaxyLogSheetId` value, a fixed `GALAXY_LOG_SHEET = "Galaxy Log"` tab name, parsing of the supplied A-C/D-F layout, stable task IDs based on group position, and a normalized read response. Use `ensureSheet` with `create: true` only for the dedicated tab.

- [ ] **Step 4: Implement locked idempotent upsert**

  For `syncGalaxyLog`, read the current tab inside the existing repository write path, apply only valid task mutations keyed by Task ID, return per-mutation `applied`/`conflict`/`failed`, write the normalized three-column matrix with `USER_ENTERED`, invalidate the dedicated cache, and return the resulting server timestamp. Do not touch company maintenance worksheets.

- [ ] **Step 5: Run focused Worker tests and verify GREEN**

  Run `npm test -- --test-name-pattern="Galaxy|galaxy"`; then run the complete Worker test suite `npm test` in `worker`.

### Task 4: Route the Worker API actions and add frontend cloud transport

**Files:**
- Modify: `worker/src/api.mjs`
- Modify: `worker/test/api.test.mjs`
- Modify: `galaxy-log.js`
- Modify: `index.html`
- Modify: `tests/index-integration.test.mjs`

**Interfaces:**
- GET `action=galaxyLogOverview` returns `{ tasks, issues, serverUpdatedAt }`.
- POST `{ action: "syncGalaxyLog", mutations: [...] }` returns per-mutation results plus `tasks`/`serverUpdatedAt`.
- `createApplication({ transport })` uses `transport.get`/`transport.post` when available and falls back to local-only mode when absent.

- [ ] **Step 1: Write failing API and UI tests**

  Assert `permissionForAction("galaxyLogOverview")` and `permissionForAction("syncGalaxyLog")` are `ae`, route GET/POST to repository methods, acquire a Galaxy write lock for sync, and render a Sync button whose disabled state follows `navigator.onLine` and busy state. Assert `ensureGalaxyLogApp()` passes `_dualTransport`.

- [ ] **Step 2: Run API/UI tests and verify RED**

  Run `npm test -- tests/index-integration.test.mjs` and `npm test -- --test-name-pattern="Galaxy"` in `worker`; expected failures identify missing routes and transport wiring.

- [ ] **Step 3: Implement API routing and frontend transport calls**

  Add the two actions to the existing GET/POST dispatch without changing auth behavior. In the frontend, load overview automatically once per mount when online, display cloud/local status, enqueue local changes first, and make the Sync button send only pending mutations. On successful sync, merge the returned cloud snapshot and clear only applied mutations; leave failures and conflicts visible.

- [ ] **Step 4: Run focused tests and verify GREEN**

  Run the root Galaxy/integration tests and Worker Galaxy/API tests; then run complete root and Worker suites.

### Task 5: Style, release-version, and end-to-end verification

**Files:**
- Modify: `galaxy-log.css`
- Modify: `index.html`
- Modify: `sw.js`
- Modify: `.github/workflows/deploy.yml` only if a new asset is introduced (no new asset is expected).

- [ ] **Step 1: Add responsive cloud/offline/conflict styling**

  Style the Sync button, pending count, last-sync timestamp, offline badge, and conflict notice without changing the established mobile card layout.

- [ ] **Step 2: Run static checks and all automated tests**

  Run `node --check galaxy-log.js`, `node --check worker/src/config.mjs`, `node --check worker/src/repository.mjs`, `node --check worker/src/api.mjs`, `npm test` in the root, `npm test` in `worker`, and `git diff --check`.

- [ ] **Step 3: Verify real browser behavior**

  Use a sanitized local fixture to confirm online overview, offline rendering, completion queueing, reconnection, sync success, and conflict display in a desktop and narrow viewport. Confirm no Google credential or supplied spreadsheet URL appears in frontend source or localStorage.

- [ ] **Step 4: Bump release markers and inspect the final diff**

  Increment the Service Worker cache name and update the `index.html` app bump and asset query version together, then inspect `git diff --stat` and the full scoped diff for unrelated edits.

- [ ] **Step 5: Commit and push the coherent change**

  Create one Cantonese commit such as `新增 Galaxy Log 雲端同步`, push `main`, and verify the deployed static assets plus authenticated Worker endpoint separately. Report any production configuration value that still needs to be set without exposing it.
