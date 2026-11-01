// The live view of one tab on the owner's phone (B.9), ported as-is from the bet6 spike (PASS, "פגז"):
// phone-sized viewport, screencast with phone-paced acks, a sharp captureScreenshot once the screen settles,
// touch and keyboard through Input.*, and a "what has focus" probe that decides whether the keyboard stays.
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
  /** Phone input (touch, text, key) runs one message at a time, in order: text typed after a tap goes to the
   *  field that tap focused. Frame acks, "סיימתי", back and resize never wait behind it. */
  input?: Promise<unknown>;
  /** The touchMove last put in `input`, while nothing else came after it: a newer move replaces it (the finger is
   *  already past it), so a slow Chrome never replays a whole drag. */
  lastMove?: { skip?: boolean };
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
      case 'key': {
        const k = KEYS[msg.k]; if (!k) break;
        const base = { key: msg.k, code: msg.k, windowsVirtualKeyCode: k.code, nativeVirtualKeyCode: k.code };
        await this.send(v, 'Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...base, ...(k.text ? { text: k.text } : {}) });
        await this.send(v, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
        break;
      }
      case 'resize': // keyboard opened/closed: shrink the viewport so the focused field stays visible
        v.h = Math.max(200, Math.round(Number(msg.h) || v.h));
        await this.applyViewport(v);
        await this.send(v, 'Runtime.evaluate', { expression: `document.activeElement?.scrollIntoView?.({block:'center'})` }).catch(() => {});
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
      if (msg.t !== 'touch' && msg.t !== 'text' && msg.t !== 'key') { this.onPhoneMessage(view, msg).catch(fail); return; }
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
