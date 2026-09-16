import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function extractFunction(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must remain available`);
  const open = html.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < html.length; index += 1) {
    if (html[index] === '{') depth += 1;
    if (html[index] === '}') depth -= 1;
    if (depth === 0) return html.slice(start, index + 1);
  }
  throw new Error(`${name} has an unclosed body`);
}

function createHarness() {
  const makeElement = (value = '') => {
    const classes = new Set();
    return {
      value,
      checked: false,
      textContent: '',
      style: { display: '' },
      attributes: {},
      classList: {
        add: (...names) => names.forEach(name => classes.add(name)),
        remove: (...names) => names.forEach(name => classes.delete(name)),
        toggle: (name, force) => {
          const enabled = force === undefined ? !classes.has(name) : Boolean(force);
          if (enabled) classes.add(name); else classes.delete(name);
          return enabled;
        },
        contains: name => classes.has(name),
      },
      setAttribute(name, attributeValue) { this.attributes[name] = attributeValue; },
      focus() { this.focused = true; },
    };
  };

  const elements = Object.fromEntries([
    'brokenPartsCheck', 'bpFields', 'itemCode', 'bpQty', 'bpPartDetails',
    'bpRepairDayDate', 'bpRepairDayBtn', 'bpUodUnlockDate', 'bpUodWaitBtn',
    'bpUodActivationHint', 'bpHoldBtn', 'bpRemarkRow', 'bpRemarkBtn', 'bpRemark',
    'date', 'serialNo', 'reason', 'actionDrop',
  ].map(id => [id, makeElement()]));
  Object.assign(elements, {
    itemCode: makeElement('TEST-PART-001'),
    bpQty: makeElement('2'),
    bpUodUnlockDate: makeElement('2026-09-16'),
    bpRemark: makeElement('previous machine note'),
    serialNo: makeElement('1234'),
    reason: makeElement('PM'),
    actionDrop: makeElement('Preventive Maintenance'),
  });
  elements.brokenPartsCheck.checked = true;
  elements.bpFields.style.display = 'block';
  elements.bpPartDetails.style.display = 'grid';
  elements.bpUodWaitBtn.classList.add('active');
  elements.bpHoldBtn.classList.add('active');
  elements.bpRemarkRow.style.display = 'block';
  elements.bpUodActivationHint.style.display = 'block';

  const context = vm.createContext({
    activeCompany: 'SYNTHETIC',
    optionalVisible: false,
    _isMob: false,
    _bpRepairDayMode: 'none',
    _bpUodUnlockMode: 'waiting',
    _bpHoldActive: true,
    _bpRemarkVisible: true,
    queue: [],
    document: {
      getElementById(id) {
        assert.ok(elements[id], `unexpected element lookup: ${id}`);
        return elements[id];
      },
    },
    withQueueContext: item => ({ ...item, company: 'SYNTHETIC' }),
    ensureSubmissionIds: items => items.forEach((item, index) => { item.submissionId ||= `queued-${index}`; }),
    saveQueue() {},
    renderQueue() {},
    scheduleQueueDuplicateCheck() {},
    clearBatchInputs() {},
    updateSnPadDisplay() {},
    _updateRecentReasons() {},
    showToast() {},
    detachPoRepairMode() {},
    switchToDrop() {},
  });

  const functions = [
    'resetBpRepairState',
    'syncBpUodActivationHint',
    '_resetBpFields',
    'doAddToQueue',
    'doAddBatchToQueue',
  ].map(extractFunction).join('\n');
  vm.runInNewContext(functions, context);
  return { context, elements };
}

function queuedItem() {
  return {
    sn: '1234',
    model: 'MODEL-X',
    reason: 'PM',
    action: 'Preventive Maintenance',
    brokenParts: 'TEST-PART-001',
    bpQty: '2',
    bpUodUnlockDay: 'Wait for Unlock',
    bpHoldDate: '2026/09/16',
  };
}

function assertBrokenPartsEntryWasReset(elements, context) {
  assert.equal(elements.brokenPartsCheck.checked, false);
  assert.equal(elements.bpFields.style.display, 'none');
  assert.equal(elements.itemCode.value, '');
  assert.equal(elements.bpQty.value, '');
  assert.equal(elements.bpUodUnlockDate.value, '');
  assert.equal(elements.bpUodWaitBtn.classList.contains('active'), false);
  assert.equal(elements.bpUodWaitBtn.attributes['aria-pressed'], 'false');
  assert.equal(elements.bpUodActivationHint.style.display, 'none');
  assert.equal(elements.bpHoldBtn.classList.contains('active'), false);
  assert.equal(elements.bpHoldBtn.attributes['aria-pressed'], 'false');
  assert.equal(context._bpUodUnlockMode, 'none');
  assert.equal(context._bpHoldActive, false);
}

test('single-record queue addition clears Broken Parts, UOD and Hold inputs after retaining them in the queued record', () => {
  const { context, elements } = createHarness();
  context.doAddToQueue(queuedItem());

  assertBrokenPartsEntryWasReset(elements, context);
  assert.equal(context.queue[0].brokenParts, 'TEST-PART-001');
  assert.equal(context.queue[0].bpUodUnlockDay, 'Wait for Unlock');
  assert.equal(context.queue[0].bpHoldDate, '2026/09/16');
});

test('batch queue addition clears Broken Parts, UOD and Hold inputs after retaining them in each queued record', () => {
  const { context, elements } = createHarness();
  context.doAddBatchToQueue([queuedItem(), { ...queuedItem(), sn: '5678' }]);

  assertBrokenPartsEntryWasReset(elements, context);
  assert.equal(context.queue.length, 2);
  assert.equal(context.queue[0].brokenParts, 'TEST-PART-001');
  assert.equal(context.queue[1].brokenParts, 'TEST-PART-001');
  assert.equal(context.queue[0].bpUodUnlockDay, 'Wait for Unlock');
  assert.equal(context.queue[1].bpHoldDate, '2026/09/16');
});
