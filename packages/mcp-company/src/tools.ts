// Tool catalogue of the `company` MCP server (B.4, B.3, B.6). Every tool but
// recall is a write: it goes to the local WAL and is answered {queued:true}.
import { DEFAULT_NAMES, englishLines, g, hebrewReason, isEnglishTitle, pre } from '@company/shared';
import type { CompanyNames, OpName } from '@company/shared';

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

/** The catalogue, its texts naming the owner, the manager and the composer from org.yaml (CompanyNames). */
export function buildTools(n: CompanyNames = DEFAULT_NAMES): ToolDef[] {
  const O = n.owner.name;
  const G = (male: string, female: string) => g(n.owner, male, female);
  // "מה לבדוק" (#108): what a finished task still waits for, shown to him until a deploy or his "בדקתי" clears it.
  const awaitingArgs: Record<string, Schema> = {
    awaiting: oneOf(['deploy', 'check', 'none'], 'מה המשימה עוד מחכה ' + G('לו', 'לה') + ': deploy = מוזג ומחכה ל-GO או לפריסה (מתנקה לבד כשפריסה כוללת אותה), '
      + 'check = כבר בפרודקשן ' + pre('ו', O) + ' ' + G('צריך', 'צריכה') + ' לבדוק משהו ' + G('בעצמו', 'בעצמה') + ' (מתנקה ' + G('כשהוא מסמן', 'כשהיא מסמנת') + ' "בדקתי"), none = כלום, מנקה. בלי: לא מחכה לכלום '
      + '/ deploy = merged, waits for GO or a deploy; check = live, ' + G('he has', 'she has') + ' to check something ' + G('himself', 'herself') + '; none = clears'),
    awaiting_note: s('עם awaiting: שורה אחת במילים ' + G('שלו', 'שלה') + ', מה מחכה או מה לבדוק, e.g. "לשלוח תמונה מהטלפון ולראות שהיא עולה" '
      + '/ with awaiting: one line in ' + G('his', 'her') + ' words, what waits or what to check'),
    pr: s('ה-PR שמוזג, מספר או קישור. פריסה שמדווחת עליו מנקה את deploy / the merged PR, number or url; a deploy that reports it clears deploy'),
  };

  return [
    tool('tell', 'שליחת הודעה לעובד לפי identity. Send a message to a teammate by identity.', {
      to: s('identity של הנמען / recipient identity, e.g. "dana"'),
      body: s('תוכן ההודעה / message text'),
      urgency: oneOf(['now', 'next', 'later'], 'now מפריע, next ברירת מחדל, later לסוף התור / delivery priority'),
      ref: s('מזהה הודעה שעליה עונים, e.g. m-8812 / message id being answered'),
    }, ['to', 'body']),
    tool('ask', 'שאלה ' + pre('ל', O) + ' או למנהל. מופיעה ' + G('אצלו', 'אצלה') + ' כהודעה בשיחה איתך: קודם headline, מתחתיה כפתורים מ-options, '
      + 'והפרטים (question) מקופלים. מה ' + G('שהוא כותב', 'שהיא כותבת') + ' בשיחה כשהשאלה פתוחה הוא התשובה. '
      + 'Ask the owner/manager a question. ' + G('He sees', 'She sees') + ' it as a message in ' + G('his', 'her') + ' chat with you: the headline first, '
      + 'buttons from options under it, the question folded as details. Whatever ' + G('he types', 'she types') + ' in that chat while it is open is the answer.', {
      headline: s('שורה ראשונה קצרה במילים ' + G('שלו', 'שלה') + ': מה משתנה ' + G('אצלו', 'אצלה') + ' או מה צריך ' + G('ממנו', 'ממנה') + ', בלי מונחים טכניים, '
        + 'e.g. "עדכון לאפליקציה: תמונות בצ\'אט" / one short line in ' + G('his', 'her') + ' words: what changes for ' + G('him', 'her')),
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
      file: s('עדכון לקובץ זיכרון: נתיב יחסי תחת memory/, למשל memory/projects/lumo-bot/open-ron.md. רישומים של הפרויקט שלך '
        + '(open-*.md, *-actions.md, customers.md), וה-open-*.md של צוות חברה בתחום שלך (memory/company/<team>/), נכנסים ל-main מיד; שאר הקבצים נכנסים ל-PR מאוחד לסקירה. לא עורכים קבצים ב-checkout הראשי / '
        + 'update a memory file (path under memory/): your project\'s registries land on main at once, other files go to one rolling PR'),
      mode: oneOf(['append', 'replace'], 'עם file: append מוסיף את text לסוף הקובץ (ברירת מחדל), replace מחליף את כל הקובץ ב-text. '
        + 'לפני replace קוראים את הקובץ ב-recall עם הנתיב כ-query: הוא חוזר שלם, כולל עדכונים שעוד מחכים, ועם base_sha / '
        + 'with file: append adds text at the end (default), replace makes text the whole file; before replace, recall the path (it returns base_sha)'),
      base_sha: s('עם replace לרישום: ה-base_sha שחזר ב-recall עם הנתיב. אם הקובץ השתנה מאז, העדכון לא נכנס ו-hq שולח לך את התוכן החדש / '
        + 'with replace on a registry: the base_sha recall returned; if the file moved since, hq sends you the new text to try again'),
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
    tool('status', 'עדכון מצב העובד. עם state: "done" המשימה נסגרת, ותמיד כותבים summary: זו השורה ' + pre('ש', O) + ' רואה ב"מאז שהיית פה" וב"מה הסתיים". '
      + 'בלי summary ' + G('הוא רואה', 'היא רואה') + ' רק את שם המשימה. '
      + 'אם משהו עוד מחכה ' + G('לו', 'לה') + ' (פריסה אחרי GO, או משהו ' + G('שהוא צריך', 'שהיא צריכה') + ' לבדוק ' + G('בעצמו', 'בעצמה') + '), מוסיפים awaiting ו-awaiting_note, וזה מופיע ' + G('אצלו', 'אצלה') + ' ב"מה לבדוק". '
      + 'המשימה נסגרת כשהסבב נגמר, ורק אם ענית על כל מה ' + pre('ש', O) + ' ' + G('שלח', 'שלחה') + ' לך. אחרת hq כותב לך "' + O + ' מחכה לתשובה על…" והיא נשארת פתוחה. '
      + 'The task closes when the turn ends, and only if every message ' + G('he', 'she') + ' sent you was answered; else hq tells you so and it stays open. '
      + 'Update your working status. With state "done" the task closes; always give summary: it is the line ' + G('he sees', 'she sees') + ' under "since you were here" '
      + 'and "what finished"; without it ' + G('he sees', 'she sees') + ' only the task title. '
      + 'If it still waits on something (a deploy, or something ' + G('he', 'she') + ' must check), add awaiting and awaiting_note: it shows under "what to check".', {
      state: s('מצב, e.g. working | blocked | idle | done / state'),
      note: s('הערה קצרה / short note'),
      summary: s('ב-done: שורה אחת במילים ' + G('שלו', 'שלה') + ', מה השתנה ' + G('אצלו', 'אצלה') + ', בלי מספרי PR ובלי מונחים טכניים, e.g. "התמונות בצ\'אט עולות גם מהטלפון" '
        + '/ with done: one line in ' + G('his', 'her') + ' words on what changed for ' + G('him', 'her') + ', no PR numbers or jargon'),
      ...awaitingArgs,
    }, ['state']),
    tool('open_team', 'פתיחת צוות משימה: נכנס לתור, עובד חדש נפתח במשבצת פנויה ומדווח לך בסיום. עם assignee המשימה הולכת לעובד הקבוע שהתחום שלו: '
      + 'worktree משלה ו-session נקי, ואם הוא באמצע משימה אחרת היא מחכה בתור שלו. אם hq דוחה (למשל פרויקט רדום או assignee לא חוקי), הדחייה והסיבה חוזרות כשגיאה. '
      + 'משימה שהיא חלק ממאמץ גדול: name מתחיל בשם המאמץ, e.g. "מוצר גנרי, שלב 4: אפליקציה אחת לכל שרת". המאמץ שייך לך, והשיחה איתך היא הבית שלו. '
      + 'Open a task team: queued; a fresh worker starts in a free slot and reports back to you when done. With assignee it goes to that standing '
      + 'worker (own worktree, fresh session, one task at a time). A rejection by hq comes back as an error with the reason. '
      + 'A task that is part of a larger effort starts its name with the effort\'s name.', {
      name: s('כותרת המשימה. חלק ממאמץ גדול: שם המאמץ קודם, e.g. "מוצר גנרי, שלב 4: …" / task title; part of a larger effort: the effort\'s name first'),
      purpose: s('מה בדיוק לעשות ואיך יודעים שזה גמור / what to do and the definition of done'),
      project: s('הפרויקט, e.g. agent-company (ברירת מחדל: הפרויקט שלך) / project (default: yours)'),
      ref: s('טיקט, e.g. hivecode-app/hive-code#11 / issue reference'),
      repo: s('ה-checkout מהאמנה (name), אם יש בפרויקט יותר מאחד. ברירת מחדל: הראשון / charter checkout name, default the first'),
      assignee: s('העובד הקבוע בפרויקט שהתחום שלו, e.g. ido. בלי: עובד זמני / standing worker of the project; default a temporary worker'),
      members: strs('identities של חברי הצוות / member identities'),
    }, ['name', 'purpose']),
    tool('close_team', 'סגירת צוות משימה: המשימה נסגרת, המשמרת נעצרת והעבודה נשמרת. רק מי שפתח, המנהל שלו, המנהל של העובד או ' + n.manager.name + '. '
      + 'awaiting ו-awaiting_note גוברים על מה שהעובד סימן, ואפשר לסמן אותם גם על משימה שכבר נסגרה. '
      + 'Close a task team: the task is done, its shift stops, uncommitted work is preserved.', {
      team: s('מזהה המשימה (t22), ה-identity של העובד (lumo-t22) או השם שלו / task id, worker identity or name'),
      reason: s('סיבה, נשלחת לעובד לפני העצירה / reason, sent to the worker before the stop'),
      summary: s('שורה אחת במילים ' + G('שלו', 'שלה') + ', מה השתנה ' + G('אצלו', 'אצלה') + ', בלי מספרי PR ובלי מונחים טכניים, e.g. "מיכל בצוות של לומו בוט". '
        + 'גוברת על מה שהעובד כתב. כתבו אותה כשהעובד לא כתב, אחרת ' + G('הוא רואה', 'היא רואה') + ' רק את שם המשימה '
        + '/ one line in ' + G('his', 'her') + ' words on what changed for ' + G('him', 'her') + ', no PR numbers or jargon; overrides the worker\'s. Give it when the worker gave none, '
        + 'or ' + G('he sees', 'she sees') + ' only the task title'),
      force: { type: 'boolean', description: 'לסגור גם ' + pre('כש', O) + ' מחכה לתשובה מהעובד (hq מזהיר ולא סוגר בלי זה) '
        + '/ close even though the owner is still waiting for an answer from the worker (without it hq warns and does not close)' },
      ...awaitingArgs,
    }, ['team']),
    tool('request_go', 'בקשת אישור לפעולה. מופיעה ' + G('אצלו', 'אצלה') + ' כהודעה בשיחה איתך עם כפתור GO: קודם headline, והפרטים (what) מקופלים. '
      + 'מה ' + G('שהוא כותב', 'שהיא כותבת') + ' בשיחה כשהבקשה פתוחה הוא התשובה. '
      + 'Request a go-ahead before acting. ' + G('He sees', 'She sees') + ' it as a message in ' + G('his', 'her') + ' chat with you with a GO button: the headline first, '
      + 'the details (what) folded. Whatever ' + G('he types', 'she types') + ' in that chat while it is open is the answer.', {
      headline: s('שורה ראשונה קצרה במילים ' + G('שלו', 'שלה') + ': מה משתנה ' + G('אצלו', 'אצלה') + ', בלי מונחים טכניים, '
        + 'e.g. "עדכון לאפליקציה: תמונות בצ\'אט" / one short line in ' + G('his', 'her') + ' words: what changes for ' + G('him', 'her')),
      what: s('הפרטים: מה נכנס, סיכון ואיך חוזרים אחורה (מקופלים) / details: what ships, risk, rollback (folded)'),
      pr: s('קישור או מספר PR / PR url or number'),
      risk: oneOf(['low', 'medium', 'high'], 'רמת סיכון / risk level'),
    }, ['headline', 'what']),
    tool('compose_home', 'הרכבת ראש מסך השיחות של ' + O + ': אילו בלוקים, באיזה סדר ובאיזה ניסוח. רק ' + (n.composer ? `${pre('ל', n.composer.name)} ${pre('ו', pre('ל', n.manager.name))}` : pre('ל', n.manager.name)) + '. '
      + 'האפליקציה מציירת כל בלוק מקומפוננטה קבועה וממלאת אותו מנתונים חיים, ולכן מפנים לנתונים לפי מזהה, והטקסט בעברית. '
      + 'אוצר הבלוקים: '
      + 'headline {text} משפט אחד · alert {inbox: מספר} או {shift: מזהה משמרת} · waiting {inbox: [מספרים]} · asked {messages: [מזהי הודעות]} ביקשת, בקשות ' + G('שלו', 'שלה') + ' מעובדים שמחכות לתשובה או שהתשובה עליהן עוד לא נקראה, בדרך כלל אחרי waiting · awaiting {tasks: [מזהי משימות]} מה לבדוק, משימות שמחכות לפריסה או לבדיקה ' + G('שלו', 'שלה') + ' · '
      + 'tasks {tasks: [מזהי משימות] או "open"} בעבודה ובתור: משימות פתוחות עם מי פתח, מי עובד והמצב. "open" מציג את כולן, ורשימה מציגה משימה מסוימת (למשל דחופה) · '
      + 'lanes {projects: [ids]} פסי היום · '
      + 'project {project, note?} שתי שורות · quiet {projects: [ids]} שורה אחת בסוף, "שקט גם ב: …", לפרויקטים שלא זזו · people {identities: [ids], caption?} · since {items: [עד 3: משפט, או {text, task: מזהה משימה}]}, עם task השורה מובילה לשיחה עם מי שעשה את המשימה · '
      + 'note {text, icon} הערה שלך, icon הוא שם של Material Symbol. לכל בלוק אפשר emphasis: normal|quiet|strong (טיפוגרפיה בלבד). '
      + 'בלוק לא מוכר, שדה חסר או הפניה שלא קיימת נדחים עם הסיבה. מה שנסגר נעלם לבד, ומה שחוסם ' + G('עליו', 'עליה') + ' ולא שובץ מתווסף לבד. '
      + 'מתכון ישן מ-30 דקות מתחלף בברירת המחדל של hq. '
      + 'דוגמה: [{"type":"headline","text":"בוקר שקט, שתי משימות רצות"},{"type":"waiting","inbox":[41]},'
      + '{"type":"lanes","projects":["agent-company","lumo"]},{"type":"project","project":"lumo","note":"מחכה ל-GO על 2.6.10"},'
      + '{"type":"note","text":"שווה לבדוק את הפריסה של 2.6.10","icon":"rocket_launch","emphasis":"quiet"}] '
      + "Compose the head of the owner's conversations screen from the fixed block vocabulary above (Hebrew text, data by reference).", {
      blocks: { type: 'array', items: { type: 'object' }, description: 'הבלוקים לפי הסדר / the blocks, in order' },
      reason: s('למה ההרכבה הזו, בשורה / why this composition, one line'),
    }, ['blocks']),
    tool('open_ticket', 'פתיחת כרטיס ב-repo. Open an issue in a repo.', {
      repo: s('owner/repo'),
      title: s('כותרת / title'),
      body: s('תוכן / body'),
      labels: strs('תוויות / labels'),
    }, ['repo', 'title', 'body']),
  ];
}

/** For validation and tests: the catalogue's shape does not depend on the names. */
export const TOOLS: readonly ToolDef[] = buildTools();

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
        if ((p.items as Schema | undefined)?.type === 'object') {
          if (!Array.isArray(v) || v.some((x) => typeof x !== 'object' || x === null || Array.isArray(x))) return `${k} must be an array of objects`;
        } else if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return `${k} must be an array of strings`;
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
  status: ['awaiting_note'], close_team: ['awaiting_note'],
};
/** compose_home: every text a block shows him (headline, note, caption, since items) is Hebrew too. */
const BLOCK_TEXT = ['text', 'note', 'caption'];

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
  if (def.name === 'compose_home' && Array.isArray(args.blocks)) {
    for (const [i, b] of (args.blocks as Record<string, unknown>[]).entries()) {
      const items = Array.isArray(b?.items) ? (b.items as unknown[]).map((x) => (x && typeof x === 'object' ? (x as { text?: unknown }).text : x)) : [];
      const texts = [...BLOCK_TEXT.map((k) => b?.[k]), ...items].filter((v): v is string => typeof v === 'string');
      for (const v of texts) if (isEnglishTitle(v)) return hebrewReason(`compose_home.blocks[${i}]`, [v]);
    }
  }
  return null;
}
