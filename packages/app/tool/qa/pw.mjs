// QA driver for the web build in a private headless Chromium (never the owner's Chrome on :9222).
// Usage: node pw.mjs <scenario> <outdir> [--demo] [--desktop] [--dark]
// Playwright lives outside the repo: PW_DIR (default ~/.local/state/agent-company/qa/pw).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const pwDir = process.env.PW_DIR || path.join(os.homedir(), '.local/state/agent-company/qa/pw');
const { chromium } = createRequire(path.join(pwDir, 'package.json'))('playwright');

const args = process.argv.slice(2);
const scenario = args[0] || 'load';
const out = args[1] || '/tmp/qa';
const demo = args.includes('--demo');
const desktop = args.includes('--desktop');
const dark = args.includes('--dark');
const local = args.find((a) => a.startsWith('--url='))?.slice(6);
fs.mkdirSync(out, { recursive: true });

const appPath = fs.readFileSync(path.join(os.homedir(), '.local/state/agent-company/app-path'), 'utf8').trim();
const base = local || `https://app.hq.example.com/${appPath}/`;
const url = base + (demo ? '?demo' : '');
const vp = desktop ? { width: 1440, height: 900 } : { width: 412, height: 915 };

// PROFILE=<dir>: a persistent profile of our own (keeps a paired QA device between runs). Never the
// owner's Chrome. WebAuthn is hidden so pairing falls back to code-only (no authenticator here).
const opts = {
  headless: true,
  executablePath: process.env.CHROME || '/usr/bin/google-chrome',
  args: ['--enable-gpu-rasterization', '--ignore-gpu-blocklist'],
  viewport: vp,
  deviceScaleFactor: desktop ? 1 : 2.625,
  isMobile: !desktop,
  hasTouch: !desktop,
  locale: 'he-IL',
  colorScheme: dark ? 'dark' : 'light',
  recordVideo: { dir: out, size: vp },
};
let b = null, ctx;
if (process.env.PROFILE) {
  ctx = await chromium.launchPersistentContext(process.env.PROFILE, opts);
} else {
  b = await chromium.launch({ headless: opts.headless, executablePath: opts.executablePath, args: opts.args });
  const { headless, executablePath, args: _a, ...c } = opts;
  ctx = await b.newContext(c);
}
await ctx.addInitScript(() => {
  try { delete window.PublicKeyCredential; } catch {}
});
// QA_HQ=gateway: a session that talks to the real hq through the app's gateway (Caddy adds hq's
// token there), for a QA copy (tool/qa/publish_qa.sh) while the live hq has no sign-in API.
if (process.env.QA_HQ === 'gateway') {
  await ctx.addInitScript((url) => {
    localStorage.setItem('flutter.hq.url', JSON.stringify(url));
    localStorage.setItem('flutter.hq.token', JSON.stringify('gateway'));
  }, `https://app.hq.example.com/${appPath}/hq`);
}
const p = await ctx.newPage();
const logs = [];
p.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`));
p.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));

// Frame pacing and long tasks, from the first byte.
await p.addInitScript(() => {
  window.__qa = { frames: [], long: [], t0: performance.now() };
  let last = performance.now();
  const tick = (t) => {
    window.__qa.frames.push(t - last);
    last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  try {
    new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__qa.long.push([Math.round(e.startTime), Math.round(e.duration)]))).observe({ type: 'longtask', buffered: true });
  } catch {}
});

let n = 0;
const shot = async (name) => {
  const f = path.join(out, `${String(++n).padStart(2, '0')}-${name}.png`);
  await p.screenshot({ path: f });
  return f;
};
const stats = async (label) => {
  const s = await p.evaluate(() => {
    const f = window.__qa.frames.splice(0);
    const long = window.__qa.long.splice(0);
    const sorted = [...f].sort((a, b) => a - b);
    const pct = (q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0);
    return { frames: f.length, p50: +pct(0.5).toFixed(1), p95: +pct(0.95).toFixed(1), max: +(sorted.at(-1) || 0).toFixed(1), over33: f.filter((x) => x > 33.4).length, long };
  });
  console.log(`[${label}]`, JSON.stringify(s));
  return s;
};
// Flutter web semantics: turn it on so we can find widgets by label.
const semantics = async () => {
  if (await p.evaluate(() => document.querySelectorAll('flt-semantics').length > 3)) return;
  await p.evaluate(() => {
    const e = document.querySelector('flt-semantics-placeholder');
    if (e) e.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await p.waitForTimeout(500);
  if (process.env.QA_DEBUG) console.log('semantics nodes', await p.evaluate(() => document.querySelectorAll('flt-semantics').length));
};
const tapText = async (text, opts = {}) => {
  const loc = p.getByText(text, { exact: opts.exact ?? false }).first();
  const box = await loc.boundingBox({ timeout: 4000 });
  if (!box) throw new Error(`no ${text}`);
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  if (desktop) await p.mouse.click(x, y);
  else await p.touchscreen.tap(x, y);
};
const tapAt = async (x, y) => (desktop ? p.mouse.click(x, y) : p.touchscreen.tap(x, y));

const t0 = Date.now();
await p.goto(url, { waitUntil: 'commit' });
const scenarios = {
  // Cold load: screenshots on a timeline to see what pops in, plus first meaningful paint.
  async load() {
    for (const ms of [400, 800, 1200, 1800, 2500, 3500, 5000, 8000]) {
      const wait = ms - (Date.now() - t0);
      if (wait > 0) await p.waitForTimeout(wait);
      await shot(`t${ms}`);
    }
    await stats('load');
  },
  // Walk every tab, open the first chat, scroll it, come back.
  async tour() {
    await p.waitForTimeout(5000);
    await semantics();
    await shot('home');
    await stats('home-idle');
    for (const t of ['שיחות', 'לוח', 'ארגון', 'בית']) {
      await tapText(t, { exact: true });
      await p.waitForTimeout(120);
      await shot(`${t}-120ms`);
      await p.waitForTimeout(900);
      await shot(t);
      await stats(`tab ${t}`);
    }
  },
  // TAPS='[[x,y,"name"],...]' in CSS px; a screenshot right after (feedback) and after settling.
  async taps() {
    await p.waitForTimeout(+(process.env.WAIT || 4000));
    await shot('start');
    for (const [x, y, name, settle] of JSON.parse(process.env.TAPS || '[]')) {
      if (name === 'scrollup' || name === 'scrolldown') {
        const s = await p.context().newCDPSession(p);
        await s.send('Input.synthesizeScrollGesture', { x, y, yDistance: name === 'scrollup' ? 700 : -700, speed: 1500, gestureSourceType: desktop ? 'mouse' : 'touch' });
      } else if (name.startsWith('type:')) {
        await p.keyboard.type(name.slice(5), { delay: 25 });
      } else if (name === 'enter') {
        await p.keyboard.press('Enter');
      } else if (name.startsWith('watch:')) {
        // N screenshots every `settle` ms, to see what moves while things arrive.
        const n = +name.slice(6);
        for (let k = 0; k < n; k++) {
          await shot(`watch-${String(k).padStart(2, '0')}`);
          await p.waitForTimeout(settle ?? 1500);
        }
        await stats(name);
        continue;
      } else {
        await tapAt(x, y);
      }
      await p.waitForTimeout(100);
      await shot(`${name.replace(/[^\w֐-׿-]/g, '_').slice(0, 20)}-100ms`);
      await p.waitForTimeout(settle ?? 1000);
      await shot(name.replace(/[^\w֐-׿-]/g, '_').slice(0, 20));
      await stats(name);
    }
  },
  async chat() {
    await p.waitForTimeout(5000);
    await semantics();
    await tapText('שיחות', { exact: true });
    await p.waitForTimeout(600);
    await tapText(process.env.WHO || 'יואב');
    for (const ms of [50, 150, 300, 600, 1000, 2000, 3500]) {
      await p.waitForTimeout(ms === 50 ? 50 : ms - [50, 150, 300, 600, 1000, 2000, 3500][[50, 150, 300, 600, 1000, 2000, 3500].indexOf(ms) - 1]);
      await shot(`chat-${ms}`);
    }
    await stats('chat-open');
    // Scroll up through history.
    const cx = vp.width / 2, cy = vp.height / 2;
    for (let i = 0; i < 6; i++) {
      if (desktop) await p.mouse.wheel(0, -600);
      else {
        const s = await p.context().newCDPSession(p);
        await s.send('Input.synthesizeScrollGesture', { x: cx, y: cy, yDistance: 600, speed: 1600, gestureSourceType: 'touch' });
      }
      await p.waitForTimeout(200);
    }
    await shot('chat-scrolled');
    await stats('chat-scroll');
    if (process.env.SEND) {
      await semantics();
      const box = await p.getByRole('textbox').last().boundingBox();
      await tapAt(box.x + box.width / 2, box.y + box.height / 2);
      await p.waitForTimeout(400);
      await p.keyboard.type(process.env.SEND, { delay: 30 });
      await shot('typed');
      await p.keyboard.press('Enter');
      for (const ms of [100, 300, 1000, 3000, 8000, 15000]) {
        await p.waitForTimeout(ms === 100 ? 100 : 0);
        await shot(`sent-${ms}`);
        if (ms !== 100) await p.waitForTimeout(ms);
      }
      await stats('after-send');
    }
  },
};
try {
  await (scenarios[scenario] || scenarios.load)();
} catch (e) {
  console.log('ERROR', e.message);
  await shot('error');
}
fs.writeFileSync(path.join(out, 'console.log'), logs.join('\n'));
console.log(`console lines: ${logs.length}; errors: ${logs.filter((l) => /error/i.test(l)).length}`);
// A persistent profile with video can hang on close: give it 10s, then leave.
await Promise.race([ctx.close(), new Promise((r) => setTimeout(r, 10000))]);
if (b) await b.close();
process.exit(0);
