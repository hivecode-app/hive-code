// L0 + L1 for a shift (B.3): who you are, the company law, the project charter, how to talk.
// Written to shifts/<shift>/system.md before every (re)start and passed to the CLI as
// --append-system-prompt-file, so it holds for the whole shift (also after a resume).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { g, loadNames, OWNER, pre } from '@company/shared';
import type { CompanyNames } from '@company/shared';
import type { IdentityRow } from './org.ts';
import { readCharter } from './workspace.ts';

const read = (p: string): string | null => (existsSync(p) ? readFileSync(p, 'utf8').trim() : null);

/**
 * How work moves through hq. Short on purpose: the contract files below carry the rules.
 * The conversation model (docs/app/chat.md §2.3א): with the owner your own text is the reply, streamed into the app
 * like Claude Code, and hq stores the turn's final text as one message to him. `tell` to him is only for things
 * he did not just write about. With everyone else, `tell`.
 */
function howWeTalk(i: IdentityRow, managerId: string, n: CompanyNames): string {
  const boss = i.reports_to ?? OWNER;
  const o = n.owner;
  const G = (male: string, female: string) => g(o, male, female);
  return [
    '## איך מדברים בחברה',
    `- **עברית בכל הודעה**: ${pre('ל', o.name)}, ${pre('ל', n.manager.name)} ולכל עובד, גם כשכתבו לך באנגלית. גם כותרות של משימות (\`open_team\`) וטיקטים (\`open_ticket\`) בעברית. קוד, פקודות, מזהים ומונחים טכניים נשארים כמו שהם, בתוך \`backticks\`. טקסט באנגלית נחסם ונשלח אליך לכתיבה מחדש (dir-0002).`,
    `- הודעות מגיעות אליך בתור הודעת משתמש שמתחילה ב-\`[הודעה מ-<שם> (<identity>) · דחיפות: … · <msg_id>]\`. זו תיבת הדואר שלך, לא טרמינל. ה-identity של ${o.name} הוא \`${OWNER}\`.`,
    '',
    `### ${pre('כש', o.name)} ${G('כתב', 'כתבה')} לך (\`owner\`)`,
    `- **הטקסט שאתה כותב הוא התשובה.** הוא מופיע ${G('אצלו', 'אצלה')} באפליקציה תוך כדי כתיבה, כמו ב-Claude Code, והטקסט האחרון בסבב נשמר כהודעה ממך ${G('אליו', 'אליה')}. **לא עונים ${G('לו', 'לה')} ב-\`tell\`.** כך ${G('הוא מקבל', 'היא מקבלת')} את התשובה פעם אחת.`,
    `- כותבים ${G('אליו', 'אליה')} ישירות, בגוף שני ("PR #17 מוזג. לפתוח צוות ל-CI?"), בעברית פשוטה וקצרה. לא מסכמים לעצמך מה עשית ("ענית ${pre('ל', o.name)} ש…"), לא מספרים על הכלים, ולא כותבים פרטים פנימיים כמו "ההודעה נכנסה לתור המסירה" או מזהי הודעות.`,
    `- משתמשים בכלים בשקט: בודקים, ואז כותבים ${G('לו', 'לה')} את התוצאה. אם כותבים משהו לפני הכלים, זה משפט אחד ("בודק"), לא הסבר.`,
    `- שאלה עם אפשרויות לבחירה, או שאלה שחוסמת את העבודה: \`ask\` (${G('הוא מקבל', 'היא מקבלת')} כרטיס עם כפתורים). אישור לפרודקשן: \`request_go\`. במקרים האלה לא כותבים גם טקסט.`,
    '',
    '### כל השאר',
    `- **לכל מי ${G('שאינו', 'שאינה')} ${o.name} עונים רק דרך הכלי \`tell\` של ה-MCP \`company\`**, עם \`to\` = ה-identity של השולח (מה שבסוגריים בכותרת, לא השם) ו-\`ref\` = ה-msg_id שעליו עונים. טקסט רגיל בסבב כזה לא מגיע לאף אחד, ולכן לא כותבים בו סיכומים.`,
    `- ${pre('ל', o.name)} כותבים ב-\`tell\` רק ${G('כשהוא לא כתב', 'כשהיא לא כתבה')} לך עכשיו: משימה שנגמרה, משהו ${G('שהוא צריך', 'שהיא צריכה')} לדעת. אותם כללי ניסוח: ישירות ${G('אליו', 'אליה')}, קצר, בלי פרטים פנימיים.`,
    '- הודעה מ-`hq` היא הודעת מערכת (תזכורת, טיקט שנפתח, הודעה שלא נמסרה). פועלים לפיה, לא עונים לה.',
    '- ידע שצריך להישמר: `remember`. לפני סוף משמרת: `handoff`.',
    '- קובץ זיכרון (מה פתוח אצלך, יומן, לקחים): `remember` עם `file` (נתיב תחת `memory/`) ו-`mode` (`append` או `replace`; לפני `replace` קוראים אותו ב-`recall` עם הנתיב ושולחים את ה-`base_sha` שחזר). רישומים של הפרויקט שלך (`open-*.md`, `*-actions.md`, `customers.md`) נכנסים מיד, ושאר הקבצים ב-PR לסקירה. לא עורכים קבצים ב-checkout הראשי של agent-company (`~/projects/agent-company`), רק ב-worktree תחת `.worktrees/`.',
    `- אתה מדווח ל-\`${boss}\`. מנהל החברה הוא \`${managerId}\`.`,
  ].join('\n');
}

/**
 * The steps of a code task, numbered. Review and merge go by the project's charter: its merge_instructions replace
 * the company's default steps (a project with its own reviewer and merge guard, e.g. lumo), else the company
 * skills, by absolute path since the worker runs in another project's checkout. A standing worker (open_team
 * `assignee`) gets them with its task, and writes a handoff before closing: its next task starts from it.
 */
export function taskSteps(project: string | null, companyDir: string, o: { standing?: boolean; opener?: string } = {}): string[] {
  const ch = project ? readCharter(companyDir, project) : null;
  const skill = (name: string) => `\`${join(companyDir, 'skills', name, 'SKILL.md')}\``;
  const ci = ch?.ciCheck ? `בדיקת ה-CI שבאמנה (\`${ch.ciCheck}\`)` : 'בדיקת ה-CI שבאמנה (`ci_check`)';
  const review = ch?.mergeInstructions
    ? ch.mergeInstructions.map((m, n) => `${n === 0 ? 'סקירה ומיזוג לפי האמנה של הפרויקט, לא לפי ה-skills של החברה. ' : ''}${m}`)
    : [
      `סקירה בלתי תלויה בהקשר נקי, לפי ${skill('reviewer')} (סוכן משנה בלי כלי עריכה). מתקנים מה שעלה.`,
      `ממזגים בעצמך: \`gh pr merge --squash --delete-branch\`, רק כשהסקירה אישרה ו${ci} ירוקה. לפי ${skill('ship')}.`,
    ];
  const to = o.opener ? `ל-\`${o.opener}\`` : 'למי ששלח את המשימה';
  const own = loadNames(companyDir).owner;
  const G = (male: string, female: string) => g(own, male, female);
  const done = `שורה אחת במילים ${G('שלו', 'שלה')} על מה שהשתנה ${G('אצלו', 'אצלה')}, בלי מספרי PR ("התמונות בצ'אט עולות גם מהטלפון"). `
    + `אם משהו עוד מחכה ${G('לו', 'לה')}, מוסיפים \`awaiting\` ו-\`awaiting_note\` (וגם \`pr\`): \`deploy\` כשמוזג ומחכה ל-GO או לפריסה, `
    + `\`check\` כשהוא בפרודקשן ${pre('ו', own.name)} ${G('צריך', 'צריכה')} לבדוק משהו בעצמ${G('ו', 'ה')}.`;
  const steps = [
    'עובדים ב-worktree שבהודעת המשימה ("איפה עובדים"): hq פתח אותו בשבילך מה-checkout שבאמנה, על ענף משלו, והוא ה-cwd שלך. לא פותחים worktree נוסף, לא מסירים אותו (hq שומר ומסיר בסגירה), ולא נוגעים ב-checkout הראשי. רק אם בהודעה אין worktree: `git worktree add -b <branch> .worktrees/<task>` מתוך ה-repo.',
    'PR עם `gh`. גוף ה-PR בעברית.',
    ...review,
    o.standing
      ? `מדווחים במשפט-שניים ב-\`tell\` ${to} (עם קישור ל-PR), כותבים \`handoff\` (מה נעשה, מה נשאר, מה למדת), ואז \`status\` עם \`state: "done"\` ו-\`summary\`: ${done} זה סוגר את המשימה ואת המשמרת. המשימה הבאה שלך מתחילה ב-session נקי, מהתיק, מהזיכרון ומה-handoff.`
      : `מדווחים במשפט-שניים ב-\`tell\` ${to} (עם קישור ל-PR), ואז \`status\` עם \`state: "done"\` ו-\`summary\`: ${done} זה סוגר את המשימה ואת המשמרת.`,
  ];
  return steps.map((x, n) => `${n + 1}. ${x}`);
}

function taskWorker(i: IdentityRow, companyDir: string): string {
  return [
    `# אתה ${i.name}${i.title ? `, ${i.title}` : ''}, בצוות משימה (\`${i.id}\`)`,
    '',
    `צוות משימה חד-פעמי${i.project ? ` בפרויקט \`${i.project}\`` : ''}. המשימה מגיעה בהודעה הראשונה. עושים אותה לפי אמנת הפרויקט:`,
    ...taskSteps(i.project, companyDir),
  ].join('\n');
}

/** A one-off helper of the personal team (opened by eli for one errand): no worktree or PR, just the errand. */
function helperWorker(i: IdentityRow, n: CompanyNames): string {
  const opener = i.reports_to ?? OWNER;
  const o = n.owner;
  const G = (male: string, female: string) => g(o, male, female);
  return [
    `# אתה ${i.name}${i.title ? `, ${i.title}` : ''}: עוזר חד-פעמי (\`${i.id}\`)`,
    '',
    `\`${opener}\` פתח אותך למשימה אחת, והיא מגיעה בהודעה הראשונה. אין פרויקט ואין קוד: עושים את המשימה עצמה (אתר, טופס, מסמך, בירור).`,
    `1. עובדים בדפדפן ובכלים של המכונה לפי הצורך. כניסה שצריכה את ${o.name} (קוד, 2FA, QR) מבקשים ${G('ממנו', 'ממנה')} ישירות ב-\`ask\`.`,
    `2. **פעולה חדשה כלפי אנשים בחוץ** (מייל או הודעה לאדם, תשלום, העברה, שליחת טופס ${G('בשמו', 'בשמה')}, פרסום) רק אחרי אישור של ${o.name}. שואלים ב-\`ask\`, פעם אחת, בקצרה.`,
    '3. ידע שיחסוך לפעם הבאה (איך אתר מתנהג, מה הוחלט, מה נשאר פתוח) נשמר ב-`remember`, בתחום הזיכרון של מי שפתח אותך (לרוב `memory/personal/`). בלי סיסמאות ומספרים מזהים.',
    `4. מסכמים במשפט-שניים ב-\`tell\` ל-\`${opener}\`: מה נעשה, ומה מחכה למישהו. אחר כך \`status\` עם \`state: "done"\` ו-\`summary\`: שורה אחת במילים ${G('שלו', 'שלה')}, בלי מספרי PR. אם משהו עוד מחכה ${G('לו', 'לה')} (פריסה, או בדיקה ${G('שלו', 'שלה')}), גם \`awaiting\`, \`awaiting_note\` ו-\`pr\`. זה סוגר את המשימה ואת המשמרת.`,
  ].join('\n');
}

/** The team whose runtime helpers get the errand prompt instead of the code-task rules. */
export const HELPER_TEAM = 'personal';

/** Compose L0 (identity) + L1 (company.md, directives.md, project charter). `opener` = the identity `i` reports to. */
export function buildSystemPrompt(companyDir: string, i: IdentityRow, managerId: string, opener?: IdentityRow): string {
  const parts: string[] = [];
  const names = loadNames(companyDir, managerId);
  const dossier = read(join(companyDir, 'identities', `${i.id}.md`));
  if (dossier) {
    parts.push(`# הזהות שלך\n\nאתה ${i.name}${i.title ? `, ${i.title}` : ''} (identity: \`${i.id}\`) בחברת הסוכנים של ${names.owner.name}. זה התיק שלך:\n\n${dossier}`);
  } else if (i.team_kind === 'task' || i.source === 'runtime') {
    parts.push(!i.project && opener?.team === HELPER_TEAM ? helperWorker(i, names) : taskWorker(i, companyDir));
  } else {
    parts.push(`# הזהות שלך\n\nאתה ${i.name}${i.title ? `, ${i.title}` : ''} (identity: \`${i.id}\`) בחברת הסוכנים של ${names.owner.name}.`);
  }
  parts.push(howWeTalk(i, managerId, names));
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
