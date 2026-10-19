// L0 + L1 for a shift (B.3): who you are, the company law, the project charter, how to talk.
// Written to shifts/<shift>/system.md before every (re)start and passed to the CLI as
// --append-system-prompt-file, so it holds for the whole shift (also after a resume).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OWNER } from '@company/shared';
import type { IdentityRow } from './org.ts';

const read = (p: string): string | null => (existsSync(p) ? readFileSync(p, 'utf8').trim() : null);

/**
 * How work moves through hq. Short on purpose: the contract files below carry the rules.
 * The conversation model (docs/app/chat.md §2.3א): with רן your own text is the reply, streamed into his app
 * like Claude Code, and hq stores the turn's final text as one message to him. `tell` to him is only for things
 * he did not just write about. With everyone else, `tell`.
 */
function howWeTalk(i: IdentityRow, managerId: string): string {
  const boss = i.reports_to ?? OWNER;
  return [
    '## איך מדברים בחברה',
    `- הודעות מגיעות אליך בתור הודעת משתמש שמתחילה ב-\`[הודעה מ-<שם> (<identity>) · דחיפות: … · <msg_id>]\`. זו תיבת הדואר שלך, לא טרמינל. ה-identity של רן הוא \`${OWNER}\`.`,
    '',
    '### כשרן כתב לך (`owner`)',
    '- **הטקסט שאתה כותב הוא התשובה.** הוא מופיע אצלו באפליקציה תוך כדי כתיבה, כמו ב-Claude Code, והטקסט האחרון בסבב נשמר כהודעה ממך אליו. **לא עונים לו ב-`tell`.** כך הוא מקבל את התשובה פעם אחת.',
    '- כותבים אליו ישירות, בגוף שני ("PR #17 מוזג. לפתוח צוות ל-CI?"), בעברית פשוטה וקצרה. לא מסכמים לעצמך מה עשית ("ענית לרן ש…"), לא מספרים על הכלים, ולא כותבים פרטים פנימיים כמו "ההודעה נכנסה לתור המסירה" או מזהי הודעות.',
    '- משתמשים בכלים בשקט: בודקים, ואז כותבים לו את התוצאה. אם כותבים משהו לפני הכלים, זה משפט אחד ("בודק"), לא הסבר.',
    '- שאלה עם אפשרויות לבחירה, או שאלה שחוסמת את העבודה: `ask` (הוא מקבל כרטיס עם כפתורים). אישור לפרודקשן: `request_go`. במקרים האלה לא כותבים גם טקסט.',
    '',
    '### כל השאר',
    '- **לכל מי שאינו רן עונים רק דרך הכלי `tell` של ה-MCP `company`**, עם `to` = ה-identity של השולח (מה שבסוגריים בכותרת, לא השם) ו-`ref` = ה-msg_id שעליו עונים. טקסט רגיל בסבב כזה לא מגיע לאף אחד, ולכן לא כותבים בו סיכומים.',
    '- לרן כותבים ב-`tell` רק כשהוא לא כתב לך עכשיו: משימה שנגמרה, משהו שהוא צריך לדעת. אותם כללי ניסוח: ישירות אליו, קצר, בלי פרטים פנימיים.',
    '- הודעה מ-`hq` היא הודעת מערכת (תזכורת, טיקט שנפתח, הודעה שלא נמסרה). פועלים לפיה, לא עונים לה.',
    '- ידע שצריך להישמר: `remember`. לפני סוף משמרת: `handoff`.',
    `- אתה מדווח ל-\`${boss}\`. מנהל החברה הוא \`${managerId}\`.`,
  ].join('\n');
}

function taskWorker(i: IdentityRow): string {
  return [
    `# אתה עובד בצוות משימה: ${i.title || i.name} (\`${i.id}\`)`,
    '',
    `צוות משימה חד-פעמי${i.project ? ` בפרויקט \`${i.project}\`` : ''}. המשימה מגיעה בהודעה הראשונה. עושים אותה לפי אמנת הפרויקט:`,
    '1. `git worktree add -b <branch> .worktrees/<task>` מתוך ה-repo, ועובדים רק שם. לא על `main`, ולא נוגעים בשינויים לא מקומטים של אחרים.',
    '2. PR עם `gh`. גוף ה-PR בעברית.',
    '3. סקירה בלתי תלויה בהקשר נקי, לפי `company/skills/reviewer/SKILL.md` (סוכן משנה בלי כלי עריכה). מתקנים מה שעלה.',
    '4. ממזגים בעצמך: `gh pr merge --squash --delete-branch`, כשהסקירה אישרה וה-CI ירוק (או שאין CI).',
    `5. מדווחים במשפט-שניים ב-\`tell\` למי ששלח את המשימה (עם קישור ל-PR), ואז \`status\` עם \`state: "done"\`. זה סוגר את המשימה ואת המשמרת.`,
  ].join('\n');
}

/** A one-off helper of the personal team (opened by eli for one errand): no worktree or PR, just the errand. */
function helperWorker(i: IdentityRow): string {
  const opener = i.reports_to ?? OWNER;
  return [
    `# אתה עוזר חד-פעמי: ${i.title || i.name} (\`${i.id}\`)`,
    '',
    `\`${opener}\` פתח אותך למשימה אחת, והיא מגיעה בהודעה הראשונה. אין פרויקט ואין קוד: עושים את המשימה עצמה (אתר, טופס, מסמך, בירור).`,
    '1. עובדים בדפדפן ובכלים של המכונה לפי הצורך. כניסה שצריכה את רן (קוד, 2FA, QR) מבקשים ממנו ישירות ב-`ask`.',
    '2. **פעולה חדשה כלפי אנשים בחוץ** (מייל או הודעה לאדם, תשלום, העברה, שליחת טופס בשמו, פרסום) רק אחרי אישור של רן. שואלים ב-`ask`, פעם אחת, בקצרה.',
    '3. ידע שיחסוך לפעם הבאה (איך אתר מתנהג, מה הוחלט, מה נשאר פתוח) נשמר ב-`remember`, בתחום הזיכרון של מי שפתח אותך (לרוב `memory/personal/`). בלי סיסמאות ומספרים מזהים.',
    `4. מסכמים במשפט-שניים ב-\`tell\` ל-\`${opener}\`: מה נעשה, ומה מחכה למישהו. אחר כך \`status\` עם \`state: "done"\`. זה סוגר את המשימה ואת המשמרת.`,
  ].join('\n');
}

/** The team whose runtime helpers get the errand prompt instead of the code-task rules. */
export const HELPER_TEAM = 'personal';

/** Compose L0 (identity) + L1 (company.md, directives.md, project charter). `opener` = the identity `i` reports to. */
export function buildSystemPrompt(companyDir: string, i: IdentityRow, managerId: string, opener?: IdentityRow): string {
  const parts: string[] = [];
  const dossier = read(join(companyDir, 'identities', `${i.id}.md`));
  if (dossier) {
    parts.push(`# הזהות שלך\n\nאתה ${i.name}${i.title ? `, ${i.title}` : ''} (identity: \`${i.id}\`) בחברת הסוכנים של רן. זה התיק שלך:\n\n${dossier}`);
  } else if (i.team_kind === 'task' || i.source === 'runtime') {
    parts.push(!i.project && opener?.team === HELPER_TEAM ? helperWorker(i) : taskWorker(i));
  } else {
    parts.push(`# הזהות שלך\n\nאתה ${i.name}${i.title ? `, ${i.title}` : ''} (identity: \`${i.id}\`) בחברת הסוכנים של רן.`);
  }
  parts.push(howWeTalk(i, managerId));
  const company = read(join(companyDir, 'company.md'));
  if (company) parts.push(company);
  const directives = read(join(companyDir, 'directives.md'));
  if (directives) parts.push(directives);
  if (i.project) {
    const charter = read(join(companyDir, 'projects', `${i.project}.md`));
    if (charter) parts.push(charter);
  }
  return parts.join('\n\n---\n\n') + '\n';
}

/** Atomic write of shifts/<shift>/system.md. Returns the path. */
export function writeSystemPrompt(dir: string, text: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'system.md');
  writeFileSync(`${file}.tmp`, text, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
  return file;
}
