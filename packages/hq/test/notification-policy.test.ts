import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
import { ownerSystemCopy } from '../src/system-copy.ts';
import { alertLevel, Conversations, type MessageLike } from '../src/conversations.ts';
import { notificationCounts } from '../src/company-day.ts';
import { ownerCompletions } from '../src/owner-completions.ts';
import { pushWorthy } from '../src/inbox.ts';
import { goHeadline } from '../src/ingest.ts';
import { Store } from '../src/store.ts';
import { makeEnv } from './helpers.ts';

const base: MessageLike = { id: 'm', from_identity: 'eli', to_identity: 'owner', kind: 'tell', body: 'מוכן', created_at: 1 };
const toggles = { push: true, focus: false, night: false };

test('policy table: intent, ten minutes, urgency, screen, mute, quiet modes and non-messages', () => {
  const cases: [Partial<MessageLike>, Parameters<typeof alertLevel>[1], Partial<typeof toggles>, string][] = [
    [{}, {}, {}, 'sound'], [{ id: 'owner-reply' }, {}, {}, 'sound'],
    [{ alert_hint: 'fyi' }, {}, {}, 'badge'], [{ alert_hint: 'eta' }, {}, {}, 'silent'],
    [{}, { last_sound_at: 120_000 }, {}, 'silent'], [{}, { last_sound_at: 0 }, {}, 'sound'],
    [{ priority: 'now', alert_hint: 'fyi' }, { last_sound_at: 120_000 }, { focus: true, night: true }, 'sound'],
    [{}, {}, { night: true }, 'badge'], [{}, {}, { focus: true }, 'badge'],
    [{}, { on_screen: true }, {}, 'none'], [{ priority: 'now' }, { muted_until: 900_000 }, {}, 'badge'],
    [{}, {}, { push: false }, 'badge'], [{ kind: 'system' }, {}, {}, 'none'],
    [{ kind: 'note' }, {}, {}, 'none'], [{ to_identity: 'rotem' }, {}, {}, 'none'],
  ];
  for (const [message, conv, settings, expected] of cases) {
    assert.equal(alertLevel({ ...base, ...message }, conv, { ...toggles, ...settings }, 660_000), expected, JSON.stringify([message, conv, settings]));
  }
});

test('durable 20-second window: coalesced latest id, silent follow-up, urgent bypass, read cancellation and metrics', () => {
  let now = 1_000_000;
  const store = new Store(':memory:', { now: () => now });
  try {
    const convs = new Conversations(store, (id) => id);
    const sent: any[] = []; convs.setAlert((a) => sent.push(a));
    const put = (id: string, extra = {}) => store.emit('message.new', 'owner', { ...base, id, created_at: now, ...extra });
    put('first'); now += 5000; put('link'); now += 19_999; convs.flush(); assert.equal(sent.length, 0);
    now++; convs.flush(); assert.equal(sent.length, 1); assert.equal(sent[0].message, 'link'); assert.equal(sent[0].level, 'sound');
    put('later'); now += 25_000; convs.flush(); assert.equal(sent.length, 2); assert.equal(sent[1].level, 'silent');
    put('urgent', { priority: 'now' }); assert.equal(sent.length, 3); assert.equal(sent[2].level, 'sound');
    put('badge', { alert_hint: 'fyi' }); assert.equal(sent.length, 3);
    assert.deepEqual(notificationCounts(store, 0), { sound: 2, silent: 1, badge: 1 });
    put('read'); convs.markRead('eli'); now += 20_000; convs.flush(); assert.equal(sent.length, 3);
    // A new Conversations instance replays a pending window after hq restarts.
    put('restart'); now += 20_000;
    const resumed = new Conversations(store, (id) => id); resumed.setAlert((a) => sent.push(a)); resumed.flush();
    assert.equal(sent.at(-1).message, 'restart');
  } finally { store.close(); }
});

test('check card is silent after the task worker reported, including across chats', async () => {
  const env = await makeEnv();
  try {
    const { hq, clock } = env;
    hq.mailbox.tell({ from: 'eli', to: 'owner', body: 'התיקון מוכן' });
    clock.advance(30_000); hq.conversations.flush();
    assert.equal(hq.conversations.soundedRecently('eli'), true);
    const task = hq.scheduler.addTask({ title: 'תיקון', identity: 'eli' });
    hq.awaiting.onCard?.({ ...task, awaiting: 'check', summary: null, awaiting_note: null, awaiting_at: clock.t, pr: null, project: task.project }, 99, 'rotem');
    clock.advance(20_000); hq.conversations.flush();
    const alerts = hq.store.eventsAfter(0, 1000).filter((e) => e.type === 'conv.alert');
    assert.equal((alerts.at(-1)!.data as any).level, 'silent');
    assert.equal((alerts.at(-1)!.data as any).identity, 'rotem');
  } finally { await env.cleanup(); }
});

test('requested completion: ten minutes, opener reports, check cards, opt-in and duplicate sweeps', async () => {
  const env = await makeEnv();
  try {
    const { hq, clock } = env;
    hq.store.setToggle('scheduler', false);
    const task = (extra = {}) => {
      const t = hq.scheduler.addTask({ title: 'תיקון', for_owner: true, labels: ['opened-by:rotem'], ...extra });
      hq.store.db.prepare("UPDATE tasks SET state = 'done', summary = 'התמונות עולות', owner_done_at = ? WHERE id = ?").run(clock.t, t.id);
      return t;
    };
    const t = task(); const reported = task(); const check = task(); const other = task({ for_owner: false });
    hq.store.db.prepare("UPDATE tasks SET awaiting = 'verify' WHERE id = ?").run(check.id);
    clock.advance(5 * 60_000); hq.mailbox.tell({ from: 'rotem', to: 'owner', body: 'מוכן' });
    // The opener's report suppresses all its completions in this window.
    clock.advance(5 * 60_000); ownerCompletions(hq.store, hq.mailbox);
    assert.equal(hq.mailbox.get(`task-${reported.id}-owner-complete`), undefined);
    assert.equal(hq.mailbox.get(`task-${check.id}-owner-complete`), undefined);
    assert.equal(hq.mailbox.get(`task-${other.id}-owner-complete`), undefined);
    clock.advance(60_000); const fresh = task();
    clock.advance(9 * 60_000); ownerCompletions(hq.store, hq.mailbox);
    assert.equal(hq.mailbox.get(`task-${fresh.id}-owner-complete`), undefined);
    clock.advance(60_000); ownerCompletions(hq.store, hq.mailbox); ownerCompletions(hq.store, hq.mailbox);
    assert.equal(hq.mailbox.get(`task-${fresh.id}-owner-complete`)?.body, 'הסתיים: התמונות עולות');
    assert.equal(hq.mailbox.get(`task-${fresh.id}-owner-complete`)?.ref, `task-${fresh.id}`);
    assert.equal(hq.mailbox.get(`task-${t.id}-owner-complete`), undefined);
  } finally { await env.cleanup(); }
});

test('inbox quiet modes preserve emergencies and keep ordinary GO silent', () => {
  for (const [focus, night] of [[true, false], [false, true], [true, true], [false, false]]) {
    assert.equal(pushWorthy({ kind: 'go', blocking: true, urgency: 'urgent' }, focus!, 'yoav', night), !focus && !night);
    assert.equal(pushWorthy({ kind: 'incident', ref: 'accounts-all-full', blocking: true, urgency: 'urgent' }, focus!, 'yoav', night), true);
    assert.equal(pushWorthy({ kind: 'shift_failure', from_identity: 'yoav', blocking: true, urgency: 'urgent' }, focus!, 'yoav', night), true);
  }
});

test('GO action titles and worker notification instructions', () => {
  assert.equal(goHeadline('release', 'עדכון התמונות'), 'לשחרר עדכון התמונות?');
  assert.equal(goHeadline('release', 'photo fix'), 'Release photo fix?');
  assert.equal(goHeadline(undefined, 'העדכון'), 'לפרוס העדכון?');
  const prompt = readFileSync(new URL('../src/system-prompt.ts', import.meta.url), 'utf8');
  for (const text of ['הודעה אחת, לא שתיים', 'for_owner: true', 'באדג׳ בלבד', 'eta_done', 'שולחים `tell`']) assert.ok(prompt.includes(text), text);
});

test('owner system lines omit routing keys and machines while retaining structured references', async () => {
  const env = await makeEnv();
  try {
    for (const body of ['ההודעה msg_id m-abcd לא נמסרה ב-hq-host', 'העבודה agent-company-t123-1 ב-ci-host נעצרה', 'הבדיקה על branch: feature/example הסתיימה', 'הבדיקה על ענף: feature/example הסתיימה']) {
      const m = env.hq.mailbox.tell({ from: 'hq', to: 'owner', kind: 'system', body, ref: 'task-123' });
      assert.doesNotMatch(m.body, /t\d+|msg_id|hq-host|ci-host|feature\/example/);
      assert.equal(m.ref, 'task-123');
    }
  } finally { await env.cleanup(); }
});

test('open_team persists for_owner and the task-done hook starts the completion delay once', async () => {
  const env = await makeEnv();
  try {
    const { hq, clock } = env; hq.store.setToggle('scheduler', false);
    const ack = hq.ingest.op({v:1,id:'requested-team',identity:'eli',shift:'eli-1',sessionId:null,ts:new Date().toISOString(),op:'open_team',args:{name:'תיקון התמונות',purpose:'להשלים ולבדוק',project:'agent-company',for_owner:true}});
    const id = (ack.result as {task:number}).task;
    assert.equal(hq.scheduler.task(id)!.for_owner,1);
    hq.store.db.prepare("UPDATE tasks SET summary = 'התמונות עולות' WHERE id = ?").run(id);
    hq.scheduler.setTaskState(id,'done'); const first = hq.scheduler.task(id)!.owner_done_at;
    clock.advance(1000); hq.scheduler.setTaskState(id,'done'); assert.equal(hq.scheduler.task(id)!.owner_done_at,first);
    clock.advance(10*60_000); ownerCompletions(hq.store,hq.mailbox);
    assert.equal(hq.mailbox.get(`task-${id}-owner-complete`)?.body,'הסתיים: התמונות עולות');
  } finally { await env.cleanup(); }
});

test('urgent Telegram survives focus and night when the app is offline', async () => {
  for (const toggle of ['focus','night']) {
    const env = await makeEnv();
    try {
      env.hq.store.setToggle(toggle,true);
      env.hq.mailbox.tell({msg_id:`urgent-${toggle}`,from:'eli',to:'owner',priority:'now',body:'המערכת נפלה'});
      await env.hq.pusher.sweepUnacked();
      assert.equal(env.telegrams.length,1,toggle);
      await env.hq.pusher.sweepUnacked(); assert.equal(env.telegrams.length,1,'one urgent Telegram');
    } finally { await env.cleanup(); }
  }
});

test('unhandled asks, GO and login alert once when quiet mode ends', async () => {
  for (const toggle of ['focus','night']) {
    const env = await makeEnv();
    try {
      const { hq } = env; hq.store.setToggle(toggle,true);
      hq.pusher.subscribe({endpoint:'https://push.example/quiet',keys:{p256dh:'p',auth:'a'}});
      for (const kind of ['ask','go','login'] as const) hq.inbox.add({kind,from_identity:'eli',title:'מחכה להחלטה',blocking:true});
      const acked = hq.inbox.add({kind:'go',from_identity:'eli',title:'כבר ראית',blocking:true}); hq.inbox.ack(acked.id);
      await hq.pusher.sweepUnacked();assert.equal(env.webPushes.length,0);
      hq.store.setToggle(toggle,false);await hq.pusher.sweepUnacked();assert.equal(env.webPushes.length,3,toggle);
      await hq.pusher.sweepUnacked();assert.equal(env.webPushes.length,3,'no replay');
    } finally { await env.cleanup(); }
  }
});


test('system copy preserves natural branch wording and scans all system-message templates', () => {
  assert.equal(ownerSystemCopy('הענף הראשי נמחק',id=>id),'הענף הראשי נמחק');
  const source = new URL('../src/',import.meta.url);
  let templates = 0;
  const scan = (dir: URL) => {
    for (const entry of readdirSync(dir,{withFileTypes:true})) {
      const url = new URL(entry.name+(entry.isDirectory()?'/':''),dir);
      if(entry.isDirectory()) { scan(url); continue; }
      if(!entry.name.endsWith('.ts')) continue;
      const ast=ts.createSourceFile(url.pathname,readFileSync(url,'utf8'),ts.ScriptTarget.Latest,true);
      const visit=(node: ts.Node) => {
        if(ts.isObjectLiteralExpression(node)) {
          const props=node.properties.filter(ts.isPropertyAssignment);
          const kind=props.find(p=>p.name.getText(ast)==='kind');
          const body=props.find(p=>p.name.getText(ast)==='body');
          if(kind && body && kind.initializer.getText(ast)==="'system'") {
            templates++;
            const fragments:string[]=[];
            const collect=(part: ts.Node) => {
              if(ts.isStringLiteralLike(part)) fragments.push(part.text);
              if(ts.isTemplateExpression(part)) {
                fragments.push(part.head.text);
                for(const span of part.templateSpans) fragments.push('agent-company-t123',span.literal.text);
                return;
              }
              ts.forEachChild(part,collect);
            };
            collect(body.initializer);
            const text=ownerSystemCopy(fragments.join(' '),id=>id);
            assert.doesNotMatch(text,/t\d+|msg_id|hq-host|ci-host/,url.pathname);
          }
        }
        ts.forEachChild(node,visit);
      };visit(ast);
    }
  };scan(source);assert.ok(templates>=30,`scanned ${templates} system-message templates`);
});

test('a previously pushed GO waits quietly on Telegram until focus ends', async () => {
  const env=await makeEnv();
  try {
    const {hq,clock}=env;hq.auth.link('phone',1);
    const item=hq.inbox.add({kind:'go',from_identity:'eli',title:'שחרור',blocking:true});
    await new Promise(r=>setTimeout(r,20));assert.ok(hq.inbox.get(item.id)!.pushed_at);
    hq.store.setToggle('focus',true);hq.auth.link('phone',-1);clock.advance(20*60_000);
    await hq.pusher.sweepUnacked();assert.equal(env.telegrams.length,0);
    hq.store.setToggle('focus',false);await hq.pusher.sweepUnacked();assert.equal(env.telegrams.length,1);
  } finally {await env.cleanup();}
});
