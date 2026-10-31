#!/usr/bin/env node
// End-to-end check of production from the outside, the way a phone sees it. Run on hq-host by
// scripts/deploy.sh after every deploy (and by hand: `node scripts/verify-prod.mjs`).
//   - api.hq: /health 200; without a token /api/board and WS /ws are refused.
//   - pairing: a one-time code (made with hq's own token, which stays on the server) becomes a
//     device token over the public URL; with it /api/board is 200 and the WebSocket opens; then the
//     test device is revoked and its token is refused. The device is revoked even when a step fails.
//   - dictation: only through hq and only with a device token; the old open /dictate route is gone.
//   - the app: the root loads, assetlinks.json and hq's pairing page are there, the APK is downloadable, big enough, and
//     signed with the release key that hq trusts (packages/hq/src/config.ts); hq's /api/app/latest
//     offers that same APK for the in-app update.
//   - hq.config.json: the one hq runs with is company/hq.config.json from the company (COMPANY_HOME); the public
//     URLs checked here are its auth.appUrl, apiUrl and tab.baseUrl (env VERIFY_*_URL override them).
//   - COMPANY_HOME: hq and every live worker read the contract and memory from it, not from this engine repo
//     (scripts/company-home-check.mjs).
// Every install has COMPANY_HOME, hq's health and auth, pairing, the WebSocket, /pair and assetlinks.json. The rest runs
// only where this install's settings say it is there (scripts/verify-plan.mjs): hq.config.json in git, dictation
// (dictate.url), the web app, the APK and its in-app update (appReleaseDir), tab.hq (tab.baseUrl).
// What does not apply prints as a skip with its reason, not a failure.
// --install is still accepted (older installers pass it) and changes nothing: the settings decide.
// Prints one Hebrew line per check; exit 1 when any check fails.
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import { resolveCompanyHome } from '../packages/shared/src/company-home.ts';
import { companyLocation, loadConfig } from '../packages/hq/src/config.ts';
import { companyHomeFindings, liveReaders, procEnv } from './company-home-check.mjs';
import { verifyPlan } from './verify-plan.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const state = process.env.COMPANY_STATE ?? join(homedir(), '.local/state/agent-company');
const liveCfgText = existsSync(join(state, 'hq.config.json')) ? readFileSync(join(state, 'hq.config.json'), 'utf8') : null;
const liveCfg = liveCfgText ? JSON.parse(liveCfgText) : {};
const cfg = loadConfig({ stateDir: state });
const LOCAL = `http://127.0.0.1:${cfg.port}`;
const noSlash = (u) => (typeof u === 'string' && u ? u.replace(/\/+$/, '') : null);
const APP = process.env.VERIFY_APP_URL ?? noSlash(liveCfg.auth?.appUrl);
const API = process.env.VERIFY_API_URL ?? noSlash(liveCfg.apiUrl);
if (!APP || !API) {
  console.log(`✗ אין כתובות לבדיקה: חסרים auth.appUrl או apiUrl ב-${join(state, 'hq.config.json')}`);
  process.exit(1);
}
const admin = readFileSync(join(state, 'api-token'), 'utf8').trim();
const apkKeyHash = /android:apk-key-hash:([A-Za-z0-9_-]+)/.exec(readFileSync(join(repo, 'packages/hq/src/config.ts'), 'utf8'))?.[1];
const apksigner = process.env.APKSIGNER ?? '/opt/android-sdk/build-tools/36.0.0/apksigner';

const results = [];
const ok = (line) => { results.push(true); console.log(`✓ ${line}`); };
const bad = (line) => { results.push(false); console.log(`✗ ${line}`); };
const expect = (cond, good, fail) => (cond ? ok(good) : bad(fail));
let skipped = 0;
const skip = (what, why) => { skipped++; console.log(`– דילוג: ${what}: ${why}`); };
/** Runs the group when this install has it (plan[key].run), else prints why it is skipped. */
const when = async (key, what, fn) => (plan[key].run ? fn() : skip(what, plan[key].why));

async function req(url, init = {}) {
  try {
    return await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20_000), ...init });
  } catch (e) {
    return { status: 0, headers: new Headers(), text: async () => String(e), json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
  }
}
const bearer = (t) => ({ authorization: `Bearer ${t}` });

/** Opens the WebSocket; resolves to 'open' or the reason it did not. */
function ws(url) {
  return new Promise((resolve) => {
    const s = new WebSocket(url, { handshakeTimeout: 15_000 });
    const done = (v) => { try { s.terminate(); } catch {} resolve(v); };
    s.on('open', () => done('open'));
    s.on('unexpected-response', (_q, r) => done(`HTTP ${r.statusCode}`));
    s.on('error', (e) => done(e.message));
  });
}

/** Half a second of silence as 16 kHz mono PCM16 WAV, what the app sends. */
function wav() {
  const pcm = Buffer.alloc(16_000);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16_000, 24);
  h.writeUInt32LE(32_000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
const dictate = (url, token) => {
  const f = new FormData();
  f.set('engine', 'openai');
  f.set('audio', new Blob([wav()]), 'audio.wav');
  return req(url, { method: 'POST', headers: token ? bearer(token) : {}, body: f });
};

// ── COMPANY_HOME: hq and the workers read the company from it, not from the engine repo ──
const companyHome = resolveCompanyHome({ stateRoot: state, fallback: repo });
const plan = verifyPlan({ fromFile: liveCfgText ? liveCfg : null, cfg, companyHome, engine: repo,
  env: process.env, apksigner, exists: existsSync });
{
  let hqEnv = {};
  try {
    const pid = execFileSync('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', 'agent-company-hq'], { encoding: 'utf8' }).trim();
    if (pid && pid !== '0') hqEnv = procEnv(pid);
  } catch { /* no systemd here: hq's env is unknown, its config still counts */ }
  const hqHome = companyLocation({}, liveCfg, hqEnv, repo).companyHome;
  for (const f of companyHomeFindings({ home: companyHome, engineRoot: repo, hqHome, readers: liveReaders() })) expect(f.ok, f.line, f.line);
}

// ── hq.config.json: this company's values, exactly as in git ─────────────────
await when('configInGit', 'hq.config.json מה-git של החברה', () => {
  const src = join(companyHome, 'company/hq.config.json');
  const want = existsSync(src) ? readFileSync(src, 'utf8') : null;
  expect(want != null && liveCfgText === want, `hq.config.json של hq זהה ל-${src}`,
    !want ? `אין ${src}` : liveCfgText == null ? `אין ${join(state, 'hq.config.json')}: hq רץ עם ברירות מחדל גנריות` : `hq.config.json של hq שונה מ-${src}`);
});

// ── api.hq: health, and nothing else without a token ─────────────────────────
{
  const h = await req(`${API}/health`);
  expect(h.status === 200, 'api.hq: /health עונה 200', `api.hq: /health ענה ${h.status}`);
  const b = await req(`${API}/api/board`);
  expect(b.status === 401, 'api.hq: /api/board בלי טוקן נחסם (401)', `api.hq: /api/board בלי טוקן ענה ${b.status}, ציפיתי ל-401`);
  const a = await req(`${APP}/hq/api/board`);
  expect(a.status === 401, 'app.hq: /hq/api/board בלי טוקן נחסם (401)', `app.hq: /hq/api/board בלי טוקן ענה ${a.status}, ציפיתי ל-401`);
  const w = await ws(`${APP.replace(/^http/, 'ws')}/hq/ws`);
  expect(w === 'HTTP 401', 'WebSocket בלי טוקן נחסם (401)', `WebSocket בלי טוקן: ${w}, ציפיתי ל-401`);
}
await when('dictation', 'הכתבה', async () => {
  const d = await dictate(`${APP}/hq/api/dictate/transcribe`);
  expect(d.status === 401, 'הכתבה בלי מכשיר מצומד נחסמת (401)', `הכתבה בלי טוקן ענתה ${d.status}, ציפיתי ל-401`);
  const open = await dictate(`${APP}/dictate/transcribe`);
  const text = open.status === 200 ? await open.text() : '';
  expect(!(open.status === 200 && text.includes('"text"')), 'אין יותר הכתבה פתוחה ב-/dictate', `/dictate/transcribe עדיין מתמלל בלי התחברות (${open.status})`);
});

// ── pairing → device token → board, WS, dictation → revoke ───────────────────
{
  let device = null;
  try {
    const pc = await req(`${LOCAL}/api/devices/pair`, { method: 'POST', headers: { ...bearer(admin), 'content-type': 'application/json' }, body: '{}' });
    const code = pc.status === 200 ? (await pc.json().catch(() => ({}))).code : null;
    expect(Boolean(code), 'קוד צימוד חד-פעמי נוצר', `לא נוצר קוד צימוד (${pc.status})`);
    if (code) {
      const p = await req(`${APP}/hq/api/auth/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name: 'בדיקת פריסה (scripts/deploy.sh)' }) });
      device = p.status === 200 ? await p.json().catch(() => null) : null;
      expect(Boolean(device?.token), 'הקוד הפך ל-token של מכשיר דרך הכתובת הציבורית', `הצימוד נכשל (${p.status})`);
    }
    if (device?.token) {
      const b = await req(`${APP}/hq/api/board`, { headers: bearer(device.token) });
      expect(b.status === 200, 'עם token של מכשיר /api/board עונה 200', `/api/board עם token של מכשיר ענה ${b.status}`);
      const w = await ws(`${APP.replace(/^http/, 'ws')}/hq/ws?token=${encodeURIComponent(device.token)}`);
      expect(w === 'open', 'WebSocket עם token של מכשיר נפתח', `WebSocket עם token של מכשיר: ${w}`);
      const d = plan.dictation.run ? await dictate(`${APP}/hq/api/dictate/transcribe`, device.token) : null;
      const body = d?.status === 200 ? await d.json().catch(() => ({})) : {};
      if (d) expect(d.status === 200 && typeof body.text === 'string', 'הכתבה עם token של מכשיר עוברת דרך hq ל-dictate-server', `הכתבה עם token של מכשיר ענתה ${d.status}`);
    }
  } finally {
    if (device?.device?.id) {
      const r = await req(`${LOCAL}/api/devices/${encodeURIComponent(device.device.id)}/revoke`, { method: 'POST', headers: bearer(admin) });
      const after = await req(`${APP}/hq/api/board`, { headers: bearer(device.token) });
      expect(r.status === 200 && after.status === 401, 'מכשיר הבדיקה בוטל, וה-token שלו נחסם', `ביטול מכשיר הבדיקה ${device.device.id}: ${r.status}, אחריו /api/board ענה ${after.status}`);
    }
  }
}

// ── the app at the root, assetlinks, the APK ─────────────────────────────────
await when('webApp', 'האפליקציה ל-web', async () => {
  const root = await req(`${APP}/`);
  const html = root.status === 200 ? await root.text() : '';
  expect(root.status === 200 && html.includes('<base href="/">'), 'האפליקציה נטענת בשורש', `השורש ענה ${root.status}${html && !html.includes('<base href="/">') ? ' בלי <base href="/">' : ''}`);
  const js = await req(`${APP}/main.dart.js`, { method: 'HEAD' });
  expect(js.status === 200, 'main.dart.js נטען', `main.dart.js ענה ${js.status}`);
});
{
  const al = await req(`${APP}/.well-known/assetlinks.json`);
  const alText = al.status === 200 ? await al.text() : '';
  expect(alText.includes('"package_name"'), 'assetlinks.json מוגש (passkeys באנדרואיד)', `assetlinks.json ענה ${al.status}`);
  // The pairing link's page (packages/hq/src/pairing.ts), from hq itself: api.hq passes everything to hq,
  // so this holds after `deploy.sh hq` alone too. A made-up code: the page never checks or spends it.
  const pp = await req(`${API}/pair?code=TEST-CODE`);
  const ppText = pp.status === 200 ? await pp.text() : '';
  expect(ppText.includes('TEST-CODE'), 'דף הצימוד /pair מוגש', `/pair ענה ${pp.status}`);
}
await when('apk', 'ה-APK והעדכון באפליקציה', async () => {
  const apk = await req(`${APP}/agent-company.apk`);
  const bytes = apk.status === 200 ? Buffer.from(await apk.arrayBuffer()) : Buffer.alloc(0);
  const mb = (bytes.length / 1048576).toFixed(1);
  expect(bytes.length > 5 * 1048576, `ה-APK להורדה (${mb} MB)`, `ה-APK ענה ${apk.status}, ${mb} MB`);
  if (bytes.length && !plan.apkSignature.run) skip('חתימת ה-APK', plan.apkSignature.why);
  else if (bytes.length && apkKeyHash) {
    const dir = mkdtempSync(join(tmpdir(), 'verify-apk-'));
    try {
      writeFileSync(join(dir, 'a.apk'), bytes);
      const out = execFileSync(apksigner, ['verify', '--print-certs', join(dir, 'a.apk')], { encoding: 'utf8' });
      const hex = /certificate SHA-256 digest: ([0-9a-f]{64})/.exec(out)?.[1];
      const got = hex ? Buffer.from(hex, 'hex').toString('base64url') : null;
      expect(got === apkKeyHash, 'ה-APK חתום במפתח השחרור ש-hq מכיר', `החתימה של ה-APK (${got}) לא תואמת ל-${apkKeyHash}`);
    } catch (e) {
      bad(`apksigner דחה את ה-APK: ${(e).message.split('\n')[0]}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  } else if (bytes.length) {
    bad('אין ב-packages/hq/src/config.ts מפתח שחרור (android:apk-key-hash), ולכן החתימה לא נבדקה');
  }
  if (bytes.length) console.log(`  sha256 של ה-APK: ${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}…`);

  // The in-app update: hq offers exactly the APK that is up for download (packages/hq/src/app-release.ts).
  const lr = await req(`${LOCAL}/api/app/latest`, { headers: bearer(admin) });
  const latest = lr.status === 200 ? (await lr.json()).latest : null;
  const sum = createHash('sha256').update(bytes).digest('hex');
  expect(latest?.sha256 === sum && latest?.bytes === bytes.length,
    `hq מציע לאפליקציה את הגרסה הזו לעדכון (versionCode ${latest?.version_code})`,
    lr.status !== 200 ? `‏/api/app/latest ענה ${lr.status}` : latest ? `hq מציע APK אחר (${latest.sha256?.slice(0, 16)}…)` : 'hq לא מציע גרסה לעדכון');
});

// ── tab.hq: hq's handoff listener answers, and only for /h/ and /ws/ ─────────
await when('tab', 'tab.hq', async () => {
  const TAB = process.env.VERIFY_TAB_URL ?? noSlash(liveCfg.tab?.baseUrl) ?? 'http://127.0.0.1:7422';
  // A token no handoff has: hq answers 410 (expired page), which proves Caddy reaches hq's listener.
  const fake = Array.from({ length: 32 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');
  const h = await req(`${TAB}/h/${fake}`, { headers: { 'sec-fetch-mode': 'navigate', 'user-agent': 'Mozilla/5.0 deploy-check' } });
  expect(h.status === 410, 'tab.hq: מסירת הטאב של hq עונה (410 לקישור שלא קיים)', `tab.hq: /h/<token> ענה ${h.status}, ציפיתי ל-410 מ-hq`);
  const r = await req(`${TAB}/api/board`);
  expect(r.status === 404, 'tab.hq: שום דבר אחר של hq לא נגיש דרכו', `tab.hq: /api/board ענה ${r.status}, ציפיתי ל-404`);
});

const failed = results.filter((x) => !x).length;
const skips = skipped ? ` (${skipped} דולגו: לא רלוונטיות להתקנה הזו)` : '';
console.log(failed ? `\n${failed} בדיקות נכשלו מתוך ${results.length}${skips}.` : `\nכל ${results.length} הבדיקות עברו${skips}.`);
process.exit(failed ? 1 : 0);
