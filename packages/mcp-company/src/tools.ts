// Tool catalogue of the `company` MCP server (B.4, B.3, B.6). Every tool but
// recall is a write: it goes to the local WAL and is answered {queued:true}.
import { englishLines, hebrewReason, isEnglishTitle } from '@company/shared';
import type { OpName } from '@company/shared';

type Schema = Record<string, unknown>;

export interface ToolDef {
  name: OpName | 'recall';
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, Schema>; required: string[]; additionalProperties: boolean };
}

const s = (description: string): Schema => ({ type: 'string', description });
const strs = (description: string): Schema => ({ type: 'array', items: { type: 'string' }, description });
const oneOf = (values: string[], description: string): Schema => ({ type: 'string', enum: values, description });

function tool(name: ToolDef['name'], description: string, properties: Record<string, Schema>, required: string[]): ToolDef {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } };
}

export const TOOLS: readonly ToolDef[] = [
  tool('tell', 'שליחת הודעה לעובד לפי identity. Send a message to a teammate by identity.', {
    to: s('identity של הנמען / recipient identity, e.g. "dana"'),
    body: s('תוכן ההודעה / message text'),
    urgency: oneOf(['now', 'next', 'later'], 'now מפריע, next ברירת מחדל, later לסוף התור / delivery priority'),
    ref: s('מזהה הודעה שעליה עונים, e.g. m-8812 / message id being answered'),
  }, ['to', 'body']),
  tool('ask', 'שאלה לרן או למנהל. מופיעה אצלו כהודעה בשיחה איתך: קודם headline, מתחתיה כפתורים מ-options, '
    + 'והפרטים (question) מקופלים. מה שהוא כותב בשיחה כשהשאלה פתוחה הוא התשובה. '
    + 'Ask the owner/manager a question. He sees it as a message in his chat with you: the headline first, '
    + 'buttons from options under it, the question folded as details. Whatever he types in that chat while it is open is the answer.', {
    headline: s('שורה ראשונה קצרה במילים שלו: מה משתנה אצלו או מה צריך ממנו, בלי מונחים טכניים, '
      + 'e.g. "עדכון לאפליקציה: תמונות בצ\'אט" / one short line in his words: what changes for him'),
    question: s('השאלה עם הפרטים (מקופלים מתחת ל-headline) / the question with the details, folded under the headline'),
    blocking: { type: 'boolean', description: 'האם העבודה עוצרת עד תשובה / work is blocked until answered' },
    options: strs('תשובות אפשריות / suggested answers'),
    ref: s('הקשר / related message or task id'),
  }, ['headline', 'question']),
  tool('remember', 'שמירת ידע בזיכרון החברה. Store knowledge in company memory.', {
    scope: oneOf(['company', 'project', 'personal'], 'היקף / scope'),
    kind: oneOf(['directive', 'lesson', 'decision', 'fact', 'trap', 'command'], 'סוג / kind'),
    text: s('הידע עצמו / the knowledge'),
    quote: s('ציטוט מקור מילה במילה / verbatim source quote'),
    source: s('מקור, e.g. m-8812 / source reference'),
    project: s('פרויקט כש-scope=project / project when scope=project'),
    domain: s('תחום כש-scope=personal / domain when scope=personal'),
  }, ['scope', 'kind', 'text']),
  tool('recall', 'חיפוש בזיכרון החברה. בקריאה אחת שלחו ב-queries גם ניסוח בעברית וגם ניסוח באנגלית של אותה שאלה (הזיכרון כתוב בשתי השפות). '
    + 'Search company memory. In ONE call pass both a Hebrew and an English phrasing in `queries` '
    + '(e.g. ["מספר החירום של ביטוח הבריאות", "health insurance emergency number"]); do not retry with another language. '
    + 'The first item comes with the full record, the rest as snippets.', {
    query: s('מילות חיפוש או מזהה רשומה / search terms or a record id'),
    queries: strs('ניסוחים חלופיים: לפחות אחד בעברית ואחד באנגלית / reformulations: at least one Hebrew and one English'),
    scope: s('company | project:<p> | personal:<domain> | archive'),
    limit: { type: 'integer', minimum: 1, maximum: 50, description: 'מספר תוצאות מרבי / max results (default 8)' },
  }, []),
  tool('handoff', 'העברת משמרת: מצב, החלטות והמשך. Shift handoff for the next session.', {
    state: s('מצב נוכחי בשורה / current state'),
    done: strs('מה הושלם / done'),
    decisions: strs('החלטות שהתקבלו / decisions made'),
    next: strs('הצעדים הבאים / next steps'),
    waiting_on: strs('על מי/מה מחכים / blocked on'),
    open_questions: strs('שאלות פתוחות / open questions'),
    warnings: strs('אזהרות / warnings'),
    confidence: oneOf(['low', 'medium', 'high'], 'ביטחון / confidence'),
    reason: s('סיבת ההעברה, e.g. context, end_of_day / why handing off'),
    task: s('מזהה משימה / task id'),
  }, ['state']),
  tool('status', 'עדכון מצב העובד. Update your working status.', {
    state: s('מצב, e.g. working | blocked | idle / state'),
    note: s('הערה קצרה / short note'),
  }, ['state']),
  tool('open_team', 'פתיחת צוות משימה: נכנס לתור, עובד חדש נפתח במשבצת פנויה ומדווח לך בסיום. אם hq דוחה (למשל פרויקט רדום), הדחייה והסיבה חוזרות כשגיאה. '
    + 'Open a task team: queued; a fresh worker starts in a free slot and reports back to you when done. A rejection by hq comes back as an error with the reason.', {
    name: s('כותרת המשימה / task title'),
    purpose: s('מה בדיוק לעשות ואיך יודעים שזה גמור / what to do and the definition of done'),
    project: s('הפרויקט, e.g. agent-company (ברירת מחדל: הפרויקט שלך) / project (default: yours)'),
    ref: s('טיקט, e.g. hivecode-app/hive-code#11 / issue reference'),
    repo: s('ה-checkout מהאמנה (name), אם יש בפרויקט יותר מאחד. ברירת מחדל: הראשון / charter checkout name, default the first'),
    members: strs('identities של חברי הצוות / member identities'),
  }, ['name', 'purpose']),
  tool('close_team', 'סגירת צוות משימה: המשימה נסגרת, המשמרת נעצרת והעבודה נשמרת. רק מי שפתח, המנהל שלו, המנהל של העובד או יואב. '
    + 'Close a task team: the task is done, its shift stops, uncommitted work is preserved.', {
    team: s('מזהה המשימה (t22), ה-identity של העובד (lumo-t22) או השם שלו / task id, worker identity or name'),
    reason: s('סיבה, נשלחת לעובד לפני העצירה / reason, sent to the worker before the stop'),
  }, ['team']),
  tool('request_go', 'בקשת אישור לפעולה. מופיעה אצלו כהודעה בשיחה איתך עם כפתור GO: קודם headline, והפרטים (what) מקופלים. '
    + 'מה שהוא כותב בשיחה כשהבקשה פתוחה הוא התשובה. '
    + 'Request a go-ahead before acting. He sees it as a message in his chat with you with a GO button: the headline first, '
    + 'the details (what) folded. Whatever he types in that chat while it is open is the answer.', {
    headline: s('שורה ראשונה קצרה במילים שלו: מה משתנה אצלו, בלי מונחים טכניים, '
      + 'e.g. "עדכון לאפליקציה: תמונות בצ\'אט" / one short line in his words: what changes for him'),
    what: s('הפרטים: מה נכנס, סיכון ואיך חוזרים אחורה (מקופלים) / details: what ships, risk, rollback (folded)'),
    pr: s('קישור או מספר PR / PR url or number'),
    risk: oneOf(['low', 'medium', 'high'], 'רמת סיכון / risk level'),
  }, ['headline', 'what']),
  tool('open_ticket', 'פתיחת כרטיס ב-repo. Open an issue in a repo.', {
    repo: s('owner/repo'),
    title: s('כותרת / title'),
    body: s('תוכן / body'),
    labels: strs('תוויות / labels'),
  }, ['repo', 'title', 'body']),
];

export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name as string, t]));

/** Minimal JSON Schema check for our flat schemas. Returns an error or null. */
export function validateArgs(def: ToolDef, args: unknown): string | null {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return 'arguments must be an object';
  const a = args as Record<string, unknown>;
  for (const r of def.inputSchema.required) {
    if (a[r] === undefined || a[r] === null || a[r] === '') return `missing required argument: ${r}`;
  }
  for (const [k, v] of Object.entries(a)) {
    const p = def.inputSchema.properties[k];
    if (!p) return `unknown argument: ${k}`;
    if (v === undefined || v === null) continue;
    switch (p.type) {
      case 'string':
        if (typeof v !== 'string') return `${k} must be a string`;
        if (Array.isArray(p.enum) && !p.enum.includes(v)) return `${k} must be one of ${p.enum.join('|')}`;
        break;
      case 'boolean':
        if (typeof v !== 'boolean') return `${k} must be a boolean`;
        break;
      case 'integer':
        if (!Number.isInteger(v)) return `${k} must be an integer`;
        if (typeof p.minimum === 'number' && (v as number) < p.minimum) return `${k} must be >= ${p.minimum}`;
        if (typeof p.maximum === 'number' && (v as number) > p.maximum) return `${k} must be <= ${p.maximum}`;
        break;
      case 'array':
        if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return `${k} must be an array of strings`;
        break;
    }
  }
  return null;
}

/** Everything a person reads goes out in Hebrew (dir-0002, #51): message text by line, titles whole. */
const HEBREW_TEXT: Partial<Record<ToolDef['name'], string[]>> = {
  tell: ['body'], ask: ['question'], request_go: ['what'], open_team: ['purpose'], open_ticket: ['body'],
};
const HEBREW_TITLE: Partial<Record<ToolDef['name'], string[]>> = {
  open_team: ['name'], open_ticket: ['title'], ask: ['headline'], request_go: ['headline'],
};

/** The rewrite request when a field that a person reads is English, else null. */
export function hebrewProblem(def: ToolDef, args: Record<string, unknown>): string | null {
  for (const k of HEBREW_TITLE[def.name] ?? []) {
    const v = args[k];
    if (typeof v === 'string' && isEnglishTitle(v)) return hebrewReason(`${def.name}.${k} (כותרת)`, [v]);
  }
  for (const k of HEBREW_TEXT[def.name] ?? []) {
    const v = args[k];
    const bad = typeof v === 'string' ? englishLines(v) : [];
    if (bad.length) return hebrewReason(`${def.name}.${k}`, bad);
  }
  return null;
}
