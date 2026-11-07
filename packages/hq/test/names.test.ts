// The names in texts come from org.yaml (names.ts): with the owner's org the texts are exactly today's
// (fixtures/names/ran.json, written by the code before names came from org.yaml); with another org,
// its names and its genders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_NAMES, loadNames, namesFromOrg, pre } from '@company/shared';
import { buildTools } from '../../mcp-company/src/tools.ts';
import { addNameStopWords, tokenize } from '../../mcp-company/src/l3.ts';
import { buildSystemPrompt } from '../src/system-prompt.ts';
import type { IdentityRow } from '../src/org.ts';
import { makeEnv, ORG_YAML } from './helpers.ts';

const RAN_ORG = `
version: 1
owner: ran
owner_name: רן
owner_gender: male
owner_language: he
manager: yoav
identities:
  - {id: yoav, name: יואב, title: מנהל החברה}
  - id: adi
    name: עדי
    automations: [{id: compose-home, enabled: true}]
`;

const DANA_ORG = `
version: 1
owner: dana
owner_name: דנה
owner_gender: female
owner_language: en
manager: mira
identities:
  - {id: mira, name: מירה, title: מנהלת החברה, gender: female}
  - id: tal
    name: טל
    automations: [{id: compose-home, enabled: true}]
`;

function company(org: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'names-'));
  mkdirSync(join(dir, 'projects'));
  writeFileSync(join(dir, 'org.yaml'), org);
  writeFileSync(join(dir, 'projects', 'agent-company.md'), '---\nproject: agent-company\nci_check: company-ci\n---\n\n# אמנה\n');
  return dir;
}

const base: IdentityRow = { id: '', name: '', title: '', symbol: '', team: null, team_kind: 'permanent', project: null, reports_to: null,
  lifecycle: 'resident', source: 'org', active: 1, data: '{}', updated_at: 0 };
const task = { ...base, team_kind: 'task', lifecycle: 'ephemeral', source: 'runtime' };
const eli = { ...base, id: 'eli', name: 'אלי', title: 'ראש הצוות האישי', team: 'personal', lifecycle: 'lead' };

/** Every text that names the owner or the manager, as a worker sees it. The company dir stays out of the snapshot. */
function texts(dir: string, managerId: string) {
  const head = (s: string) => s.split('\n\n---\n\n').slice(0, 2).join('\n\n---\n\n').replaceAll(dir, '<company>');
  return {
    plain: head(buildSystemPrompt(dir, { ...base, id: 'nobody', name: 'פלוני' }, managerId)),
    worker: head(buildSystemPrompt(dir, { ...task, id: 'agent-company-t7', name: 'דנה', title: 'מפתחת', project: 'agent-company', reports_to: 'adi' }, managerId)),
    helper: head(buildSystemPrompt(dir, { ...task, id: 'company-t9', name: 'איתי', title: 'עוזר אישי', reports_to: 'eli' }, managerId, eli)),
    tools: buildTools(loadNames(dir)),
  };
}

test("the owner's org: the system prompt and the MCP tool descriptions are exactly what they were", () => {
  const dir = company(RAN_ORG);
  try {
    const want = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'names', 'ran.json'), 'utf8'));
    assert.deepEqual(JSON.parse(JSON.stringify(texts(dir, 'yoav'))), want);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('another org: its names, its genders, none of ours', () => {
  const dir = company(DANA_ORG);
  try {
    const t = texts(dir, 'mira');
    const all = JSON.stringify(t);
    assert.doesNotMatch(all, /(?<![א-ת])(?:רן|יואב|עדי)(?![א-ת])|Ran/); // the ticket example hivecode-app/hive-code#11 stays (an example of the format)
    assert.match(t.plain, /in דנה's agent company\./);
    // Her language is English: the one language line, and no Hebrew writing rules.
    assert.match(t.plain, /\*\*Write every message to the owner in English\.\*\* דנה reads English/);
    assert.doesNotMatch(t.plain, /### Writing in Hebrew/);
    assert.match(t.plain, /### When דנה wrote to you \(`owner`\)/);
    assert.match(t.plain, /It shows up in her app as you write/);
    assert.match(t.plain, /\*\*Do not answer her with `tell`\.\*\* That way she gets the answer once/);
    assert.match(t.plain, /To anyone who is not דנה, answer only/);
    assert.match(t.plain, /Write to דנה with `tell` only when she did not just write to you: a task that finished, something she needs to know/);
    assert.doesNotMatch(t.plain, /\b(?:him|his)\b/);
    assert.match(t.worker, /in her words and in English, on what changed for her/);
    assert.match(t.worker, /The PR body in English\./);
    assert.match(t.worker, /and דנה needs to check something herself/);
    assert.match(t.helper, /A sign-in that needs דנה \(a code, 2FA, a QR\) is asked of her directly/);
    assert.match(t.helper, /submitting a form in her name/);
    const desc = (n: string) => t.tools.find((x) => x.name === n)!.description;
    assert.match(desc('ask'), /^Ask דנה or the manager a question\. She sees it as a message in her chat/);
    assert.match(desc('status'), /it is the line דנה sees/);
    assert.match(desc('close_team'), /the worker's manager or מירה\./);
    assert.match(desc('compose_home'), /^Compose the head of דנה's conversations screen: .* Only טל and מירה\./);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('names.ts: defaults, the manager and composer from their identities, prefixes', () => {
  assert.deepEqual(namesFromOrg({}), DEFAULT_NAMES);
  assert.deepEqual(namesFromOrg(null, 'boss').manager, { id: 'boss', name: DEFAULT_NAMES.manager.name, gender: 'male' });
  const n = namesFromOrg({ owner: 'x', owner_name: ' רון ', manager: 'm', teams: [{ id: 't', lead: { id: 'm', name: 'Alice', gender: 'female' } }] });
  assert.deepEqual(n.owner, { id: 'x', name: 'רון', gender: 'male' });
  assert.deepEqual(n.manager, { id: 'm', name: 'Alice', gender: 'female' });
  assert.equal(n.composer, undefined);
  assert.equal(pre('ל', 'רן'), 'לרן');
  assert.equal(pre('ל', 'Alice'), 'ל-Alice');
  assert.equal(pre('ו', pre('ל', 'Alice')), 'ול-Alice');
});

test("recall: the owner's name and id are stop words, from org.yaml", () => {
  const dir = company(DANA_ORG);
  try {
    assert.deepEqual(tokenize('דנה dana ביטוח'), ['דנה', 'dana', 'ביטוח']);
    addNameStopWords(dir);
    assert.deepEqual(tokenize('דנה dana ביטוח'), ['ביטוח']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("hq's messages: with the owner's org as today, with another org its names and genders", async () => {
  const org = ORG_YAML.replace('owner_name: רן\nowner_gender: male\n', 'owner_name: דנה\nowner_gender: female\n')
    .replace('{id: yoav, name: יואב,', '{id: yoav, name: מירה, gender: female,');
  for (const [o, want] of [[ORG_YAML, {
    label: 'רן', declined: 'רן סגר את השאלה בלי תשובה: לשלם?', done: 'רן סיים: ', reply: 'תשובה של רן על',
    manager: 'יואב החליט במקום רן', note: 'יואב החליט במקומך', escalation: 'not answered by רן', leave: 'leave it for רן.',
    toggle: 'שאלה חוסמת שלא נענתה עוברת ליואב',
  }], [org, {
    label: 'דנה', declined: 'דנה סגרה את השאלה בלי תשובה: לשלם?', done: 'דנה סיימה: ', reply: 'תשובה של דנה על',
    manager: 'מירה החליטה במקום דנה', note: 'מירה החליטה במקומך', escalation: 'not answered by דנה', leave: 'leave it for דנה.',
    toggle: 'שאלה חוסמת שלא נענתה עוברת למירה',
  }]] as const) {
    const env = await makeEnv({ org: o });
    try {
      const { hq, clock } = env;
      assert.equal(hq.mailbox.label('owner'), want.label);
      assert.equal(hq.store.toggles().find((t) => t.key === 'escalation')!.description, want.toggle);
      hq.mailbox.ask({ msg_id: 'ask-1', from: 'eli', question: 'לשלם?', headline: 'לשלם?', blocking: true, urgency: 'normal' });
      hq.mailbox.complete(hq.inbox.open().find((i) => i.ref === 'ask-1')!.id, { declined: true });
      assert.ok(hq.mailbox.list('eli').some((m) => m.body === want.declined), want.declined);
      const go = hq.inbox.add({ kind: 'go', title: 'פריסה', body: 'x', from_identity: 'eli', urgency: 'normal', ref: 'go-1' });
      hq.mailbox.complete(go.id);
      assert.ok(hq.mailbox.list('eli').some((m) => m.body.startsWith(want.done)), want.done);
      const q = hq.inbox.add({ kind: 'ask', title: 'שאלה', body: 'y', from_identity: 'eli', urgency: 'normal', ref: 'q-1' });
      hq.mailbox.reply(q.id, 'כן');
      assert.ok(hq.mailbox.list('eli').some((m) => m.body.startsWith(want.reply)), want.reply);

      const a = hq.mailbox.ask({ msg_id: 'ask-2', from: 'eli', question: 'לחדש?', blocking: true, urgency: 'normal' });
      clock.advance(11 * 60_000);
      hq.scheduler.escalateAsks();
      const esc = hq.mailbox.get('ask-2-escalation')!.body;
      assert.ok(esc.includes(want.escalation) && esc.includes(want.leave), esc);
      hq.mailbox.answer(a.id, 'כן', 'manager');
      assert.ok(hq.mailbox.get('ask-2-answer')!.body.startsWith(want.manager), hq.mailbox.get('ask-2-answer')!.body);
      assert.ok(hq.inbox.open().some((i) => i.kind === 'escalation_note' && i.title === want.note));
    } finally { await env.cleanup(); }
  }
});

test('a broken org.yaml keeps the last names that parsed', () => {
  const dir = company(DANA_ORG);
  try {
    assert.equal(loadNames(dir).owner.name, 'דנה');
    writeFileSync(join(dir, 'org.yaml'), 'owner: [unclosed\n');
    assert.equal(loadNames(dir).owner.name, 'דנה');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
