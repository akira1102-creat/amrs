import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { scheduleOverviewFromRows } from '../worker/src/domain.mjs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const sourceBetween = (start, end) => {
  const first = html.indexOf(start), last = html.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `missing source boundary: ${start}`);
  return html.slice(first, last);
};
const context = vm.createContext({
  _scheduleMachineCountsMonth: '2610',
  _scheduleMachineCounts: { 'GEG\u0000Galaxy': 25, 'SCL\u0000Venetian': 30 },
  scheduleMachineCountIsStale: () => false,
});
vm.runInContext([
  sourceBetween('function cleanDashValue(', 'function dashFieldRows('),
  sourceBetween('const SCHEDULE_PEOPLE_ALIASES=', 'function schedulePeopleCompany('),
  sourceBetween('function normalizeScheduleVenue(', 'function applyScheduleMachineCounts('),
  html.match(/function esc\([^\r\n]+/)?.[0],
  sourceBetween('function renderScheduleAssignment(', 'function renderSchedulePeriod('),
].join('\n'), context);

function assignmentFromSheet(am, pm) {
  const headers = Array(20).fill('');
  headers[1] = 'Operator A';
  headers[12] = 'Operator B';
  const row = Array(20).fill('');
  row[0] = '7';
  row[1] = am;
  row[12] = pm;
  return scheduleOverviewFromRows({ from: '2026/10/07', days: 1 }, { '2610': [headers, row] }).days[0].items[0];
}

for (const [alias, venue] of [['GX', 'Galaxy'], ['VML', 'Venetian']]) {
  test(`${alias}* displays a star after its translated venue only in the starred shift`, () => {
    const item = assignmentFromSheet(`${alias}*`, alias);
    for (const showMachineCount of [true, false]) {
      const am = context.renderScheduleAssignment(item, '2026-10-07', 'am', showMachineCount);
      const pm = context.renderScheduleAssignment(item, '2026-10-07', 'pm', showMachineCount);
      assert.ok(am.includes(`<div class="schedule-assignment-title">${venue}*</div>`));
      assert.ok(pm.includes(`<div class="schedule-assignment-title">${venue}</div>`));
      assert.doesNotMatch(am, /class="schedule-machine-count/);
      assert.equal(/class="schedule-machine-count/.test(pm), showMachineCount);
      assert.ok(am.includes(`data-venue="${venue}"`), 'navigation and personnel edits retain the canonical venue');
      assert.ok(pm.includes(`data-venue="${venue}"`));
      assert.equal(item.venue, venue);
    }
  });
}

test('legacy starred titles translate without duplicating the star', () => {
  const card = context.renderScheduleAssignment({
    title: 'GX*', venue: 'GX*', company: 'GEG', linked: true,
    am: [{ name: 'Operator A' }], pm: [],
  }, '2026-10-07', 'am', true);
  assert.match(card, /schedule-assignment-title">Galaxy\*<\/div>/);
  assert.doesNotMatch(card, /Galaxy\*\*|class="schedule-machine-count/);
  assert.match(card, /data-venue="Galaxy"/);
});
