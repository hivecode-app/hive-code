// One tab on the owner's phone (B.9). First the page's own form as a native phone form (FORM_JS, submitForm): real
// keyboard, delete, paste and autofill, values typed into the tab over CDP. Above it, and as a fallback for what is
// not a form (a CAPTCHA), the live view from the bet6 spike: phone-sized viewport, screencast with phone-paced acks,
// a sharp captureScreenshot once the screen settles, touch and keyboard through Input.*.
// The handed-over tab is usually the worker's own, in a window it shares with other tabs (#378). Once another
// tab there comes to the front, Chrome hides ours: no more frames, and every Input.* waits until it is shown
// again, then replays out of order (02/11, Namecheap: "can't tap a field, can't delete"). Focus emulation
// keeps the page visible and drivable whatever is in front, so the view never depends on window order.
import type { WebSocket } from 'ws';
import { Cdp } from './cdp.ts';

/** The part of Cdp the view uses (tests inject a fake). */
export type CdpLike = Pick<Cdp, 'send' | 'attach' | 'detach' | 'pages' | 'close'>
  & { onTargetGone: Cdp['onTargetGone']; onDisconnect: Cdp['onDisconnect']; onConnect: Cdp['onConnect'] };

/** What hq needs from the shared Chrome. CdpTabBrowser is the real one; tests inject a fake. */
export interface TabBrowser {
  /** A new window of its own (B.9: one window per agent, so the screencast keeps producing frames). */
  openWindow(url: string): Promise<string>;
  hasTarget(targetId: string): Promise<boolean>;
  /** The URL the tab is on now, or null when it is not open. */
  targetUrl(targetId: string): Promise<string | null>;
  closeTarget(targetId: string): Promise<void>;
  /** Drive `targetId` from this phone socket until it closes. `onDone` = the phone pressed "סיימתי". */
  attachPhone(targetId: string, phone: WebSocket, size: PhoneSize, cb: PhoneCallbacks): Promise<void>;
  /** Stop the view and give the tab back as it was (no phone viewport left on it); the phone is told why. */
  release(targetId: string, tell?: PhoneEnd): Promise<void>;
  /** A previous hq run may have left a phone viewport on these tabs. */
  clearStale(targetIds: string[]): Promise<void>;
  /** Called with a target id when its tab closes. */
  onTargetGone: (targetId: string) => void;
  /** Called after each connection to Chrome (also after it restarted). */
  onConnected?: () => void;
  close?(): void;
}

/** What the phone page shows when the handoff ends (phone.html). */
export type PhoneEnd = 'finished' | 'expired' | 'closed' | 'cancelled';

export interface PhoneSize { w: number; h: number; dsf: number }
export interface PhoneCallbacks { onDone(finalUrl: string): void; onUrl(url: string): void }

interface View {
  targetId: string; sessionId: string; phone: WebSocket | null; cb: PhoneCallbacks;
  w: number; h: number; dsf: number; currentUrl: string;
  lastFrameSession?: number; dirty?: boolean; sharpTimer?: NodeJS.Timeout; ignoreUntil?: number;
  /** Phone input (touch, text, key, the native form) runs one message at a time, in order: text typed after a tap goes to the
   *  field that tap focused. Frame acks, "סיימתי", back and resize never wait behind it. */
  input?: Promise<unknown>;
  /** The touchMove last put in `input`, while nothing else came after it: a newer move replaces it (the finger is
   *  already past it), so a slow Chrome never replays a whole drag. */
  lastMove?: { skip?: boolean };
  scanTimers?: NodeJS.Timeout[]; lastForm?: string;
}

// What has focus inside the tab? Decides whether the phone keyboard stays open.
const FOCUS_JS = `(() => {
  let e = document.activeElement;
  while (e && e.shadowRoot && e.shadowRoot.activeElement) e = e.shadowRoot.activeElement;
  if (!e) return { editable: false };
  const tag = e.tagName;
  if (tag === 'IFRAME') return { editable: true, iframe: true };
  const types = ['text','email','password','tel','number','search','url',''];
  const editable = e.isContentEditable || tag === 'TEXTAREA' ||
    (tag === 'INPUT' && types.includes((e.getAttribute('type') || '').toLowerCase()));
  return { editable, type: e.type || '', autocomplete: e.autocomplete || '', inputmode: e.inputMode || '' };
})()`;

// The page's own form, for the phone's native one (02/11: a live picture you tap on cannot give a phone keyboard,
// delete, paste or autofill; «זבל של דבר»). Every field and button gets a stable data-hqk so 'submit' can find it.
// Open shadow roots count; cross-origin frames (a CAPTCHA) do not, and stay for the live view.
export const FORM_JS = `(() => {
  const deep = (root, sel, out = []) => {
    root.querySelectorAll(sel).forEach((e) => out.push(e));
    root.querySelectorAll('*').forEach((e) => { if (e.shadowRoot) deep(e.shadowRoot, sel, out); });
    return out;
  };
  const shown = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
    return r.width > 2 && r.height > 2 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05; };
  // Keys carry a per-document id: a field on the next page never takes the key (and the phone input) of one before it.
  window.__hqn = window.__hqn || Math.random().toString(36).slice(2, 8);
  window.__hqk = window.__hqk || 0;
  const key = (e) => (e.dataset.hqk ||= window.__hqn + '-' + (++window.__hqk));
  const text = (e) => (e && (e.innerText || e.textContent || '') || '').replace(/\\s+/g, ' ').trim();
  const labelOf = (e) => {
    const by = e.getAttribute('aria-labelledby');
    const l = e.getAttribute('aria-label') || (by && text(document.getElementById(by)))
      || (e.id && text(document.querySelector('label[for="' + CSS.escape(e.id) + '"]')))
      || text(e.closest('label')) || e.placeholder || e.title || e.name || '';
    return l.slice(0, 80);
  };
  const TYPES = ['text', 'email', 'password', 'tel', 'number', 'search', 'url', ''];
  let els = deep(document, 'input, textarea, select').filter((e) => {
    if (e.disabled || e.readOnly || !shown(e)) return false;
    if (e.tagName !== 'INPUT') return true;
    const t = (e.getAttribute('type') || '').toLowerCase();
    return TYPES.includes(t) || t === 'checkbox';
  });
  // A site search in the header is not the form (a code page with a search box sent Enter to Search).
  const isSearch = (e) => e.type === 'search' || e.getAttribute('role') === 'searchbox' || !!e.closest('[role=search]')
    || /(^|[^a-z])(q|query|search)([^a-z]|$)/i.test(e.name || '');
  els = els.filter((e) => !isSearch(e));
  // A toggle next to a field (show password: an eye, "Show", an icon) is never the form's action.
  const toggle = (e) => e.type !== 'submit' && (/^(show|hide|הצג|הסתר|הצגה|הסתרה)$/i.test(text(e) || e.value || '')
    || !/[\p{L}\p{N}]/u.test(text(e) || e.value || ''));
  let cands = deep(document, 'button, input[type=submit], input[type=button], [role=button]')
    .filter((e) => shown(e) && !toggle(e) && !e.closest('[role=search]'));
  // The page's main block only (the login, not the newsletter in the footer). <form> does not say it: an ASP.NET
  // page is one form (Namecheap). So: from the password field (else the first field), the smallest ancestor that
  // holds a button and, when there are other fields, at least one of them.
  const anchor = els.find((e) => e.type === 'password') || els.find((e) => e.autocomplete === 'one-time-code') || els[0];
  let box = anchor && anchor.parentElement;
  const has = (c, list, but) => list.some((e) => e !== but && c.contains(e));
  while (box && box !== document.body && !(has(box, cands) && (els.length < 2 || has(box, els, anchor)))) box = box.parentElement;
  if (box && box !== document.body) { els = els.filter((e) => box.contains(e)); cands = cands.filter((e) => box.contains(e)); }
  const fields = els.slice(0, 12).map((e) => {
    const type = e.tagName === 'SELECT' ? 'select' : e.tagName === 'TEXTAREA' ? 'textarea' : (e.getAttribute('type') || 'text').toLowerCase();
    const f = { k: key(e), type, label: labelOf(e), autocomplete: e.getAttribute('autocomplete') || '', inputmode: e.inputMode || '',
      maxlength: e.maxLength > 0 ? e.maxLength : undefined };
    if (type === 'password') f.filled = !!e.value;
    else if (type === 'checkbox') f.checked = e.checked;
    else f.value = e.value;
    if (type === 'select') f.options = [...e.options].slice(0, 50).map((o) => ({ v: o.value, l: text(o) || o.value }));
    return f;
  });
  const forms = new Set(els.map((e) => e.form).filter(Boolean));
  // Best first: in the fields' form, a submit, after the fields (the action follows its fields).
  const after = (e) => anchor && (anchor.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING) ? 0 : 1;
  const buttons = cands
    .map((e) => ({ e, label: (text(e) || e.value || e.getAttribute('aria-label') || 'המשך').slice(0, 40),
      rank: (forms.has(e.form) ? 0 : 4) + ((e.type === 'submit') ? 0 : 2) + after(e) }))
    .filter((b) => b.label.length > 0)
    .sort((a, b) => a.rank - b.rank).slice(0, 6)
    .map((b, i) => ({ k: key(b.e), label: b.label, primary: i === 0 }));
  return { fields, buttons, title: document.title.slice(0, 80), frames: document.querySelectorAll('iframe').length };
})()`;

const KEYS: Record<string, { code: number; text?: string }> = {
  Backspace: { code: 8 }, Enter: { code: 13, text: '\r' }, Tab: { code: 9 },
};

export class CdpTabBrowser implements TabBrowser {
  private cdp: CdpLike;
  private views = new Map<string, View>(); // by targetId
  /** attachPhone and release on one tab run one at a time: a reload racing "סיימתי" must not leak a session. */
  private queues = new Map<string, Promise<unknown>>();
  private log: (msg: string, data?: unknown) => void;
  onTargetGone: (targetId: string) => void = () => {};
  onConnected: () => void = () => {};

  private serial<T>(targetId: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.queues.get(targetId) ?? Promise.resolve()).catch(() => {}).then(fn);
    const tail = run.catch(() => {});
    this.queues.set(targetId, tail);
    tail.then(() => { if (this.queues.get(targetId) === tail) this.queues.delete(targetId); });
    return run;
  }

  constructor(cdpUrl: string, log: (msg: string, data?: unknown) => void = () => {}, cdp: CdpLike = new Cdp(cdpUrl)) {
    this.cdp = cdp;
    this.log = log;
    this.cdp.onTargetGone = (id) => {
      const v = this.views.get(id);
      if (v) { this.views.delete(id); this.toPhone(v, { t: 'closed' }); v.phone?.close(); }
      this.onTargetGone(id);
    };
    // Sessions die with the connection; the phone reconnects (phone.html retries) and re-attaches.
    this.cdp.onDisconnect = () => {
      for (const v of this.views.values()) v.phone?.close();
      this.views.clear();
    };
    this.cdp.onConnect = () => this.onConnected();
  }

  async openWindow(url: string): Promise<string> {
    // Own new window: never reuse or touch tabs other agents use. A separate window keeps the tab "visible"
    // so Chrome does not throttle it and the screencast keeps producing frames.
    const { targetId } = await this.cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true });
    const s = await this.cdp.attach(targetId, () => {});
    await this.cdp.send('Page.navigate', { url }, s).catch(() => {});
    await this.cdp.detach(s);
    return targetId;
  }

  async hasTarget(targetId: string): Promise<boolean> {
    return (await this.cdp.pages()).some((p) => p.targetId === targetId);
  }

  async targetUrl(targetId: string): Promise<string | null> {
    return (await this.cdp.pages()).find((p) => p.targetId === targetId)?.url ?? null;
  }

  async closeTarget(targetId: string): Promise<void> {
    await this.cdp.send('Target.closeTarget', { targetId }).catch(() => {});
  }

  private toPhone(v: View, msg: object): void {
    if (v.phone?.readyState === 1) v.phone.send(JSON.stringify(msg));
  }

  private send(v: View, method: string, params: object = {}): Promise<any> {
    return this.cdp.send(method, params, v.sessionId);
  }

  private onSessionEvent(v: View, method: string, p: any): void {
    if (method === 'Page.screencastFrame') {
      v.lastFrameSession = p.sessionId;
      if (Date.now() < (v.ignoreUntil ?? 0)) { // echo of our own captureScreenshot: keep the sharp frame
        this.send(v, 'Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
        return;
      }
      v.dirty = true;
      clearTimeout(v.sharpTimer);
      v.sharpTimer = setTimeout(() => this.sharpen(v).catch((e) => this.log('sharpen', String(e))), 300);
      if (v.phone?.readyState === 1) {
        // flow control: the phone acks after it painted the frame; only then do we ack Chrome
        v.phone.send(JSON.stringify({ t: 'frame', d: p.data, m: p.metadata }));
      } else {
        this.send(v, 'Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
      }
    } else if (method === 'Page.screencastVisibilityChanged' && !p.visible) {
      // Hidden anyway: Chrome answers "on" again with a no-op when it is already on, so turn it off and on.
      this.log('tab hidden under the phone view', { targetId: v.targetId });
      this.send(v, 'Emulation.setFocusEmulationEnabled', { enabled: false })
        .then(() => this.send(v, 'Emulation.setFocusEmulationEnabled', { enabled: true })).catch(() => {});
    } else if (method === 'Page.loadEventFired') {
      this.scanSoon(v, [300, 1500]);
    } else if (method === 'Page.frameNavigated' && !p.frame.parentId) {
      v.currentUrl = p.frame.url;
      v.cb.onUrl(v.currentUrl);
      this.toPhone(v, { t: 'url', url: v.currentUrl });
    }
  }

  // Headful screencast frames come at the window's real DPR (1x on Xvnc) whatever the emulated
  // deviceScaleFactor is. captureScreenshot honours it, so once the screen settles we send one sharp frame.
  private async sharpen(v: View): Promise<void> {
    if (!v.dirty || v.phone?.readyState !== 1) return;
    v.dirty = false;
    const r = await this.send(v, 'Page.captureScreenshot', { format: 'jpeg', quality: 70 });
    v.ignoreUntil = Date.now() + 200;
    this.toPhone(v, { t: 'frame', hi: 1, d: r.data, m: { deviceWidth: v.w, deviceHeight: v.h } });
  }

  private async applyViewport(v: View): Promise<void> {
    await this.send(v, 'Emulation.setDeviceMetricsOverride', {
      width: v.w, height: v.h, deviceScaleFactor: v.dsf, mobile: true, screenWidth: v.w, screenHeight: v.h,
    });
  }

  private async startView(v: View): Promise<void> {
    await this.applyViewport(v);
    await this.send(v, 'Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await this.send(v, 'Emulation.setFocusEmulationEnabled', { enabled: true });
    await this.send(v, 'Page.bringToFront').catch(() => {});
    await this.send(v, 'Page.stopScreencast').catch(() => {});
    await this.send(v, 'Page.startScreencast', {
      format: 'jpeg', quality: 60, maxWidth: Math.round(v.w * v.dsf), maxHeight: Math.round(v.h * v.dsf), everyNthFrame: 1,
    });
  }

  /** Send the page's form to the phone after `delays` ms each (pages settle late), only when it changed. */
  private scanSoon(v: View, delays: number[]): void {
    for (const t of v.scanTimers ?? []) clearTimeout(t);
    v.scanTimers = delays.map((d) => setTimeout(() => this.scanForm(v).catch(() => {}), d));
  }

  private async scanForm(v: View, force = false): Promise<void> {
    if (v.phone?.readyState !== 1) return;
    const r = await this.send(v, 'Runtime.evaluate', { expression: FORM_JS, returnByValue: true });
    const form = r?.result?.value;
    if (!form) return;
    const json = JSON.stringify(form);
    if (!force && json === v.lastForm) return;
    v.lastForm = json;
    this.toPhone(v, { t: 'form', ...form });
  }

  /** The phone's native form, into the page: each changed field typed as a person would (focus, select, insertText), then the button. */
  private async submitForm(v: View, values: Record<string, unknown>, button: unknown): Promise<void> {
    const sel = (k: string) => `document.querySelector('[data-hqk="${k.replace(/[^a-z0-9-]/g, '')}"]') || (() => { const d = (r) => { for (const e of r.querySelectorAll('*')) { if (e.dataset?.hqk === '${k.replace(/[^a-z0-9-]/g, '')}') return e; if (e.shadowRoot) { const x = d(e.shadowRoot); if (x) return x; } } return null; }; return d(document); })()`;
    const evalv = async (expr: string) => (await this.send(v, 'Runtime.evaluate', { expression: expr, returnByValue: true }))?.result?.value;
    let missing = 0;
    for (const [k, raw] of Object.entries(values ?? {})) {
      const val = typeof raw === 'boolean' ? raw : String(raw ?? '');
      const kind = await evalv(`(() => { const e = ${sel(k)}; if (!e) return null; e.scrollIntoView({ block: 'center' }); e.focus();
        if (e.type === 'checkbox') return 'checkbox'; if (e.tagName === 'SELECT') return 'select';
        if (e.select) e.select(); else document.execCommand('selectAll'); return 'text'; })()`);
      if (!kind) { missing++; continue; }
      if (kind === 'checkbox') await evalv(`(() => { const e = ${sel(k)}; if (e.checked !== ${val === true}) e.click(); })()`);
      else if (kind === 'select') await evalv(`(() => { const e = ${sel(k)}; e.value = ${JSON.stringify(String(val))}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      else if (kind === 'text') {
        if (val) await this.send(v, 'Input.insertText', { text: String(val) });
        else await this.pressKey(v, 'Backspace');
        await evalv(`(() => { const e = ${sel(k)}; e && e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      }
    }
    if (missing) {
      // The page changed under the phone: pressing the button now could sign in with half a form.
      this.toPhone(v, { t: 'submitted', ok: false });
      this.scanSoon(v, [0]);
      return;
    }
    let pressed = true;
    if (button === 'enter') await this.pressKey(v, 'Enter');
    else if (typeof button === 'string' && button) {
      // A real click at the button's centre (trusted, like a finger): a page may only enable it after the input above.
      await new Promise((r) => setTimeout(r, 150));
      const pt = await evalv(`(() => { const e = ${sel(button)}; if (!e) return null; e.scrollIntoView({ block: 'center' });
        const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      if (pt) {
        await this.send(v, 'Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pt.x, y: pt.y }] });
        await this.send(v, 'Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } else pressed = false;
    }
    this.toPhone(v, { t: 'submitted', ok: pressed });
    this.scanSoon(v, [800, 2500, 5000]);
  }

  private async pressKey(v: View, name: string): Promise<void> {
    const k = KEYS[name]; if (!k) return;
    const base = { key: name, code: name, windowsVirtualKeyCode: k.code, nativeVirtualKeyCode: k.code };
    await this.send(v, 'Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...base, ...(k.text ? { text: k.text } : {}) });
    await this.send(v, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  private async focusInfo(v: View): Promise<Record<string, unknown>> {
    try {
      const r = await this.send(v, 'Runtime.evaluate', { expression: FOCUS_JS, returnByValue: true });
      return r.result.value ?? { editable: false };
    } catch { return { editable: false }; }
  }

  private async onPhoneMessage(v: View, msg: any): Promise<void> {
    switch (msg.t) {
      case 'ack':
        if (v.lastFrameSession !== undefined) await this.send(v, 'Page.screencastFrameAck', { sessionId: v.lastFrameSession });
        break;
      case 'touch': {
        const touchPoints = msg.type === 'touchEnd' || msg.type === 'touchCancel' ? [] :
          (Array.isArray(msg.pts) ? msg.pts as number[][] : []).map(([x, y, id]) => ({ x, y, id, radiusX: 4, radiusY: 4, force: 1 }));
        if (!touchPoints.length && msg.type !== 'touchEnd' && msg.type !== 'touchCancel') break; // a move that lost the race with its touchEnd
        await this.send(v, 'Input.dispatchTouchEvent', { type: msg.type, touchPoints });
        if (msg.type === 'touchEnd' && msg.tap) {
          await new Promise((r) => setTimeout(r, 180));
          this.toPhone(v, { t: 'focus', ...(await this.focusInfo(v)) });
        }
        break;
      }
      case 'text':
        if (msg.s) await this.send(v, 'Input.insertText', { text: String(msg.s) });
        break;
      case 'key':
        await this.pressKey(v, String(msg.k));
        break;
      case 'submit':
        try { await this.submitForm(v, msg.values, msg.button); }
        catch (e) { this.toPhone(v, { t: 'submitted', ok: false, error: true }); throw e; }
        break;
      case 'scan':
        await this.scanForm(v, true);
        break;
      case 'back':
        await this.send(v, 'Runtime.evaluate', { expression: 'history.back()' });
        break;
      case 'done':
        v.cb.onDone(v.currentUrl);
        break;
    }
  }

  attachPhone(targetId: string, phone: WebSocket, size: PhoneSize, cb: PhoneCallbacks): Promise<void> {
    return this.serial(targetId, () => this.attachNow(targetId, phone, size, cb));
  }

  private async attachNow(targetId: string, phone: WebSocket, size: PhoneSize, cb: PhoneCallbacks): Promise<void> {
    if (phone.readyState !== 1) return; // the phone left while waiting its turn
    let v = this.views.get(targetId);
    if (v) {
      v.phone?.close(); // newest phone connection wins
    } else {
      const fresh = { targetId, sessionId: '', phone: null, cb, w: size.w, h: size.h, dsf: size.dsf, currentUrl: '' } as View;
      fresh.sessionId = await this.cdp.attach(targetId, (m, p) => this.onSessionEvent(fresh, m, p));
      await this.send(fresh, 'Page.enable');
      const r = await this.send(fresh, 'Runtime.evaluate', { expression: 'location.href', returnByValue: true }).catch(() => null);
      fresh.currentUrl = r?.result?.value ?? '';
      this.views.set(targetId, fresh);
      v = fresh;
    }
    const view = v;
    Object.assign(view, { phone, cb, w: size.w, h: size.h, dsf: size.dsf });
    phone.on('message', (raw) => {
      let msg: any; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (view.phone !== phone) return;
      const fail = (e: unknown) => this.log('input error', { t: msg.t, error: String(e) });
      if (!['touch', 'text', 'key', 'submit', 'scan'].includes(msg.t)) { this.onPhoneMessage(view, msg).catch(fail); return; }
      if (msg.type === 'touchMove' && view.lastMove) view.lastMove.skip = true;
      view.lastMove = msg.type === 'touchMove' ? msg : undefined;
      view.input = (view.input ?? Promise.resolve())
        .then(() => (msg.skip ? undefined : this.onPhoneMessage(view, msg)))
        .catch(fail);
    });
    phone.on('close', () => {
      if (view.phone === phone) { view.phone = null; this.send(view, 'Page.stopScreencast').catch(() => {}); }
    });
    this.toPhone(view, { t: 'url', url: view.currentUrl });
    cb.onUrl(view.currentUrl);
    await this.startView(view);
    view.lastForm = undefined;
    await this.scanForm(view, true).catch(() => {});
  }

  release(targetId: string, tell?: PhoneEnd): Promise<void> {
    return this.serial(targetId, () => this.releaseNow(targetId, tell));
  }

  private async releaseNow(targetId: string, tell?: PhoneEnd): Promise<void> {
    const v = this.views.get(targetId);
    if (!v) return this.clearStale([targetId]).catch(() => {});
    this.views.delete(targetId);
    if (tell) this.toPhone(v, { t: tell });
    v.phone?.close();
    clearTimeout(v.sharpTimer);
    for (const t of v.scanTimers ?? []) clearTimeout(t);
    try {
      await this.send(v, 'Page.stopScreencast').catch(() => {});
      await this.send(v, 'Emulation.clearDeviceMetricsOverride');
      await this.send(v, 'Emulation.setTouchEmulationEnabled', { enabled: false });
      await this.send(v, 'Emulation.setFocusEmulationEnabled', { enabled: false });
    } catch (e) { this.log('cleanup error', String(e)); }
    await this.cdp.detach(v.sessionId);
  }

  async clearStale(targetIds: string[]): Promise<void> {
    if (!targetIds.length) return;
    const live = new Set((await this.cdp.pages()).map((p) => p.targetId));
    for (const targetId of targetIds) {
      if (!live.has(targetId) || this.views.has(targetId)) continue;
      try {
        const s = await this.cdp.attach(targetId, () => {});
        await this.cdp.send('Emulation.clearDeviceMetricsOverride', {}, s);
        await this.cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false }, s);
        await this.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false }, s);
        await this.cdp.detach(s);
      } catch { /* tab already gone */ }
    }
  }

  close(): void { this.cdp.close(); }
}
