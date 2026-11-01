// task-1192: Codemagic's macOS minutes this month, read once a day; past 400, 800 and 1,500 he gets one message each.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv as make } from './helpers.ts';
import { byWorkflow, macMinutes, message, type Build, type CodemagicApi, type Usage } from '../src/codemagic-watch.ts';

const envs: Awaited<ReturnType<typeof make>>[] = [];
const makeEnv = async (...a: Parameters<typeof make>) => { const e = await make(...a); envs.push(e); return e; };
after(async () => { for (const e of envs) await e.cleanup(); });

const ORG = (on: boolean) => `
version: 1
owner: ran
owner_name: רן
owner_gender: male
manager: yoav
monitoring_lead: rotem
timezone: Asia/Jerusalem
teams:
  - {id: management, kind: permanent, symbol: account_tree, lead: yoav, members: []}
identities:
  - id: yoav
    name: יואב
    title: מנהל החברה
    symbol: explore
    team: management
    reports_to: ran
    lifecycle: always-on
    resident: true
    automations: []
  - id: asaf
    name: אסף
    title: תשתית
    symbol: rocket_launch
    team: management
    reports_to: yoav
    lifecycle: dormant
    automations:
      - {id: codemagic-minutes, what: דקות Codemagic, enabled: ${on}}
`;
const HOUR = 3_600_000;
const min = (m: number) => m * 60;

type State = { usage: Usage; builds: Build[]; fail?: boolean; reads: number };
function fakeApi(state: State): CodemagicApi {
  return {
    usage: async () => { state.reads++; if (state.fail) throw new Error('/user: HTTP 401'); return state.usage; },
    builds: async () => state.builds,
  };
}

// Oldest first (list() is newest first).
const ownerMsgs = (hq: any) => hq.mailbox.list('asaf').filter((m: any) => m.to_identity === 'owner').reverse();

test('סכום הדקות: רק macOS, והחינמיות לא נספרות בתשלום', () => {
  const u: Usage = { buildTime: { mac_mini_m2_free: min(500), mac_mini_m2_personal: min(320), linux_x2_paid: min(90) }, previous: {}, freeSeconds: min(500) };
  assert.deepEqual(macMinutes(u.buildTime), { total: 820, paid: 320 });
  const text = message(800, u.buildTime, u, [{ workflow: 'ios-check', minutes: 600, builds: 40 }], 0.095);
  assert.match(text, /עברו את 800 החודש: 820 דקות/);
  assert.match(text, /\$30\.40/);
  assert.match(text, /ההתראה הבאה ב-1,500/);
  assert.match(text, /- ios-check: 600 דקות \(40 בילדים\)/);
});

test('פילוח לפי workflow: מתחילת החודש, כל בילד מעוגל לדקה שלמה למעלה', () => {
  const since = Date.UTC(2026, 10, 1);
  const b = (workflow: string, start: string | null, end: string | null, instanceType = 'mac_mini_m2'): Build => ({ workflow, instanceType, startedAt: start, finishedAt: end });
  const rows = byWorkflow([
    b('ios-check', '2026-11-02T10:00:00Z', '2026-11-02T10:14:10Z'),
    b('ios-check', '2026-11-03T10:00:00Z', '2026-11-03T10:10:00Z'),
    b('ios-qa-sim', '2026-11-03T11:00:00Z', '2026-11-03T11:30:00Z'),
    b('ios-check', null, '2026-11-03T12:00:00Z'), // canceled before a Mac
    b('ios-testflight', '2026-10-31T23:50:00Z', '2026-11-01T00:05:00Z'), // last month's
    b('android', '2026-11-03T10:00:00Z', '2026-11-03T11:00:00Z', 'linux_x2'),
    b('ios-check', '2026-12-01T00:01:00Z', '2026-12-01T00:10:00Z'), // next month's
  ], since, Date.UTC(2026, 11, 1), Date.UTC(2026, 10, 4));
  assert.deepEqual(rows, [{ workflow: 'ios-qa-sim', minutes: 30, builds: 1 }, { workflow: 'ios-check', minutes: 25, builds: 2 }]);
});

test('עובר סף: הודעה אחת לרן מאסף; אותו סף לא פעמיים, הסף הבא כן', async () => {
  const { hq, clock } = await makeEnv({ org: ORG(true) });
  const st: State = { usage: { buildTime: { mac_mini_m2_free: min(390) }, previous: {}, freeSeconds: min(500) }, builds: [], reads: 0 };
  hq.codemagicWatch.api = fakeApi(st);
  await hq.codemagicWatch.sweep();
  assert.equal(st.reads, 1);
  assert.equal(ownerMsgs(hq).length, 0, 'מתחת ל-400');
  await hq.codemagicWatch.sweep();
  assert.equal(st.reads, 1, 'פעם ביום');

  clock.t += 24 * HOUR;
  st.usage = { buildTime: { mac_mini_m2_free: min(410) }, previous: {}, freeSeconds: min(500) };
  await hq.codemagicWatch.sweep();
  assert.equal(ownerMsgs(hq).length, 1);
  assert.match(ownerMsgs(hq)[0].body, /עוד אין עלות/);

  clock.t += 24 * HOUR;
  st.usage = { buildTime: { mac_mini_m2_free: min(450) }, previous: {}, freeSeconds: min(500) };
  await hq.codemagicWatch.sweep();
  assert.equal(ownerMsgs(hq).length, 1, '400 כבר נשלח החודש');

  clock.t += 24 * HOUR;
  st.usage = { buildTime: { mac_mini_m2_free: min(500), mac_mini_m2_personal: min(1100) }, previous: {}, freeSeconds: min(500) };
  await hq.codemagicWatch.sweep();
  const msgs = ownerMsgs(hq);
  assert.equal(msgs.length, 2, 'קפיצה מעל 800 ו-1,500 שולחת רק את הגבוה');
  assert.match(msgs.at(-1).body, /עברו את 1,500/);
  assert.match(msgs.at(-1).body, /זו ההתראה האחרונה/);
});

test('לפני 09:00 לא קוראים; כבוי לא קוראים', async () => {
  const { hq, clock } = await makeEnv({ org: ORG(false) });
  const st: State = { usage: { buildTime: { mac_mini_m2_free: min(900) }, previous: {}, freeSeconds: min(500) }, builds: [], reads: 0 };
  hq.codemagicWatch.api = fakeApi(st);
  await hq.codemagicWatch.sweep();
  assert.equal(st.reads, 0, 'כבוי');
  hq.store.setToggle('asaf/codemagic-minutes', true);
  clock.t = Date.UTC(2026, 10, 2, 5, 0); // 07:00 in Israel
  await hq.codemagicWatch.sweep();
  assert.equal(st.reads, 0, 'לפני 09:00');
  clock.t = Date.UTC(2026, 10, 2, 7, 30);
  await hq.codemagicWatch.sweep();
  assert.equal(st.reads, 1);
});

test('קריאה שנכשלת: אסף שומע פעם ביום, ומנסים שוב בסבב הבא', async () => {
  const { hq } = await makeEnv({ org: ORG(true) });
  const st: State = { usage: { buildTime: {}, previous: {}, freeSeconds: 0 }, builds: [], reads: 0, fail: true };
  hq.codemagicWatch.api = fakeApi(st);
  await hq.codemagicWatch.sweep();
  await hq.codemagicWatch.sweep();
  assert.equal(st.reads, 2);
  const toAsaf = hq.mailbox.list('asaf').filter((m: any) => m.to_identity === 'asaf' && /נכשלה/.test(m.body));
  assert.equal(toAsaf.length, 1);
});

test('חודש שעבר סף אחרי הבדיקה האחרונה שלו: נאמר ב-1 לחודש הבא, מ-previousPeriod, פעם אחת', async () => {
  const { hq, clock } = await makeEnv({ org: ORG(true) });
  clock.t = Date.UTC(2026, 9, 31, 7, 0); // 31/10, 09:00 בישראל אחרי מעבר השעון
  const st: State = { usage: { buildTime: { mac_mini_m2_free: min(790) }, previous: {}, freeSeconds: min(500) }, builds: [], reads: 0 };
  hq.codemagicWatch.api = fakeApi(st);
  await hq.codemagicWatch.sweep();
  assert.equal(ownerMsgs(hq).length, 1, '400 של אוקטובר');
  clock.t = Date.UTC(2026, 10, 1, 8, 0);
  st.usage = { buildTime: {}, previous: { mac_mini_m2_free: min(500), mac_mini_m2_personal: min(320) }, freeSeconds: min(500) };
  await hq.codemagicWatch.sweep();
  const msgs = ownerMsgs(hq);
  assert.equal(msgs.length, 2);
  assert.match(msgs.at(-1).body, /עברו את 800 בחודש שעבר/);
  assert.match(msgs.at(-1).body, /החודש הזה התחיל מאפס/);
  clock.t += 24 * HOUR;
  await hq.codemagicWatch.sweep();
  assert.equal(ownerMsgs(hq).length, 2, 'לא פעמיים');
});

test('חודש שלא נקרא אף פעם (לפני שהאוטומציה רצה) לא מדווח בתחילת החודש הבא', async () => {
  const { hq, clock } = await makeEnv({ org: ORG(true) });
  clock.t = Date.UTC(2026, 10, 1, 8, 0);
  const st: State = { usage: { buildTime: {}, previous: { mac_mini_m2_free: min(500), mac_mini_m2_personal: min(1489) }, freeSeconds: min(500) }, builds: [], reads: 0 };
  hq.codemagicWatch.api = fakeApi(st);
  await hq.codemagicWatch.sweep();
  assert.equal(st.reads, 1);
  assert.equal(ownerMsgs(hq).length, 0);
});
