// Tool catalogue of the `company` MCP server (B.4, B.3, B.6). Every tool but
// recall is a write: it goes to the local WAL and is answered {queued:true}.
import { DEFAULT_NAMES, englishLines, g, hebrewReason, isEnglishTitle, pre } from '@company/shared';
import type { CompanyNames, OpName } from '@company/shared';

type Schema = Record<string, unknown>;

export interface ToolDef {
  name: OpName | 'recall' | 'request_access' | 'resources' | 'reserve' | 'release';
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
    awaiting: oneOf(['deploy', 'check', 'verify', 'none'], 'מה המשימה עוד מחכה ' + G('לו', 'לה') + ': deploy = מוזג ומחכה ל-GO או לפריסה (מתנקה לבד כשפריסה כוללת אותה), '
      + 'check = כבר בפרודקשן ' + pre('ו', O) + ' ' + G('צריך', 'צריכה') + ' לבדוק משהו ' + G('בעצמו', 'בעצמה') + ' (מתנקה ' + G('כשהוא מסמן', 'כשהיא מסמנת') + ' "בוצע"), verify = לבדוק לפני שחרור, למשל build ב-TestFlight, none = כלום, מנקה. בלי: לא מחכה לכלום. '
      + 'check ו-verify מגיעים מיד ' + G('אליו', 'אליה') + ' כהודעה בשיחה איתך, עם "עובד" ו"לא עובד", ו"לא עובד" מגיע לפותח המשימה. deploy לא מגיע ' + G('אליו', 'אליה') + ' אף פעם: מאחדים פריסות לבקשת GO אחת לפרויקט (request_go), ואחרי 6 שעות בלי פריסה ובלי בקשת GO hq מזכיר לך. '
      + 'רק מה שבאמת מחכה ' + G('לו', 'לה') + ' וחוסם: בלי ' + G('הבדיקה שלו', 'הבדיקה שלה') + ' או בלי הפריסה העבודה לא גמורה. הצעה, "אם בא לך" או משהו שאפשר לעשות בלי ' + G('אותו', 'אותה') + ' לא נכנסים ל-awaiting: כותבים אותם ב-tell. '
      + '/ only what truly waits on ' + G('him', 'her') + ' and blocks; a suggestion or an optional check goes in a tell. deploy = merged, waits for GO or a deploy; check = live, ' + G('he has', 'she has') + ' to check something ' + G('himself', 'herself') + '; verify = to check before release (a TestFlight build); none = clears'),
    awaiting_note: s('עם awaiting: שורה אחת במילים ' + G('שלו', 'שלה') + ', מה מחכה או מה לבדוק, פותחים במה מבקשים, e.g. "לבדוק בטלפון שתמונה נשלחת ועולה בצ\'אט" '
      + '/ with awaiting: one line in ' + G('his', 'her') + ' words, what waits or what to check'),
    pr: s('ה-PR שמוזג, מספר או קישור. פריסה שמדווחת עליו מנקה את deploy / the merged PR, number or url; a deploy that reports it clears deploy'),
  };

  // הערכות זמן (estimates.ts): a promise of "X יהיה מוכן תוך Y" goes in these fields, not only in the text. hq keeps the register,
  // answers with the company's calibration in a message, and closes it with the real time.
  // eta_at's "Israel time" is hq's default etaTimeZone (hq.config.json, #301); a company that changes it changes this text too.
  const etaArgs: Record<string, Schema> = {
    eta_min: { type: 'number', description: 'הערכה: בעוד כמה דקות יהיה מוכן מה שב-eta_what. או eta_at / estimate: minutes until eta_what is ready (or eta_at)' },
    eta_at: s('הערכה: באיזו שעה יהיה מוכן, HH:MM או תאריך ושעה מלאים. שעה בלי אזור זמן נקראת לפי שעון ישראל (Asia/Jerusalem), לא לפי שעון השרת. או eta_min / estimate: the time it will be ready, HH:MM or full ISO; a time with no zone is Israel time (Asia/Jerusalem), not the server\'s (or eta_min)'),
    eta_kind: oneOf(['small-fix', 'feature', 'investigation', 'report', 'build', 'deploy', 'release'],
      'סוג העבודה של ההערכה. release = שחרור לחנויות או שרשרת release, deploy = rollout לשרת, build = build או CI / kind of work; release = store release chain, deploy = server rollout'),
    eta_what: s('מה יהיה מוכן, בשורה אחת בעברית, e.g. "ה-PR מוכן לסקירה" / what will be ready, one line'),
    eta_done: { type: 'boolean', description: 'מה שהובטח ב-eta_what מוכן: סוגר את ההערכה הפתוחה עם הזמן האמיתי (בלי eta_what: האחרונה) / what was promised is ready: closes the open estimate with the real time' },
  };

  return [
    tool('tell', 'שליחת הודעה לעובד לפי identity. כשההודעה מבטיחה זמן ("יהיה מוכן בעוד שעה"), רושמים אותו בשדות eta_min או eta_at, eta_kind ו-eta_what, לא רק בטקסט; '
      + 'hq מחזיר הצעה לפי איך שהערכות כאלה יוצאות בפועל. כשזה מוכן: eta_done. Send a message to a teammate by identity. A message that promises a time goes in the eta_* fields, not only in the text.', {
      to: s('identity של הנמען / recipient identity, e.g. "dana"'),
      body: s('תוכן ההודעה / message text'),
      urgency: oneOf(['now', 'next', 'later'], 'now מעיר מיד (לא קוטע סבב שרץ), next ברירת מחדל, later לסוף התור / delivery priority'),
      fyi: { type: 'boolean', description: 'לידיעה בלבד: עדכון שלא מבקש מהנמען כלום ושאף אחד לא מחכה לו ("מחכה ל-X", "העברתי לדנה"). לא מעיר אותו, '
        + 'ונמסר בסבב הבא שלו. לא לשאלה, לבקשה, ל-"מוזג" או לכל דבר שמישהו מחכה לו / for the record only: never wakes the recipient, goes in with its next turn' },
      ref: s('מזהה הודעה שעליה עונים, e.g. m-8812 / message id being answered'),
      ...etaArgs,
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
      + 'אם משהו עוד מחכה ' + G('לו', 'לה') + ' (פריסה אחרי GO, או משהו ' + G('שהוא צריך', 'שהיא צריכה') + ' לבדוק ' + G('בעצמו', 'בעצמה') + '), מוסיפים awaiting ו-awaiting_note, ו-check או verify מגיעים ' + G('אליו', 'אליה') + ' כהודעה בשיחה עם "עובד" ו"לא עובד". '
      + 'המשימה נסגרת כשהסבב נגמר, ורק אם ענית על כל מה ' + pre('ש', O) + ' ' + G('שלח', 'שלחה') + ' לך. אחרת hq כותב לך "' + O + ' מחכה לתשובה על…" והיא נשארת פתוחה. '
      + 'The task closes when the turn ends, and only if every message ' + G('he', 'she') + ' sent you was answered; else hq tells you so and it stays open. '
      + 'Update your working status. With state "done" the task closes; always give summary: it is the line ' + G('he sees', 'she sees') + ' under "since you were here" '
      + 'and "what finished"; without it ' + G('he sees', 'she sees') + ' only the task title. '
      + 'If it still waits on something (a deploy, or something ' + G('he', 'she') + ' must check), add awaiting and awaiting_note: it shows under "what to check". '
      + 'הערכת זמן ("יהיה מוכן בעוד 40 דקות") נרשמת בשדות eta_min או eta_at, eta_kind ו-eta_what; אחרי done או eta_done היא נסגרת עם הזמן האמיתי. '
      + 'A time estimate goes in the eta_* fields; done or eta_done closes it with the real time.', {
      state: s('מצב, e.g. working | blocked | idle | done. בשרת השני: needs-local כשחסר משהו שיש רק בשרת הראשי, והמשימה עוברת לשם / state; on the second server, needs-local moves the task to the main one'),
      note: s('הערה קצרה / short note'),
      summary: s('ב-done: שורה אחת במילים ' + G('שלו', 'שלה') + ', מה השתנה ' + G('אצלו', 'אצלה') + ', בלי מספרי PR ובלי מונחים טכניים, e.g. "התמונות בצ\'אט עולות גם מהטלפון" '
        + '/ with done: one line in ' + G('his', 'her') + ' words on what changed for ' + G('him', 'her') + ', no PR numbers or jargon'),
      ...awaitingArgs,
      ...etaArgs,
    }, ['state']),
    tool('open_team', 'פתיחת צוות משימה: נכנס לתור, עובד חדש נפתח במשבצת פנויה ומדווח לך בסיום. עם assignee המשימה הולכת לעובד הקבוע שהתחום שלו: '
      + 'worktree משלה ו-session נקי, ואם הוא באמצע משימה אחרת היא מחכה בתור שלו. אם hq דוחה (למשל פרויקט רדום או assignee לא חוקי), הדחייה והסיבה חוזרות כשגיאה. '
      + 'משימה שהיא חלק ממאמץ גדול: name מתחיל בשם המאמץ, e.g. "מוצר גנרי, שלב 4: אפליקציה אחת לכל שרת". המאמץ שייך לך, והשיחה איתך היא הבית שלו. '
      + 'Open a task team: queued; a fresh worker starts in a free slot and reports back to you when done. With assignee it goes to that standing '
      + 'worker (own worktree, fresh session, one task at a time). A rejection by hq comes back as an error with the reason. '
      + 'A task that is part of a larger effort starts its name with the effort\'s name. '
      + 'עדיפות: priority 0-3 (0 הכי דחוף, ברירת מחדל 2). בלי priority, כותרת שמתחילה ב-p0 או p1 (גם p0: או אחרי רווח או סוגריים) מקבלת אותה עדיפות. '
      + 'Priority: priority 0-3 (0 most urgent, default 2). Without priority, a name starting with p0 or p1 (also "p0:", after a space or bracket) gets that priority.', {
      name: s('כותרת המשימה. חלק ממאמץ גדול: שם המאמץ קודם, e.g. "מוצר גנרי, שלב 4: …" / task title; part of a larger effort: the effort\'s name first'),
      purpose: s('מה בדיוק לעשות ואיך יודעים שזה גמור / what to do and the definition of done'),
      priority: { type: 'integer', minimum: 0, maximum: 3, description: 'עדיפות 0-3, 0 הכי דחוף, ברירת מחדל 2. גובר על p0/p1 בכותרת / priority 0-3, 0 most urgent, default 2; overrides a p0/p1 title prefix' },
      project: s('הפרויקט, e.g. agent-company (ברירת מחדל: הפרויקט שלך) / project (default: yours)'),
      ref: s('טיקט, e.g. hivecode-app/hive-code#11 / issue reference'),
      repo: s('ה-checkout מהאמנה (name), אם יש בפרויקט יותר מאחד. ברירת מחדל: הראשון / charter checkout name, default the first'),
      assignee: s('העובד הקבוע בפרויקט שהתחום שלו, e.g. ido. בלי: עובד זמני / standing worker of the project; default a temporary worker'),
      members: strs('identities של חברי הצוות / member identities'),
      local: { type: 'boolean', description: 'true כשהמשימה צריכה משהו שיש רק בשרת הראשי: מפתחות ssh, `.env`, kubectl, סודות של hq-host, דפדפן או סימולטור. בלי: רצה בשרת הפנוי, גם בשרת השני '
        + '/ true when the task needs what only the main server has (ssh keys, .env, kubectl, hq-host secrets, browser, simulator); default: whichever server has room, the second one included' },
      engine: { type: 'string', enum: ['claude', 'codex'], description: 'על מה העובד רץ. ברירת מחדל claude. codex רק בפרויקט שהאמנה שלו מדליקה אותו (`codex: { tasks: on-request }`), בלי assignee, '
        + 'ולמשימת קוד עם קריטריון ברור (בדיקות, typecheck). לא לפרודקשן, לדפדפן או לשיחה. כשמכסת Codex נגמרה, hq דוחה עם הסיבה ולא מעביר ל-Claude '
        + '/ which engine the worker runs on, default claude; codex only where the charter turns it on, with no assignee, for code work with a clear check' },
      model: s('רק עם engine codex: מודל Codex, e.g. gpt-6-astra. ברירת מחדל: מהאמנה / with engine codex only: the Codex model, default the charter\'s'),
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
    tool('withdraw_ask', 'סגירת שאלה שלך שההחלטה בה התקבלה בדרך אחרת, כדי שלא תישאר אצל ' + O + ' ב"מחכות לך". הקריאה מוחקת את הכרטיס ולא שולחת תשובה. '
      + 'Withdraw an ask of yours that was decided another way, so it does not stay in ' + O + '\'s decisions tab. The card is closed; no answer is sent.', {
      ask: s('מזהה השאלה (ה-ref שחזר מ-ask) / the ask id (the ref ask returned)'),
      note: s('למה נסגרה, שורה אחת בעברית / why it closed, one line in Hebrew'),
    }, ['ask']),
    tool('withdraw_go', 'סגירת בקשת GO שלך שההחלטה בה כבר התקבלה, כדי שלא תישאר אצל ' + O + ' ב"מחכה לך". '
      + 'approved_in_chat: ' + G('הוא אישר', 'היא אישרה') + ' בשיחה (למשל "יאללה נתקן") ואין צורך בלחיצה: חובה message, ה-msg_id של ההודעה ' + G('שלו', 'שלה') + ' שנכתבה אחרי שהכרטיס נפתח. '
      + 'hq בודק שההודעה אכן ' + pre('מ', O) + ' ושומר את הציטוט שלה כראיה ל-GO; הודעה שנקראת כדחייה לא מאשרת. '
      + 'withdrawn: הבקשה כבר לא רלוונטית, הכרטיס יורד ולא נרשם GO. רק מי שפתח את הבקשה, המנהל שלו או ' + n.manager.name + '. בקשת גישה (request_access) לא נסגרת כך. '
      + 'Close a GO request of yours that was already decided. approved_in_chat needs message = the msg_id of ' + G('his', 'her') + ' own message written after the card opened; hq checks it is from ' + G('him', 'her')
      + ' and keeps its quote as the evidence. withdrawn: no longer relevant, no GO is recorded.', {
      ref: s('מזהה הבקשה (ה-ref שחזר מ-request_go, או inbox-<מספר>) / the GO id (the ref request_go returned, or inbox-<n>)'),
      outcome: oneOf(['approved_in_chat', 'withdrawn'], 'approved_in_chat = אושר בשיחה, withdrawn = בוטל / approved in chat, or withdrawn'),
      message: s('עם approved_in_chat: ה-msg_id של ההודעה של ' + O + ' (מה שבסוגריים בכותרת ההודעה שהגיעה אליך) / with approved_in_chat: the msg_id of the owner\'s message'),
      note: s('למה, שורה אחת בעברית / why, one line in Hebrew'),
    }, ['ref', 'outcome']),
    tool('request_go', 'בקשת אישור לפעולה. מופיעה ' + G('אצלו', 'אצלה') + ' כהודעה בשיחה איתך עם כפתור GO: קודם headline, והפרטים (what) מקופלים. '
      + 'אישור או דחייה ברורים בשיחה (או הכפתור) סוגרים את הבקשה; כל מה אחר ' + G('שהוא כותב', 'שהיא כותבת') + ' מגיע אליך כהודעה רגילה והבקשה נשארת פתוחה. אם ההחלטה כבר התקבלה בשיחה ' + G('והוא', 'והיא') + ' לא לחץ/לחצה על הכרטיס, סוגרים אותו ב-withdraw_go. לא סוגרים את המשימה כל עוד היא פתוחה. '
      + 'Request a go-ahead before acting. ' + G('He sees', 'She sees') + ' it as a message in ' + G('his', 'her') + ' chat with you with a GO button: the headline first, '
      + 'the details (what) folded. Only a clear yes or no closes it; anything else ' + G('he types', 'she types') + ' reaches you as an ordinary message and the request stays open. The task is not closed while it is open.', {
      headline: s('שורה ראשונה קצרה במילים ' + G('שלו', 'שלה') + ', בלי מונחים טכניים, שאומרת מה מבקשים ממנו: מתחילה ב"להחליט אם…", '
        + 'e.g. "להחליט אם לפרוס את עדכון האפליקציה: תמונות בצ\'אט" / one short line in ' + G('his', 'her') + ' words that says what is asked, starting "להחליט אם…"'),
      what: s('הפרטים: מה נכנס, סיכון ואיך חוזרים אחורה (מקופלים) / details: what ships, risk, rollback (folded)'),
      pr: s('קישור או מספר PR. קישור מלא הופך לכפתור "ה-PR" בהחלטה / PR url or number; a full https link becomes the PR button'),
      report: s('קישור לדוח המלא (https), אם יש. כפתור "הדוח המלא" בהחלטה / link to the full report (https), if any'),
      risk: oneOf(['low', 'medium', 'high'], 'רמת סיכון / risk level'),
    }, ['headline', 'what']),
    tool('compose_home', 'הרכבת ראש מסך השיחות של ' + O + ': אילו בלוקים, באיזה סדר ובאיזה ניסוח. רק ' + (n.composer ? `${pre('ל', n.composer.name)} ${pre('ו', pre('ל', n.manager.name))}` : pre('ל', n.manager.name)) + '. '
      + 'האפליקציה מציירת כל בלוק מקומפוננטה קבועה וממלאת אותו מנתונים חיים, ולכן מפנים לנתונים לפי מזהה, והטקסט בעברית. '
      + 'אוצר הבלוקים: '
      + 'headline {text} משפט אחד. מה שמחכה ' + G('לו', 'לה') + ' מוצג בשורה נעוצה משלו בראש השיחות ("3 מחכות לך"), ולכן לא כותבים בו כמה מחכה ' + G('לו', 'לה') + ' · alert {shift: מזהה משמרת} תקלה שאין עליה החלטה, למשל משמרת תקועה · '
      + 'tasks {tasks: [מזהי משימות] או "open"} בעבודה ובתור: משימות פתוחות עם מי פתח, מי עובד והמצב. "open" מציג את כולן, ורשימה מציגה משימה מסוימת (למשל דחופה) · '
      + 'lanes {projects: [ids]} פסי היום · '
      + 'project {project, note?} שתי שורות · quiet {projects: [ids]} שורה אחת בסוף, "שקט גם ב: …", לפרויקטים שלא זזו · people {identities: [ids], caption?} · since {items: [עד 3: משפט, או {text, task: מזהה משימה}]}, עם task השורה מובילה לשיחה עם מי שעשה את המשימה · '
      + 'note {text, icon} הערה שלך, icon הוא שם של Material Symbol. לכל בלוק אפשר emphasis: normal|quiet|strong (טיפוגרפיה בלבד). '
      + 'ההחלטות (GO, שאלות, בדיקות, תקלות עם תשובה) לא בבית: הן בשורה "מחכות לך" בראש השיחות, ו-waiting, asked, awaiting ו-alert על inbox לא מוצגים (אם הם מגיעים, מדלגים עליהם בשקט). '
      + 'בלוק לא מוכר, שדה חסר או הפניה שלא קיימת נדחים עם הסיבה. מה שנסגר נעלם לבד. '
      + 'מתכון ישן מ-30 דקות מתחלף בברירת המחדל של hq. '
      + 'דוגמה: [{"type":"headline","text":"בוקר שקט, שתי משימות רצות"},'
      + '{"type":"lanes","projects":["agent-company","lumo"]},{"type":"project","project":"lumo","note":"מחכה ל-GO על 2.6.10"},'
      + '{"type":"note","text":"שווה לבדוק את הפריסה של 2.6.10","icon":"rocket_launch","emphasis":"quiet"}] '
      + "Compose the head of the owner's conversations screen from the fixed block vocabulary above (Hebrew text, data by reference).", {
      blocks: { type: 'array', items: { type: 'object' }, description: 'הבלוקים לפי הסדר / the blocks, in order' },
      reason: s('למה ההרכבה הזו, בשורה / why this composition, one line'),
    }, ['blocks']),
    tool('request_access', 'הרצת פקודה על שרת, קלאסטר או מסד של החברה בשמך, בלי שיהיו לך המפתחות. hq בונה את הפקודה בעצמו מרשימות סגורות, מריץ אותה ומחזיר את הפלט. '
      + 'resource: `kube:<שם>` (kubectl ב-namespace כפוי), `ssh:<שם>` (פקודה מרשימה), `build:<שם>` (docker build ו-push של קומיט ל-ghcr.io/hive-owner/*; argv = [repo, sha מלא, נתיב Dockerfile, תג מלא, context אופציונלי]; מחזיר digest, ו-push אינו פריסה) או `hq:query` (SELECT על hq.db). argv: המילים של הפקודה, בלי הקידומת (`["get","pods"]`, לא `kubectl get pods`). '
      + 'מותר: get, describe, logs --tail, rollout status|history|restart|undo, set image, scale, delete pod/<name>, exec <pod> -- <פקודה>. לא נתמך: `-f`, port-forward, apply, מעטפת אינטראקטיבית. הדגלים --kubeconfig, --token, --as ו-`-n` של namespace אחר נדחים תמיד. '
      + 'מחוץ לפרודקשן (dev, ci, hq:query) הכול רץ מיד. בפרודקשן קריאה רצה מיד, וכל שינוי או exec, בכל פעם, מגיע ' + pre('ל', O) + ' ככרטיס עם הפקודה המדויקת: התשובה היא status pending, ממשיכים במה שלא תלוי בה, וחוזרים עם request. '
      + 'לא יודעים איזה משאב? לא מנחשים: שם שלא קיים חוזר עם unfit, וה-hint שלו מונה את המשאבים שפתוחים למשימה ואת הפקודות שמותרות בכל אחד. '
      + 'פקודה ארוכה חוזרת אחרי עד 90 שניות עם status running ו-request, וממשיכים לקרוא באותו request (הפלט נשמר). פקודה שלא ברשימה חוזרת עם unfit והצעה: לא מנסים לעקוף, ואם אין חלופה, `status` עם needs-local. '
      + 'Run a command on a company server, cluster or database in your name, without holding the keys. hq builds it from closed lists and returns the output. Pending approval or a long run: come back with `request`.', {
      resource: s('kube:<name> | ssh:<name> | build:<name> | hq:query'),
      argv: strs('מילות הפקודה בלי הקידומת, למשל ["rollout","status","deploy/api","--timeout=5m"]; ב-hq:query מחרוזת SQL אחת / the words of the command without the prefix; for hq:query one SQL string'),
      why: s('למה, שורה בעברית: ' + G('הוא', 'היא') + ' רואה את זה בכרטיס / why, one line in Hebrew'),
      request: s('acc-N: ממשיכים בקשה שחזרה pending או running / continue a request that came back pending or running'),
      cancel: s('acc-N: מבטלים בקשה שמחכה או רצה / cancel a request that waits or runs'),
      wait: { type: 'number', description: 'כמה שניות להמתין לתוצאה או לאישור, עד 100 (ברירת מחדל 90) / seconds to wait for the result or approval, up to 100 (default 90)' },
    }, []),
    tool('resources', 'מצב המשאבים של השרתים, קריאה בלבד: בכל מכונה זיכרון, עומס ודיסק, מי מחזיק בהם לפי פרויקט (כולל "לא מזוהה" עם שם ה-cgroup או הקונטיינר), ומי מחכה למקום. '
      + 'קוראים לפני build מלא, `flutter test` מלא, docker או smoke, ואחרי שמשהו נתקע על "השרת עמוס". חלק שלא נמדד כתוב "לא נמדד", ואין לקרוא אותו כתקין. הזיכרון לפי פרויקט הוא anon של ה-cgroup (בלי page cache), ולכן הסכום קרוב ל"בשימוש". '
      + 'Read-only: per machine memory, load and disk, who holds them by project (unidentified ones with their cgroup/container name), and who waits for room. Call before a heavy build, full test run, docker or smoke.', {}, []),
    tool('reserve', 'הזמנת מקום לפני פקודה כבדה בשרת המשותף: build מלא, `flutter test` מלא, `docker build`/`compose up` או smoke. hq מחזיר אחת משלוש תשובות: '
      + 'granted (יש מקום: מריצים דרך `company-run --lease <lease> -- <הפקודה>`, וההזמנה משתחררת לבד כשהפקודה נגמרת), '
      + 'queued (אין מקום עכשיו: התשובה חוזרת תוך עד 90 שניות עם מי מחזיק, המקום בתור והערכה; ממשיכים במה שלא תלוי בזה וחוזרים עם `lease` כדי להמשיך מאותו מקום בתור) '
      + 'או unavailable (לא יהיה מקום, או שהמחלקה לא מוגדרת; עם חלופה). משימה דחופה (p0) לא נעקפת, ו-hq לא עוצר הזמנה קיימת בשבילה. '
      + 'הזמנה משתחררת לבד בסוף הפקודה, אחרי התקרה של המחלקה (ברירת מחדל 30 דקות) ובסגירת המשמרת. '
      + 'Reserve a place before a heavy command on the shared server (full build, full flutter test, docker, smoke). granted → run it with company-run; queued → come back with `lease` to keep your place; unavailable → see the alternative.', {
      class: s('המחלקה: build | test-full | docker | smoke, או מחלקה שהאמנה של הפרויקט מגדירה בבלוק heavy / the class of work'),
      machine: s('המכונה (ברירת מחדל: זו של המשמרת שלך), local או שם של node / the machine, default: your shift\'s'),
      note: s('מה מריצים, שורה בעברית: מופיע למי שמחכה / what you run, one line in Hebrew'),
      lease: s('lease-N: ממשיכים הזמנה שחזרה queued, באותו מקום בתור / continue a queued lease from the same place in the queue'),
      wait: { type: 'number', description: 'כמה שניות להמתין למקום, עד 100 (ברירת מחדל 90) / seconds to wait for a place, up to 100 (default 90)' },
    }, []),
    tool('release', 'שחרור הזמנה (`reserve`) כשהמקום לא נחוץ יותר, או ביטול הזמנה שמחכה בתור. לא חובה אחרי `company-run`: הוא משחרר לבד בסוף הפקודה. '
      + 'Release a lease, or leave the queue. Not needed after company-run: it releases when the command ends.', {
      lease: s('lease-N / the lease id'),
    }, ['lease']),
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
  tell: ['body'], ask: ['question'], withdraw_ask: ['note'], withdraw_go: ['note'], request_go: ['what'], open_team: ['purpose'], open_ticket: ['body'], request_access: ['why'], reserve: ['note'],
};
const HEBREW_TITLE: Partial<Record<ToolDef['name'], string[]>> = {
  open_team: ['name'], open_ticket: ['title'], ask: ['headline'], request_go: ['headline'],
  tell: ['eta_what'], status: ['awaiting_note', 'eta_what'], close_team: ['awaiting_note'],
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
