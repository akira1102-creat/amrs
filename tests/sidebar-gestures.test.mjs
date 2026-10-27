import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const source = html.slice(html.indexOf('function openMenu()'), html.indexOf('let _accessPermissions='));

function harness({ width = 390, mobile = true, locked = false } = {}) {
  const listeners = new Map();
  const element = (options = {}) => ({
    parentElement: null, scrollWidth: 100, clientWidth: 100,
    closest: () => options.interactive ? {} : null,
    classList: new Set(), ...options,
  });
  const menu = element();
  const overlay = element();
  for (const node of [menu, overlay]) {
    node.classList.contains = name => node.classList.has(name);
    node.classList.remove = name => node.classList.delete(name);
  }
  menu.contains = target => target === menu;
  const document = {
    documentElement: { classList: { contains: () => false }, clientWidth: width },
    body: { classList: { contains: name => name === 'auth-locked' && locked } },
    getElementById: id => id === 'sideMenu' ? menu : overlay,
    addEventListener: (type, handler) => listeners.set(type, handler),
  };
  vm.runInNewContext(source, {
    document,
    window: { innerWidth: width, matchMedia: () => ({ matches: mobile }), getComputedStyle: node => ({ overflowX: node.overflowX || 'visible' }) },
    renderCompanyMenu() {},
  });
  function emit(type, x, y, target = element(), count = 1) {
    let prevented = false;
    const point = { clientX: x, clientY: y };
    listeners.get(type)({ target, touches: Array.from({ length: count }, () => point), changedTouches: [point], preventDefault() { prevented = true; } });
    return prevented;
  }
  function swipe(x, y, dx, dy, target = element()) {
    emit('touchstart', x, y, target);
    const prevented = emit('touchmove', x + dx, y + dy, target);
    emit('touchend', x + dx, y + dy, target);
    return prevented;
  }
  return { menu, overlay, element, emit, swipe, opened: () => menu.classList.has('show') && overlay.classList.has('show') };
}

test('right swipe from left half, including the centre boundary, opens both menu and overlay', () => {
  for (const x of [10, 100, 190, 195]) {
    const app = harness();
    assert.equal(app.swipe(x, 200, 90, 5), true);
    assert.equal(app.opened(), true, `start x=${x}`);
  }
});

test('right half, desktop and locked login screen do not open the sidebar', () => {
  for (const [options, x] of [[{}, 196], [{ mobile: false }, 10], [{ locked: true }, 10]]) {
    const app = harness(options);
    assert.equal(app.swipe(x, 200, 90, 5), false);
    assert.equal(app.opened(), false);
  }
});

test('vertical scroll, short drags and wrong-direction swipes leave navigation alone', () => {
  for (const [dx, dy] of [[10, 100], [35, 0], [-90, 0]]) {
    const app = harness();
    app.swipe(100, 200, dx, dy);
    assert.equal(app.opened(), false);
  }
});

test('editing controls and horizontally scrolling tables keep their gestures', () => {
  const app = harness();
  for (const target of [
    app.element({ interactive: true }),
    app.element({ scrollWidth: 700, clientWidth: 300, overflowX: 'auto' }),
    app.element({ parentElement: app.element({ scrollWidth: 700, clientWidth: 300, overflowX: 'scroll' }) }),
  ]) {
    assert.equal(app.swipe(10, 200, 90, 5, target), false);
    assert.equal(app.opened(), false);
  }
});

test('cancelled and multi-touch gestures cannot open or revive a stale swipe', () => {
  const app = harness();
  app.emit('touchstart', 100, 200);
  app.emit('touchmove', 190, 205);
  app.emit('touchcancel', 190, 205);
  app.emit('touchend', 190, 205);
  assert.equal(app.opened(), false);
  app.emit('touchstart', 10, 200, undefined, 2);
  app.emit('touchmove', 190, 205);
  app.emit('touchend', 190, 205);
  assert.equal(app.opened(), false);
  app.emit('touchstart', 10, 200);
  app.emit('touchmove', 190, 205, undefined, 2);
  app.emit('touchend', 190, 205);
  assert.equal(app.opened(), false);
});

test('left swipe inside open sidebar still closes menu and overlay', () => {
  const app = harness();
  app.swipe(10, 200, 90, 5);
  assert.equal(app.opened(), true);
  app.swipe(240, 200, -100, 0, app.menu);
  assert.equal(app.opened(), false);
});
