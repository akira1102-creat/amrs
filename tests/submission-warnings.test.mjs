import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const source = html.slice(html.indexOf('function todaySheetDate()'), html.indexOf('let _poRepairMode='));
const warning = { company: 'SCL', casino: 'Venetian', model: 'SAE', serialNo: '9001', rowNumber: 2, brokenParts: 'TEST-PART', holding: true, waiting: true };

function setup(overrides = {}) {
  const elements = {
    submitWarningList: { innerHTML: '' },
    submitWarningModal: { classList: new Set() },
  };
  const context = vm.createContext({
    queue: [{ company: 'SCL', casino: 'Parisian', model: 'SAE', sn: '9001', action: 'Preventive Maintenance', ...overrides }],
    activeCompany: 'SCL', URLSearchParams,
    getScriptUrl: () => 'https://example.invalid',
    fetchJsonWithTimeout: async () => ({ success: true, warnings: [warning] }),
    _pendingSubmissionWarnings: [], esc: value => String(value),
    document: {
      getElementById: id => elements[id],
      querySelectorAll: () => [{ dataset: { warningIndex: '0' } }, { dataset: { warningIndex: '1' } }],
    },
  });
  vm.runInContext(source, context);
  return { context, elements };
}

test('cross-casino PM shows both warnings and selected actions retain original row identity', async () => {
  const { context, elements } = setup();
  const warnings = await context.collectSubmissionWarnings();
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].holding, true);
  assert.equal(warnings[0].waiting, true);
  context.openSubmissionWarningModal(warnings);
  assert.equal(elements.submitWarningModal.classList.has('show'), true);
  assert.match(elements.submitWarningList.innerHTML, /Venetian/);
  assert.match(elements.submitWarningList.innerHTML, /Holding/);
  assert.match(elements.submitWarningList.innerHTML, /等待零件/);
  const repairs = context.selectedSubmissionRepairs();
  assert.equal(repairs.length, 1);
  assert.equal(repairs[0].record.rowNumber, 2);
  assert.equal(repairs[0].record.serialNo, '9001');
  assert.equal(repairs[0].record.bpRepairDay, context.todaySheetDate());
  assert.equal(repairs[0].record.bpHoldReleaseDate, context.todaySheetDate());
  assert.equal(Object.hasOwn(repairs[0].record, 'casino'), false);
});

test('explicit status edits suppress only the corresponding cross-casino reminder', async () => {
  for (const [overrides, holding, waiting] of [
    [{ bpRepairDay: '2026/09/04' }, true, false],
    [{ bpHoldReleaseDate: '2026/09/04' }, false, true],
  ]) {
    const { context } = setup(overrides);
    const warnings = await context.collectSubmissionWarnings();
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].holding, holding);
    assert.equal(warnings[0].waiting, waiting);
  }
});

test('same serial in a different company or model does not receive the warning', async () => {
  for (const overrides of [{ company: 'GEG' }, { model: 'TAE' }, { sn: '9002' }, { bpRepairDay: '2026/09/04', bpHoldReleaseDate: '2026/09/04' }]) {
    const { context } = setup(overrides);
    assert.equal((await context.collectSubmissionWarnings()).length, 0);
  }
});
