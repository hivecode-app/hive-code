// task-297: a p0 task held back for memory for 10 minutes becomes one incident, with the top processes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './helpers.ts';

const ORG = `
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
      - {id: pressure-watch, what: משימה דחופה שמחכה בגלל זיכרון, enabled: true}
`;
const MIN = 60_000;
const NO_ROOM = { totalMb: 23_000, availableMb: 3_500 };

test('p0 שמחכה 10 דקות בגלל זיכרון: פריט אחד, עם שלושת התהליכים הגדולים', async () => {
  const env = await makeEnv({ org: ORG, noStart: false });
  const { hq, clock } = env;
  hq.scheduler.memInfo = () => NO_ROOM;
  hq.pressureWatch.topProcs = async () => [
    { pid: 11, rssMb: 7400, cmd: 'java GradleDaemon' }, { pid: 12, rssMb: 1300, cmd: 'java KotlinCompileDaemon' }, { pid: 13, rssMb: 900, cmd: 'node' }];
  hq.scheduler.addTask({ title: 'p0 דחופה', priority: 0, project: undefined });
  await hq.pressureWatch.sweep();
  clock.t += 9 * MIN;
  await hq.pressureWatch.sweep();
  assert.equal(hq.inbox.open().filter((i) => i.kind === 'incident').length, 0);
  clock.t += 2 * MIN;
  await hq.pressureWatch.sweep();
  await hq.pressureWatch.sweep();
  const items = hq.inbox.open().filter((i) => i.kind === 'incident');
  assert.equal(items.length, 1);
  assert.match(items[0]!.body, /GradleDaemon/);
  assert.match(items[0]!.body, /KotlinCompileDaemon/);
  assert.match(items[0]!.body, /3\.4GB/);
});

test('משימה רגילה (לא p0) או כשיש מקום: אין פריט', async () => {
  const env = await makeEnv({ org: ORG, noStart: false });
  const { hq, clock } = env;
  hq.pressureWatch.topProcs = async () => [];
  hq.scheduler.memInfo = () => NO_ROOM;
  hq.scheduler.addTask({ title: 'רגילה', priority: 2 });
  await hq.pressureWatch.sweep();
  clock.t += 20 * MIN;
  await hq.pressureWatch.sweep();
  assert.equal(hq.inbox.open().filter((i) => i.kind === 'incident').length, 0);
});

test('p0 כשיש מקום: אין פריט, והשעון מתנקה כשהלחץ יורד', async () => {
  const env = await makeEnv({ org: ORG, noStart: false });
  const { hq, clock } = env;
  hq.pressureWatch.topProcs = async () => [];
  hq.scheduler.memInfo = () => NO_ROOM;
  hq.scheduler.addTask({ title: 'p0', priority: 0 });
  await hq.pressureWatch.sweep();
  assert.ok(hq.store.db.prepare(`SELECT 1 FROM meta WHERE key LIKE 'pressure_watch.%'`).get());
  hq.scheduler.memInfo = () => ({ totalMb: 23_000, availableMb: 19_000 });
  clock.t += 20 * MIN;
  await hq.pressureWatch.sweep();
  assert.equal(hq.store.db.prepare(`SELECT 1 FROM meta WHERE key LIKE 'pressure_watch.%'`).get(), undefined);
  assert.equal(hq.inbox.open().filter((i) => i.kind === 'incident').length, 0);
});

test('האוטומציה כבויה: אין שעון ואין פריט', async () => {
  const env = await makeEnv({ org: ORG, noStart: false });
  const { hq, clock } = env;
  hq.pressureWatch.topProcs = async () => [];
  hq.scheduler.memInfo = () => NO_ROOM;
  hq.store.setToggle('yoav/pressure-watch', false);
  hq.scheduler.addTask({ title: 'p0', priority: 0 });
  await hq.pressureWatch.sweep();
  clock.t += 20 * MIN;
  await hq.pressureWatch.sweep();
  assert.equal(hq.inbox.open().filter((i) => i.kind === 'incident').length, 0);
});
