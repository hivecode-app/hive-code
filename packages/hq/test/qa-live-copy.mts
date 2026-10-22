// QA sandbox on a copy of the live hq.db, not a test: the app's web build sees the company as it is now,
// on 127.0.0.1:7499 (through tool/qa/serve.mjs). The copy is opened by qa-isolate.ts: nothing here reaches a
// live shift, checkout, account or gh. Not on the machine that runs the live hq (עדי, 21/10): in a separate
// container only.
// Run: node packages/hq/test/qa-live-copy.mts [live hq.db]
//   QA_PAIR=<n>  pairing codes to print (one per browser profile), default 1
//   COMPANY_HOME the company's checkout to read org.yaml from (its tones, names), default this repo's company/
//   QA_QUIET=1   nothing waits for him: open questions and inbox items in the copy are closed (the quiet home)
//   QA_HEADLINE  the latest recipe's headline says this, composed a minute ago over a GO that is answered now, so
//                the home shows the live sentence instead (the 21/10 copy said "GO קטן אחד מחכה לך" over nothing)
//   QA_HEADLINE_FRESH=1  composed after that instead: the headline holds
//   QA_ASK=1     also a question from adi with options, so "מחכה לך" shows (docs/design/audit.md)
//   QA_ASK=2     and a second one, from dana, so two things wait (the mockup of company-engine#37)
//   QA_UNTIL=<id>:<seq>,…  each worker's conversation as it was at that event: its later events and messages are
//                dropped, so a moment from its history is the last thing on screen (the tool details mockup, task 281)
//   QA_REOPEN=220,213  these inbox items (a GO, a question) open again, as they were before he answered: real
//                decisions for the decisions queue mockup (task 286), when fewer than enough wait right now
//   QA_OWNER_LAST=1  three lines he "wrote" last, for the conversations mockup (company-engine#37): to
//                matan still queued, to noga delivered and not read yet, to eli read. A fixture, said so beside the shots
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { startApi } from '../src/api.ts';
import { openIsolatedCopy } from './qa-isolate.ts';

const live = process.argv[2] ?? join(homedir(), '.local/state/agent-company/hq.db');
const { env, close } = await openIsolatedCopy(live, {
  companyDir: process.env.COMPANY_HOME ? join(process.env.COMPANY_HOME, 'company') : resolve(import.meta.dirname, '../../../company'),
  realTime: true,
  prepare: (db) => {
    if (process.env.QA_HEADLINE) {
      const row = db.prepare('SELECT version, blocks FROM home_recipes ORDER BY version DESC LIMIT 1').get() as { version: number; blocks: string } | undefined;
      const blocks = [{ type: 'headline', text: process.env.QA_HEADLINE }, ...(row ? (JSON.parse(row.blocks) as { type: string }[]).filter((b) => b.type !== 'headline') : [])];
      const at = Date.now() + (process.env.QA_HEADLINE_FRESH ? 60_000 : -60_000);
      if (row) db.prepare('UPDATE home_recipes SET blocks = ?, composed_at = ?, composed_by = ? WHERE version = ?').run(JSON.stringify(blocks), at, 'adi', row.version);
      else db.prepare('INSERT INTO home_recipes (composed_by, composed_at, reason, blocks) VALUES (?, ?, NULL, ?)').run('adi', at, JSON.stringify(blocks));
      // The 21/10 story: a GO came in, the headline was composed over it, then he answered it.
      if (!process.env.QA_HEADLINE_FRESH) {
        db.prepare(`INSERT INTO inbox (kind, title, from_identity, blocking, state, created_at, resolved_at) VALUES ('go', 'GO קטן', 'adi', 1, 'resolved', ?, ?)`).run(at - 60_000, Date.now());
      }
    }
    for (const pair of (process.env.QA_UNTIL ?? '').split(',').filter(Boolean)) {
      const [id, seq] = pair.split(':');
      const at = (db.prepare('SELECT ts FROM events WHERE seq = ?').get(Number(seq)) as { ts: number } | undefined)?.ts;
      if (!id || !at) throw new Error(`QA_UNTIL: no event ${pair}`);
      db.prepare('DELETE FROM events WHERE identity = ? AND seq > ?').run(id, Number(seq));
      db.prepare('DELETE FROM messages WHERE (from_identity = ? OR to_identity = ?) AND created_at > ?').run(id, id, at);
    }
    if (process.env.QA_OWNER_LAST) {
      const add = db.prepare(`INSERT INTO messages (id, from_identity, to_identity, kind, body, urgency, priority, state, attempts, created_at, delivered_at)
        VALUES (?, 'owner', ?, 'tell', ?, 'normal', 'next', ?, ?, ?, ?)`);
      const t = Date.now();
      add.run('qa-owner-queued', 'matan', 'מצאת מה שולח לי את ההתראות?', 'queued', 0, t - 1 * 60_000, null);
      add.run('qa-owner-delivered', 'noga', 'תודה. אפשר לקבל את הטבלה המלאה?', 'delivered', 1, t - 2 * 60_000, t - 2 * 60_000);
      add.run('qa-owner-seen', 'eli', 'הזמנתי, תודה', 'seen', 1, t - 3 * 60_000, t - 3 * 60_000);
    }
    if (process.env.QA_REOPEN) {
      for (const id of process.env.QA_REOPEN.split(',').map(Number)) {
        const row = db.prepare('SELECT kind, ref FROM inbox WHERE id = ?').get(id) as { kind: string; ref: string | null } | undefined;
        if (!row) continue;
        db.prepare("UPDATE inbox SET state = 'open', resolved_at = NULL WHERE id = ?").run(id);
        if (row.kind === 'ask' && row.ref) db.prepare("UPDATE asks SET state = 'open', answer = NULL, answered_by = NULL, answered_at = NULL WHERE id = ?").run(row.ref);
      }
    }
    if (process.env.QA_QUIET) {
      db.exec(`UPDATE asks SET state = 'cancelled' WHERE state IN ('open', 'escalated'); UPDATE inbox SET state = 'dismissed', resolved_at = ${Date.now()} WHERE state = 'open'`);
    }
  },
});
const api = await startApi(env.hq, 'qa-admin-token', '127.0.0.1', Number(process.env.QA_PORT ?? 7499));
if (process.env.QA_ASK) {
  env.hq.mailbox.ask({
    msg_id: 'qa-ask-go', from: 'adi', blocking: true, options: ['GO', 'לא עכשיו'],
    headline: 'תיקון אבטחה: אף אחד מבחוץ לא יוכל להפיל את השרת עם בקשה משובשת',
    question: 'תיקון אבטחה: אף אחד מבחוץ לא יוכל להפיל את השרת עם בקשה משובשת. לפרוס את hq עכשיו?',
  });
}
if (process.env.QA_ASK === '2') {
  env.hq.mailbox.ask({
    msg_id: 'qa-ask-2', from: 'dana', blocking: false, options: ['כן', 'לא'],
    headline: 'לשלוח לנהגים את הודעת הפתיחה החדשה?',
    question: 'הנוסח החדש של הודעת הפתיחה מוכן. לשלוח אותו לנהגים שעוד לא קיבלו?',
  });
}
const codes = Array.from({ length: Number(process.env.QA_PAIR ?? 1) }, () => env.hq.auth.createPairCode({ kind: 'admin' }).code);
console.log(`hq live copy on ${api.port}; pair codes ${codes.join(' ')}`);
const stop = async () => { await api.close(); await close(); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
