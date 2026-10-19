// L0 + L1 for a shift (B.3): who you are, the company law, the project charter, how to talk.
// Written to shifts/<shift>/system.md before every (re)start and passed to the CLI as
// --append-system-prompt-file, so it holds for the whole shift (also after a resume).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OWNER } from '@company/shared';
import type { IdentityRow } from './org.ts';

const read = (p: string): string | null => (existsSync(p) ? readFileSync(p, 'utf8').trim() : null);

/** How work moves through hq. Short on purpose: the contract files below carry the rules. */
function howWeTalk(i: IdentityRow, managerId: string): string {
  const boss = i.reports_to ?? OWNER;
  return [
    '## איך מדברים בחברה',
    `- הודעות מגיעות אליך בתור הודעת משתמש שמתחילה ב-\`[הודעה מ-<שם> (<identity>) · דחיפות: … · <msg_id>]\`. זה לא רן שמקליד בטרמינל: זו תיבת הדואר שלך.`,
    `- **עונים רק דרך הכלי \`tell\` של ה-MCP \`company\`**, עם \`to\` = ה-identity של השולח (מה שבסוגריים בכותרת, לא השם) ו-\`ref\` = ה-msg_id שעליו עונים. טקסט רגיל בתשובה שלך לא מגיע לאף אחד. ה-identity של רן הוא \`${OWNER}\`.`,
    '- הודעה מ-`hq` היא הודעת מערכת (תזכורת, טיקט שנפתח, הודעה שלא נמסרה). פועלים לפיה, לא עונים לה.',
    '- שאלה לרן: `ask` (עם `blocking` אם העבודה עוצרת). אישור לפרודקשן: `request_go`. ידע שצריך להישמר: `remember`. לפני סוף משמרת: `handoff`.',
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

/** Compose L0 (identity) + L1 (company.md, directives.md, project charter). */
export function buildSystemPrompt(companyDir: string, i: IdentityRow, managerId: string): string {
  const parts: string[] = [];
  const dossier = read(join(companyDir, 'identities', `${i.id}.md`));
  if (dossier) {
    parts.push(`# הזהות שלך\n\nאתה ${i.name}${i.title ? `, ${i.title}` : ''} (identity: \`${i.id}\`) בחברת הסוכנים של רן. זה התיק שלך:\n\n${dossier}`);
  } else if (i.team_kind === 'task' || i.source === 'runtime') {
    parts.push(taskWorker(i));
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
