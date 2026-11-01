// The phone view over CDP (B.9), against a fake Chrome: the tab stays drivable when another tab in its window is
// in front, and phone input reaches Chrome one message at a time, in order (02/11, Namecheap from the phone).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CdpTabBrowser, FORM_JS, type CdpLike } from '../src/tab/browser.ts';
import { until } from './helpers.ts';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

test('phone form: the page\'s fields reach the phone on attach; submit types each changed field, then taps the button', async () => {
  const form = { fields: [{ k: '1', type: 'text', label: 'Username' }, { k: '2', type: 'password', label: 'Password' }], buttons: [{ k: '3', label: 'Sign in', primary: true }] };
  const f = fakeCdp();
  const send = f.cdp.send;
  f.cdp.send = async (method: string, params: any = {}) => {
    if (method === 'Runtime.evaluate' && String(params.expression).includes('window.__hqk')) { f.calls.push({ method: 'scan', params }); return { result: { value: form } }; }
    if (method === 'Runtime.evaluate' && String(params.expression).includes('getBoundingClientRect')) { f.calls.push({ method: 'rect', params }); return { result: { value: { x: 50, y: 60 } } }; }
    if (method === 'Runtime.evaluate' && String(params.expression).includes('e.select')) { f.calls.push({ method: 'focus', params }); return { result: { value: 'text' } }; }
    return send(method, params);
  };
  const b = new CdpTabBrowser('http://unused', () => {}, f.cdp);
  const phone = new Phone();
  await b.attachPhone('T1', phone as any, size, cb);
  const got = phone.sent.find((m) => m.t === 'form');
  assert.deepEqual(got?.fields.map((x: any) => x.label), ['Username', 'Password']);

  f.calls.length = 0;
  phone.in({ t: 'submit', values: { '1': 'ran', '2': '' }, button: '3' });
  await until(() => f.calls.some((c) => c.method === 'Input.dispatchTouchEvent' && c.params.type === 'touchEnd'));
  const seq = f.calls.filter((c) => ['focus', 'Input.insertText', 'Input.dispatchKeyEvent', 'rect', 'Input.dispatchTouchEvent'].includes(c.method))
    .map((c) => c.method === 'Input.insertText' ? `type:${c.params.text}` : c.method === 'Input.dispatchKeyEvent' ? `key:${c.params.key}:${c.params.type}`
      : c.method === 'Input.dispatchTouchEvent' ? `${c.params.type}${c.params.touchPoints[0] ? `@${c.params.touchPoints[0].x},${c.params.touchPoints[0].y}` : ''}` : c.method);
  assert.deepEqual(seq, ['focus', 'type:ran', 'focus', 'key:Backspace:rawKeyDown', 'key:Backspace:keyUp', 'rect', 'touchStart@50,60', 'touchEnd']);
  assert.ok(f.calls.every((c) => !String(c.params.expression ?? '').includes('ran')), 'the value goes in as typing, never inside page code');
});

test('phone form: FORM_JS is valid JavaScript', () => {
  new Function(`return ${FORM_JS}`);
});

test('phone form: a field gone from the page means no button press, and the phone is told', async () => {
  const f = fakeCdp();
  const send = f.cdp.send;
  f.cdp.send = async (method: string, params: any = {}) => {
    if (method === 'Runtime.evaluate' && String(params.expression).includes('e.select')) return { result: { value: null } }; // not on the page
    return send(method, params);
  };
  const b = new CdpTabBrowser('http://unused', () => {}, f.cdp);
  const phone = new Phone();
  await b.attachPhone('T1', phone as any, size, cb);
  f.calls.length = 0;
  phone.in({ t: 'submit', values: { 'ab-2': 'secret' }, button: 'ab-3' });
  await until(() => phone.sent.some((m) => m.t === 'submitted'));
  assert.deepEqual(phone.sent.filter((m) => m.t === 'submitted'), [{ t: 'submitted', ok: false }]);
  assert.ok(!f.calls.some((c) => c.method.startsWith('Input.')), 'nothing typed, nothing pressed');
});

// FORM_JS on real pages, in a headless Chrome when the machine has one (hq-host does; skipped elsewhere).
const chrome = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => existsSync(p));
function scan(body: string) {
  const dir = mkdtempSync(join(tmpdir(), 'hq-form-'));
  try {
    const page = join(dir, 'p.html');
    writeFileSync(page, `<!doctype html><meta charset=utf-8><body>${body}<script>
      const r = ${FORM_JS}; document.body.innerHTML = ''; const o = document.createElement('pre'); o.id = 'out';
      o.textContent = JSON.stringify(r); document.body.append(o);</script>`);
    const html = execFileSync(chrome!, ['--headless', '--no-sandbox', '--disable-gpu', `--user-data-dir=${join(dir, 'prof')}`, '--dump-dom', `file://${page}`],
      { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = /<pre id="out">([^<]*)<\/pre>/.exec(html);
    return JSON.parse(m![1]!.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('phone form: FORM_JS on a page picks the login block, never search, newsletter or a show-password toggle', { skip: !chrome && 'no Chrome here' }, () => {
  const r = scan(`<form><input type=search name=q><button>Search</button></form>
    <form><div><input name=user placeholder=Username><input type=password placeholder=Password><button type=button>👁</button>
    <button type=button>Show</button><button type=submit>Sign in</button></div>
    <div><input type=email name=news placeholder=Email><button type=button>Join</button></div></form>`);
  assert.deepEqual(r.fields.map((f: any) => f.label), ['Username', 'Password']);
  assert.deepEqual(r.buttons.filter((b: any) => b.primary).map((b: any) => b.label), ['Sign in']);
  assert.ok(!r.buttons.some((b: any) => /👁|Show|Search|Join/.test(b.label)), JSON.stringify(r.buttons));
});

test('phone form: a password alone with an eye toggle, and an icon-only submit, still get the real button', { skip: !chrome && 'no Chrome here' }, () => {
  const r = scan(`<form><input type=password placeholder=Password><button type=button>Show</button>
    <button type=submit aria-label="Continue"><svg width=10 height=10></svg></button></form>`);
  assert.deepEqual(r.fields.map((f: any) => f.label), ['Password']);
  assert.deepEqual(r.buttons.map((b: any) => [b.label, b.primary]), [['Continue', true]]);
});
