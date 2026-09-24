import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { scheduleOverviewFromRows } from '../worker/src/domain.mjs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const dateSource = html.slice(html.indexOf('function scheduleLocalIso('), html.indexOf('function scheduleMachineCountIsStale('));
const visibleSource = html.slice(html.indexOf('function scheduleDateObject('), html.indexOf('function syncScheduleVenueFilterOptions('));
const renderSource = html.slice(html.indexOf('function scheduleFocusDay('), html.indexOf('async function loadSelectedScheduleMonth('));

test('Public Holiday assignments and remarks disappear from focus and date lists', () => {
  const headers = Array(20).fill('');
  headers[0] = 'Day';
  headers[1] = 'Operator A';
  headers[10] = 'Remark';
  headers[12] = 'Operator B';
  headers[19] = 'Remark';
  const row = (day, am = '', remark = '', pm = '') => {
    const cells = Array(20).fill('');
    cells[0] = day;
    cells[1] = am;
    cells[10] = remark;
    cells[12] = pm;
    return cells;
  };
  const rows = [
    row('24', 'Public Holiday', '', 'Public Holiday'),
    row('25', '', 'PUBLIC HOLIDAY'),
    row('28', 'Training', '', 'Training'),
    row('29', 'Office', '', 'Office'),
  ];
  const overview = scheduleOverviewFromRows({ from: '2026/09/24', days: 6 }, { '2609': [headers, ...rows] });
  const elements = new Map();
  const element = key => {
    if (!elements.has(key)) elements.set(key, { textContent: '', innerHTML: '' });
    return elements.get(key);
  };
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [2026, 8, 24, 10])); }
    static now() { return new Date(2026, 8, 24, 10).getTime(); }
  }
  const context = vm.createContext({
    Date: FixedDate,
    document: { getElementById: element, querySelector: element },
    _scheduleTodayData: overview,
    _scheduleWeekDays: overview.days,
    _scheduleMachineCountsMonth: '2609',
    SCHEDULE_INITIAL_DAYS: 8,
    normalizeScheduleVenue: (_company, venue) => venue,
    hydrateScheduleMachineCountsFromCache: () => {},
    loadScheduleVisibleMachineCounts: async () => {},
    renderScheduleItems: items => items.map(item => item.title).join(', '),
  });
  vm.runInContext(`${dateSource}\n${visibleSource}\n${renderSource}`, context);

  assert.deepEqual(Array.from(context.scheduleVisibleDays(overview.days), day => day.date), ['2026-09-28', '2026-09-29']);
  context.renderScheduleFocus();
  context.renderScheduleWeek();
  assert.equal(element('scheduleFocusLabel').textContent, '下一個工作日');
  assert.equal(element('scheduleFocusDate').textContent, '9月28日 星期一');
  assert.match(element('scheduleTimeline').innerHTML, /9月29日 星期二/);
  assert.doesNotMatch(element('scheduleTimeline').innerHTML, /9月24日|9月25日|9月28日/);

  vm.runInContext("_scheduleSelectedMonth='2026-09'", context);
  context.renderScheduleWeek();
  assert.match(element('scheduleTimeline').innerHTML, /9月28日 星期一/);
  assert.match(element('scheduleTimeline').innerHTML, /9月29日 星期二/);
  assert.doesNotMatch(element('scheduleTimeline').innerHTML, /9月24日|9月25日/);
});
