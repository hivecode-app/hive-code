// #121: one time zone, org.yaml `timezone`. Changing it moves the night, the home screen's morning,
// the hours hq writes and what the app is told, without a restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeEnv, ORG_YAML, until } from './helpers.ts';
import { buildRoutes } from '../src/api.ts';
import { FALLBACK_TIME_ZONE, readTimeZone } from '../src/timezone.ts';

const org = (tz: string | null) => `${ORG_YAML}${tz ? `timezone: ${tz}\n` : ''}`;

test('changing timezone in org.yaml changes the night, the home morning, the hours and /api/board', async () => {
  const env = await makeEnv({ org: org('Asia/Jerusalem') });
  try {
    const { hq, clock, cfg } = env;
    const setTz = (tz: string | null) => writeFileSync(join(cfg.companyDir, 'org.yaml'), org(tz));
    const boardTz = () => {
      const [, , h] = buildRoutes(hq).find(([m, re]) => m === 'GET' && re.test('/api/board'))!;
      return (h({} as never) as { timezone: unknown }).timezone;
    };

    clock.t = Date.UTC(2026, 9, 20, 20, 0); // 23:00 Jerusalem (UTC+3), 03:00 Bangkok (UTC+7)
    assert.equal(hq.timeZone(), 'Asia/Jerusalem');
    assert.deepEqual(boardTz(), { name: 'Asia/Jerusalem', offset_min: 180 });
    hq.mailbox.tell({ msg_id: 'n-1', to: 'yoav', body: 'לילה עד 7' });
    await until(() => !!hq.night.current());
    assert.equal(hq.night.current()!.until_at, Date.UTC(2026, 9, 21, 4, 0), '07:00 Jerusalem');
    assert.equal(hq.home.quiet(), true);
    hq.night.end('test');

    setTz('Asia/Bangkok');
    assert.equal(hq.timeZone(), 'Asia/Bangkok', 'read live, no restart');
    assert.deepEqual(boardTz(), { name: 'Asia/Bangkok', offset_min: 420 });
    hq.mailbox.tell({ msg_id: 'n-2', to: 'yoav', body: 'לילה עד 7' });
    await until(() => !!hq.night.current());
    const night = hq.night.current()!;
    assert.equal(night.until_at, Date.UTC(2026, 9, 21, 0, 0), '07:00 Bangkok');
    // Home's morning (07:00) moves with it: 23:59 UTC is 06:59 in Bangkok, but 02:59 in Jerusalem.
    clock.t = Date.UTC(2026, 9, 20, 23, 59);
    assert.equal(hq.home.quiet(), true);
    clock.t = Date.UTC(2026, 9, 21, 0, 0);
    assert.equal(hq.home.quiet(), false, '07:00 in Bangkok');
    // The morning summary writes Bangkok hours: started 03:00, ended 07:00.
    assert.match(hq.night.end('test')!.text, /לילה 03:00 עד 07:00/);
  } finally { await env.cleanup(); }
});

test('org.yaml without a valid timezone: UTC, never the machine zone', async () => {
  const env = await makeEnv({ org: org('Mars/Olympus') });
  try {
    assert.equal(readTimeZone(env.cfg.companyDir), FALLBACK_TIME_ZONE);
    writeFileSync(join(env.cfg.companyDir, 'org.yaml'), org(null));
    assert.equal(env.hq.timeZone(), 'UTC');
    assert.deepEqual(env.hq.clock(), { name: 'UTC', offset_min: 0 });
  } finally { await env.cleanup(); }
});
