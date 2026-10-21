// Screenshots of the v2 home (the mockup of company-engine#31): phone and desktop, light and dark, on a web build
// with DESIGN_V2 served by serve.mjs over an hq live copy (packages/hq/test/qa-live-copy.mts). One pairing
// code per shot: each is a fresh private profile in a headless Chromium, never the owner's Chrome.
// Usage: node home_v2.mjs <outdir> <name> <url> <code> [<code> ...]   (4 codes: phone/desktop × light/dark)
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const pwDir = process.env.PW_DIR || path.join(os.homedir(), '.local/state/agent-company/qa/pw');
const { chromium } = createRequire(path.join(pwDir, 'package.json'))('playwright');
const [out, name, url, ...codes] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });

const b = await chromium.launch({ headless: true, executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--enable-gpu-rasterization', '--ignore-gpu-blocklist'] });
const shots = [['phone', 'light'], ['phone', 'dark'], ['desktop', 'light'], ['desktop', 'dark']];
for (const [i, [device, scheme]] of shots.entries()) {
  const desktop = device === 'desktop';
  const ctx = await b.newContext({
    viewport: desktop ? { width: 1440, height: 900 } : { width: 412, height: 915 },
    deviceScaleFactor: desktop ? 1 : 2.625, isMobile: !desktop, hasTouch: !desktop, locale: 'he-IL', colorScheme: scheme,
  });
  // No WebAuthn here: pairing falls back to the code alone.
  await ctx.addInitScript(() => { try { delete window.PublicKeyCredential; } catch {} });
  const p = await ctx.newPage();
  await p.goto(url);
  await p.waitForTimeout(5000);
  await p.evaluate(() => document.querySelector('flt-semantics-placeholder')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await p.waitForTimeout(500);
  const box = await p.getByRole('textbox').last().boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  if (desktop) await p.mouse.click(x, y); else await p.touchscreen.tap(x, y);
  await p.waitForTimeout(600);
  // Flutter puts its own <input> in the page once the field has focus: type into that one.
  const input = p.locator('input, textarea').last();
  await input.focus();
  await p.keyboard.type(codes[i], { delay: 40 });
  await p.waitForTimeout(300);
  await p.keyboard.press('Enter');
  await p.waitForTimeout(+(process.env.SETTLE || 9000));
  const f = path.join(out, `${device}-${scheme}-${name}.png`);
  await p.screenshot({ path: f });
  console.log(f);
  // The phone's lower half too ("הסתיים לאחרונה" sits below the projects).
  if (!desktop) {
    const s = await ctx.newCDPSession(p);
    await s.send('Input.synthesizeScrollGesture', { x: 206, y: 600, yDistance: -800, speed: 1200, gestureSourceType: 'touch' });
    await p.waitForTimeout(1200);
    await p.screenshot({ path: f.replace('.png', '-scrolled.png') });
  }
  await ctx.close();
}
await b.close();
