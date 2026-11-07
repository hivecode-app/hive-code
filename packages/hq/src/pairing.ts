// One app for every server (docs/generic/PLAN.md §2, step 4). The app has no hq address built in: it
// learns it from a pairing link, `https://<host>/pair?code=XXXX-XXXX` (a QR from the installer or from
// settings → devices), or from the address typed on its sign-in screen. hq serves, on every domain it runs:
//   GET /pair?code=…                  a page for the phone that opened the link: open it in the app
//                                     (agentcompany://pair?url=<this link>), or go on in the browser
//                                     (<appUrl>?pair=<code>). It shows the code; it never spends it.
//   GET /.well-known/assetlinks.json  the APK's signing key for this domain, so Android passkeys work
//                                     with whatever rpId the server has. Built from the
//                                     `android:apk-key-hash:` origins in cfg.auth.origins.
// The app finds hq itself at `<origin>/hq`, the same layout the web build uses (deploy/caddy).
import type { IncomingMessage } from 'node:http';

/** The APK's package (packages/app/android/app/build.gradle.kts): the same on every server. */
export const APP_PACKAGE = 'app.hivecode';
/** The app's own link scheme (AndroidManifest.xml). Android can't verify https links for every domain. */
export const APP_SCHEME = 'agentcompany';

const CODE = /^[A-Za-z0-9 -]{4,20}$/;

/** What a pairing code's link points to: `<origin of appUrl>/pair?code=…`; null when hq has no public address. */
export function pairLink(appUrl: string | null, code: string): string | null {
  if (!appUrl) return null;
  try { return `${new URL(appUrl).origin}/pair?code=${encodeURIComponent(code)}`; } catch { return null; }
}

/** `android:apk-key-hash:<b64url sha256>` → `AA:BB:…`, the form assetlinks.json wants. */
export function certFingerprint(origin: string): string | null {
  const m = /^android:apk-key-hash:([A-Za-z0-9_-]{43})$/.exec(origin);
  if (!m) return null;
  const hex = Buffer.from(m[1]!, 'base64url').toString('hex').toUpperCase();
  return hex.length === 64 ? hex.match(/../g)!.join(':') : null;
}

export function assetLinks(origins: readonly string[]): unknown[] {
  const prints = [...new Set(origins.map(certFingerprint).filter((f): f is string => f !== null))];
  if (!prints.length) return [];
  return [{
    relation: ['delegate_permission/common.handle_all_urls', 'delegate_permission/common.get_login_creds'],
    target: { namespace: 'android_app', package_name: APP_PACKAGE, sha256_cert_fingerprints: prints },
  }];
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The public origin this request came in on: appUrl's when hq has one, else what Caddy forwarded. */
function publicOrigin(req: IncomingMessage, appUrl: string | null): string | null {
  if (appUrl) { try { return new URL(appUrl).origin; } catch { /* fall through */ } }
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(',')[0]!.trim();
  if (!/^[A-Za-z0-9.-]+(:\d+)?$/.test(host)) return null;
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]!.trim() === 'http' ? 'http' : 'https';
  return `${proto}://${host}`;
}

/** GET /pair: the HTML page, and its status. */
export function pairPage(req: IncomingMessage, url: URL, appUrl: string | null): { status: number; html: string } {
  const raw = (url.searchParams.get('code') ?? '').trim();
  const code = CODE.test(raw) ? raw.toUpperCase() : null;
  const origin = publicOrigin(req, appUrl);
  if (!code || !origin) return { status: 400, html: page(null, null, null, null) };
  const link = `${origin}/pair?code=${encodeURIComponent(code)}`;
  const web = `${appUrl ?? `${origin}/`}?pair=${encodeURIComponent(code)}`;
  const intent = `intent://pair?url=${encodeURIComponent(link)}#Intent;scheme=${APP_SCHEME};package=${APP_PACKAGE};`
    + `S.browser_fallback_url=${encodeURIComponent(web)};end`;
  const android = /Android/i.test(String(req.headers['user-agent'] ?? ''));
  return { status: 200, html: page(code, new URL(origin).host, android ? intent : null, web) };
}

function page(code: string | null, host: string | null, intent: string | null, web: string | null): string {
  const body = code && host && web
    ? `<h1>צימוד מכשיר</h1>
<p class="sub">חיבור המכשיר הזה לחברה בשרת <bdi dir="ltr">${esc(host)}</bdi>.</p>
<div class="code" dir="ltr">${esc(code)}</div>
<p class="meta">קוד לשימוש אחד, בתוקף 10 דקות.</p>
${intent ? `<a class="btn primary" href="${esc(intent)}">פתיחה באפליקציה</a>
<a class="btn" href="${esc(web)}">המשך בדפדפן</a>` : `<a class="btn primary" href="${esc(web)}">המשך בדפדפן</a>`}
<p class="meta">באפליקציה אפשר גם להקליד את הכתובת ואת הקוד במסך הכניסה.</p>`
    : `<h1>הקישור לא שלם</h1>
<p class="sub">חסר בו קוד צימוד. צריך קוד חדש ממסך המכשירים שבהגדרות, במכשיר שכבר מחובר.</p>`;
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<title>צימוד מכשיר</title>
<style>
  :root { color-scheme: light dark; --bg: #F7F7F5; --surface: #FFFFFF; --text: #1B1C1E; --text2: #5C6066; --line: #E3E3DF; --accent: #1B1C1E; --on-accent: #FFFFFF; }
  @media (prefers-color-scheme: dark) { :root { --bg: #141517; --surface: #1C1D20; --text: #ECECEA; --text2: #A6A9AE; --line: #2D2E32; --accent: #ECECEA; --on-accent: #141517; } }
  html, body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.5 Rubik, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 420px; margin: 0 auto; padding: 56px 24px 32px; }
  h1 { font-size: 28px; line-height: 34px; font-weight: 700; margin: 0 0 8px; }
  .sub { color: var(--text2); margin: 0 0 28px; }
  .code { font: 500 32px/1 ui-monospace, "Roboto Mono", monospace; letter-spacing: 4px; text-align: center; padding: 8px 0; }
  .meta { color: var(--text2); font-size: 14px; margin: 10px 0 28px; }
  .btn { display: flex; align-items: center; justify-content: center; height: 48px; box-sizing: border-box; text-decoration: none; font-weight: 700; font-size: 15px; border-radius: 10px; margin-bottom: 10px; color: var(--text); background: var(--surface); border: 1px solid var(--line); }
  .btn.primary { background: var(--accent); color: var(--on-accent); border-color: var(--accent); }
  .btn:focus-visible { outline: 2px solid var(--text); outline-offset: 2px; }
</style>
</head>
<body><main>
${body}
</main></body>
</html>
`;
}
