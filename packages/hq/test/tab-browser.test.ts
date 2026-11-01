// The phone view over CDP (B.9), against a fake Chrome: the tab stays drivable when another tab in its window is
// in front, and phone input reaches Chrome one message at a time, in order (02/11, Namecheap from the phone).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CdpTabBrowser, type CdpLike } from '../src/tab/browser.ts';
import { until } from './helpers.ts';

function fakeCdp(slow: Record<string, number> = {}) {
  const calls: { method: string; params: any }[] = [];
  let listener: (m: string, p: any) => void = () => {};
  const cdp: CdpLike = {
    send: async (method: string, params: any = {}) => {
      calls.push({ method, params });
      if (slow[method]) await new Promise((r) => setTimeout(r, slow[method]));
      if (method === 'Runtime.evaluate') return { result: { value: String(params.expression).includes('activeElement') ? { editable: true, type: 'text' } : 'https://www.namecheap.com/myaccount/login/' } };
      return {};
    },
    attach: async (_t: string, l: (m: string, p: any) => void) => { listener = l; return 's1'; },
    detach: async () => {},
    pages: async () => [],
    close: () => {},
    onTargetGone: () => {}, onDisconnect: () => {}, onConnect: () => {},
  };
  return { cdp, calls, event: (m: string, p: any) => listener(m, p) };
}

class Phone extends EventEmitter {
  readyState = 1;
  sent: any[] = [];
  send(s: string) { this.sent.push(JSON.parse(s)); }
  close() { this.readyState = 3; this.emit('close'); }
  in(o: object) { this.emit('message', Buffer.from(JSON.stringify(o))); }
}

const size = { w: 360, h: 640, dsf: 2 };
const cb = { onDone() {}, onUrl() {} };

test('phone view: focus emulation keeps the tab drivable behind other tabs, and is removed on release', async () => {
  const f = fakeCdp();
  const b = new CdpTabBrowser('http://unused', () => {}, f.cdp);
  await b.attachPhone('T1', new Phone() as any, size, cb);
  const on = f.calls.findIndex((c) => c.method === 'Emulation.setFocusEmulationEnabled' && c.params.enabled);
  assert.ok(on >= 0, 'focus emulation on');
  assert.ok(on < f.calls.findIndex((c) => c.method === 'Page.startScreencast'), 'before the first frame');

  f.calls.length = 0;
  f.event('Page.screencastVisibilityChanged', { visible: false });
  await until(() => f.calls.some((c) => c.method === 'Emulation.setFocusEmulationEnabled' && c.params.enabled));

  await b.release('T1', 'finished');
  assert.ok(f.calls.some((c) => c.method === 'Emulation.setFocusEmulationEnabled' && c.params.enabled === false), 'given back as it was');
});

test('phone view: input runs in order (text after a tap waits for it), a move after touchEnd is dropped', async () => {
  const f = fakeCdp({ 'Input.dispatchTouchEvent': 30 });
  const b = new CdpTabBrowser('http://unused', () => {}, f.cdp);
  const phone = new Phone();
  await b.attachPhone('T1', phone as any, size, cb);
  f.calls.length = 0;
  phone.in({ t: 'touch', type: 'touchStart', pts: [[100, 120, 1]] });
  phone.in({ t: 'touch', type: 'touchEnd', tap: true });
  phone.in({ t: 'touch', type: 'touchMove', pts: [] });
  phone.in({ t: 'text', s: 'ran' });
  phone.in({ t: 'key', k: 'Backspace' });
  await until(() => f.calls.some((c) => c.method === 'Input.dispatchKeyEvent' && c.params.type === 'keyUp'));
  const input = f.calls.filter((c) => c.method.startsWith('Input.') || (c.method === 'Runtime.evaluate' && String(c.params.expression).includes('activeElement')));
  assert.deepEqual(input.map((c) => c.params.type ?? c.params.text ?? 'focus?'),
    ['touchStart', 'touchEnd', 'focus?', 'ran', 'rawKeyDown', 'keyUp']);
  assert.ok(phone.sent.some((m) => m.t === 'focus' && m.editable), 'the phone heard the field took focus');
});

test('phone view: a slow touch never holds up "סיימתי" or frame acks, and waiting moves collapse to the newest', async () => {
  const f = fakeCdp({ 'Input.dispatchTouchEvent': 200 });
  let done = 0;
  const b = new CdpTabBrowser('http://unused', () => {}, f.cdp);
  const phone = new Phone();
  await b.attachPhone('T1', phone as any, size, { onDone() { done = Date.now(); }, onUrl() {} });
  f.calls.length = 0;
  const t0 = Date.now();
  phone.in({ t: 'touch', type: 'touchStart', pts: [[10, 10, 1]] });
  for (let i = 1; i <= 10; i++) phone.in({ t: 'touch', type: 'touchMove', pts: [[10, 10 + i, 1]] });
  phone.in({ t: 'done' });
  assert.ok(done && done - t0 < 100, '"סיימתי" did not wait for the touches');
  phone.in({ t: 'touch', type: 'touchEnd', tap: false });
  await until(() => f.calls.some((c) => c.method === 'Input.dispatchTouchEvent' && c.params.type === 'touchEnd'), 5000);
  const touches = f.calls.filter((c) => c.method === 'Input.dispatchTouchEvent');
  assert.deepEqual(touches.map((c) => c.params.type), ['touchStart', 'touchMove', 'touchEnd'], 'one move, the newest');
  assert.equal(touches[1]!.params.touchPoints[0].y, 20);
});
