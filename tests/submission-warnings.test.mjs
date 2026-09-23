import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const source = html.slice(html.indexOf('function todaySheetDate()'), html.indexOf('let _poRepairMode='));
const confirmSource = html.slice(html.indexOf('function showSubmitConfirmation('), html.indexOf('async function submitAll()'));
const warning = { company: 'SCL', casino: 'Venetian', model: 'SAE', serialNo: '9001', rowNumber: 2, brokenParts: 'TEST-PART', holding: true, waiting: true, uodWaiting: true, date: '2026/08/02', bpHoldDate: '2026/08/03', bpUodActivationDate: '2026/08/10' };

function setup(overrides = {}) {
  const elements = {
    submitWarningList: { innerHTML: '' },
    submitWarningModal: { classList: new Set() },
    casino: { value: 'Parisian' },
    date: { value: '2026-09-04' },
    poNumber: { value: '2609' },
    confirmInfo: { innerHTML: '' },
    confirmCount: { textContent: '' },
    confirmOkBtn: { disabled: false, textContent: '' },
    confirmModal: { classList: new Set() },
  };
  const context = vm.createContext({
    queue: [{ company: 'SCL', casino: 'Parisian', model: 'SAE', sn: '9001', date: '2026/09/04', action: 'Preventive Maintenance', ...overrides }],
    activeCompany: 'SCL', URLSearchParams,
    getScriptUrl: () => 'https://example.invalid',
    fetchJsonWithTimeout: async () => ({ success: true, warnings: [warning] }),
    _pendingSubmissionWarnings: [], esc: value => String(value),
    _pendingSubmissionRepairs: [],
    document: {
      getElementById: id => elements[id],
      querySelectorAll: () => [{ dataset: { warningIndex: '0' } }, { dataset: { warningIndex: '1' } }, { dataset: { warningIndex: '2' } }],
    },
  });
  vm.runInContext(source, context);
  vm.runInContext(confirmSource, context);
  return { context, elements };
}

test('cross-casino PM uses the maintenance date for every selected status update', async () => {
  const { context, elements } = setup();
  elements.date.value = '2026-09-23';
  const warnings = await context.collectSubmissionWarnings();
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].holding, true);
  assert.equal(warnings[0].waiting, true);
  assert.equal(warnings[0].uodWaiting, true);
  context.openSubmissionWarningModal(warnings);
  assert.equal(elements.submitWarningModal.classList.has('show'), true);
  assert.match(elements.submitWarningList.innerHTML, /Venetian/);
  assert.match(elements.submitWarningList.innerHTML, /Holding/);
  assert.match(elements.submitWarningList.innerHTML, /等待零件/);
  assert.match(elements.submitWarningList.innerHTML, /Found Day：2026\/08\/02/);
  assert.match(elements.submitWarningList.innerHTML, /Hold Date：2026\/08\/03/);
  assert.match(elements.submitWarningList.innerHTML, /UOD Activation Date：2026\/08\/10/);
  assert.match(elements.submitWarningList.innerHTML, /等待解鎖/);
  assert.match(elements.submitWarningList.innerHTML, /Hold Release Date 改為 2026\/09\/04/);
  assert.match(elements.submitWarningList.innerHTML, /Repair Day 改為 2026\/09\/04/);
  const repairs = context.selectedSubmissionRepairs();
  assert.equal(repairs.length, 1);
  assert.equal(repairs[0].record.rowNumber, 2);
  assert.equal(repairs[0].record.serialNo, '9001');
  assert.equal(repairs[0].record.bpRepairDay, '2026/09/04');
  assert.equal(repairs[0].record.bpHoldReleaseDate, '2026/09/04');
  assert.equal(repairs[0].record.bpUodUnlockDay, '2026/09/04');
  assert.equal(Object.hasOwn(repairs[0].record, 'casino'), false);
});

test('explicit status edits suppress only the corresponding cross-casino reminder', async () => {
  for (const [overrides, holding, waiting, uodWaiting] of [
    [{ bpRepairDay: '2026/09/04' }, true, false, true],
    [{ bpHoldReleaseDate: '2026/09/04' }, false, true, true],
    [{ bpUodUnlockDay: '2026/09/04' }, true, true, false],
    [{ bpUodActivationDate: '2026/09/04', bpUodUnlockDay: 'Wait for Unlock' }, true, true, false],
  ]) {
    const { context } = setup(overrides);
    const warnings = await context.collectSubmissionWarnings();
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].holding, holding);
    assert.equal(warnings[0].waiting, waiting);
    assert.equal(warnings[0].uodWaiting, uodWaiting);
  }
});

test('final submission confirmation shows all three source dates and selected Unlock date', async () => {
  const { context, elements } = setup();
  const warnings = await context.collectSubmissionWarnings();
  context.openSubmissionWarningModal(warnings);
  context.showSubmitConfirmation([], warnings);
  assert.match(elements.confirmCount.textContent, /有提示，請確認/);
  context._pendingSubmissionRepairs = context.selectedSubmissionRepairs();
  context.showSubmitConfirmation([], warnings);
  assert.match(elements.confirmInfo.innerHTML, /等待零件（Found Day：2026\/08\/02）/);
  assert.match(elements.confirmInfo.innerHTML, /Holding（Hold Date：2026\/08\/03）/);
  assert.match(elements.confirmInfo.innerHTML, /等待解鎖（UOD Activation Date：2026\/08\/10）/);
  assert.match(elements.confirmInfo.innerHTML, /Hold Release Date 改為 2026\/09\/04/);
  assert.match(elements.confirmInfo.innerHTML, /Repair Day 改為 2026\/09\/04/);
  assert.match(elements.confirmInfo.innerHTML, /UOD Unlock Date 改為 2026\/09\/04/);
});

test('same serial in a different company or model does not receive the warning', async () => {
  for (const overrides of [{ company: 'GEG' }, { model: 'TAE' }, { sn: '9002' }, { bpRepairDay: '2026/09/04', bpHoldReleaseDate: '2026/09/04', bpUodUnlockDay: '2026/09/04' }]) {
    const { context } = setup(overrides);
    assert.equal((await context.collectSubmissionWarnings()).length, 0);
  }
});
