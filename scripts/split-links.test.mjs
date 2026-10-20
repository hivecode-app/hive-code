import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rewriteLinks } from './split-links.mjs';

test('links from the company into the engine become GitHub links; the company\'s own links and code stay', () => {
  const dir = mkdtempSync(join(tmpdir(), 'split-links-'));
  try {
    const engine = join(dir, 'engine'), co = join(dir, 'co');
    for (const p of ['docs/generic', 'company/projects']) mkdirSync(join(engine, p), { recursive: true });
    writeFileSync(join(engine, 'docs/SPEC.md'), '#');
    writeFileSync(join(engine, 'docs/generic/PLAN מוצר.md'), '#');
    mkdirSync(join(co, 'company/projects'), { recursive: true });
    mkdirSync(join(co, 'memory'), { recursive: true });
    writeFileSync(join(co, 'memory/INDEX.md'), '#');
    const file = join(co, 'company/projects/p.md');
    const text = [
      'see [SPEC](../../docs/SPEC.md#b-5) and [plan](../../docs/generic/PLAN%20מוצר.md "the plan")',
      'own: [index](../../memory/INDEX.md), [web](https://x.example), [anchor](#here), [gone](../../nothing.md)',
      '`[code](../../docs/SPEC.md)`', '```', '[fenced](../../docs/SPEC.md)', '```',
    ].join('\n');
    const r = rewriteLinks(text, file, co, engine, 'o/engine');
    assert.deepEqual(r.changed.map(([a]) => a), ['../../docs/SPEC.md#b-5', '../../docs/generic/PLAN%20מוצר.md']);
    assert.match(r.text, /\[SPEC\]\(https:\/\/github\.com\/o\/engine\/blob\/main\/docs\/SPEC\.md#b-5\)/);
    assert.ok(r.text.includes(`(https://github.com/o/engine/blob/main/docs/generic/${encodeURIComponent('PLAN מוצר.md')} "the plan")`));
    assert.ok(r.text.includes('[index](../../memory/INDEX.md)'));
    assert.ok(r.text.includes('[gone](../../nothing.md)'), 'not in the engine either: left for check-contract to report');
    assert.ok(r.text.includes('`[code](../../docs/SPEC.md)`') && r.text.includes('[fenced](../../docs/SPEC.md)'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
