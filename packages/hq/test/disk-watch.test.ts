// task-382: the disk at 85% is cleaned at once; at 92% after the cleaning it becomes one urgent item with the biggest consumers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './helpers.ts';
import { parseConsumers, parseBytes, type Machine } from '../src/disk-watch.ts';

const ORG = (on: boolean) => `
version: 1
owner: ran
owner_name: רן
owner_gender: male
manager: yoav
monitoring_lead: rotem
timezone: Asia/Bangkok
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
    automations:
      - {id: disk-watch, what: דיסק מלא, enabled: ${on}}
`;
const MIN = 60_000;

function fake(name: string, pcts: number[], log: string[]): Machine {
  let i = 0;
  return {
    name,
    usage: async () => ({ pct: pcts[Math.min(i, pcts.length - 1)]!, freeMb: 900 }),
    clean: async (closed) => { log.push(`clean ${name} closed=${closed.join(',')}`); i++; return { freed: 5 * 1024 ** 3, steps: [] }; },
    consumers: async () => [{ name: 'docker images', bytes: 55 * 1024 ** 3 }, { name: '/tmp', bytes: 7 * 1024 ** 3 }],
  };
}

test('מתחת ל-85%: לא נוגעים בכלום', async () => {
  const { hq } = await makeEnv({ org: ORG(true), noStart: false });
  const log: string[] = [];
  hq.diskWatch.machines = () => [fake('local', [84], log)];
  await hq.diskWatch.sweep();
  assert.deepEqual(log, []);
  assert.equal(hq.inbox.open().filter((i) => i.kind === 'incident').length, 0);
});

test('85%: ניקוי מיידי, ואם ירד אין פריט; לא יותר מפעם ב-30 דקות', async () => {
  const { hq, clock } = await makeEnv({ org: ORG(true), noStart: false });
  const log: string[] = [];
  hq.diskWatch.machines = () => [fake('local', [88, 70, 88, 88], log)];
  await hq.diskWatch.sweep();
  assert.equal(log.length, 1);
  assert.equal(hq.inbox.open().filter((i) => i.kind === 'incident').length, 0);
  clock.t += 5 * MIN;
  await hq.diskWatch.sweep();
  assert.equal(log.length, 1, 'עוד לא עברו 30 דקות');
  clock.t += 30 * MIN;
  await hq.diskWatch.sweep();
  assert.equal(log.length, 2);
});

test('92% גם אחרי הניקוי: פריט דחוף אחד עם הצרכנים הגדולים, לא כפול', async () => {
  const { hq, clock } = await makeEnv({ org: ORG(true), noStart: false });
  const log: string[] = [];
  hq.diskWatch.machines = () => [fake('local', [96, 94], log)];
  await hq.diskWatch.sweep();
  clock.t += 5 * MIN;
  await hq.diskWatch.sweep();
  const items = hq.inbox.open().filter((i) => i.kind === 'incident');
  assert.equal(items.length, 1);
  assert.equal(items[0]!.urgency, 'urgent');
  assert.match(items[0]!.title, /94%/);
  assert.match(items[0]!.body, /55\.0GB · docker images/);
});

test('כבוי: לא קוראים ולא מנקים', async () => {
  const { hq } = await makeEnv({ org: ORG(false), noStart: false });
  const log: string[] = [];
  hq.diskWatch.machines = () => [fake('local', [99], log)];
  await hq.diskWatch.sweep();
  assert.deepEqual(log, []);
});

test('צומת שלא עונה לא מפיל את הבדיקה של השאר', async () => {
  const { hq } = await makeEnv({ org: ORG(true), noStart: false });
  const log: string[] = [];
  const dead: Machine = { name: 'n2', usage: async () => { throw new Error('down'); }, clean: async () => { throw new Error(); }, consumers: async () => [] };
  hq.diskWatch.machines = () => [dead, fake('local', [90, 60], log)];
  await hq.diskWatch.sweep();
  assert.equal(log.length, 1);
});

test('parseConsumers: du ו-docker, הגדול קודם', () => {
  const rows = parseConsumers('2048\t/tmp\n10\t/home/x/.cache\ndocker\tImages\t55.2GB\ndocker\tBuild Cache\t43GB\n');
  assert.deepEqual(rows.map((r) => r.name), ['docker images', 'docker build cache', '/tmp', '/home/x/.cache']);
  assert.equal(parseBytes('512MB'), 512 * 1024 ** 2);
});

test('צומת ב-93%: הניקוי והפריט על שמו, וניקוי שנכשל נאמר בגוף הפריט', async () => {
  const { hq } = await makeEnv({ org: ORG(true), noStart: false });
  const m = fake('n2', [93], []);
  m.clean = async () => { throw new Error('boom'); };
  hq.diskWatch.machines = () => [m];
  await hq.diskWatch.sweep();
  await hq.diskWatch.sweep();
  const items = hq.inbox.open().filter((i) => i.kind === 'incident');
  assert.equal(items.length, 1);
  assert.match(items[0]!.title, /n2/);
  assert.match(items[0]!.body, /נכשל/);
});

test('remoteMachine: df, והניקוי עם רשימה ב-quoting', async () => {
  const { remoteMachine } = await import('../src/disk-watch.ts');
  const cmds: string[] = [];
  const r = remoteMachine('n2', async (c) => { cmds.push(c); return c.startsWith('df') ? '94% 812M\n' : '{"freed":1,"steps":[]}\n'; });
  assert.deepEqual(await r.usage(), { pct: 94, freeMb: 812 });
  await r.clean([3, 7]);
  assert.match(cmds[1]!, /--closed-tasks '3,7'/);
});
