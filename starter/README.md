# ערכת הפתיחה

מה שההתקנה מעתיקה ל-`COMPANY_HOME` (ברירת מחדל `~/company`) בחברה חדשה, כ-repo git מקומי. התוכנית: [docs/generic/PLAN.md](../docs/generic/PLAN.md), סעיפים 3 ו-4.

| מה | למה |
|---|---|
| `company/company.md` | החוזה: עקרונות, אמנת ברירת המחדל, מה דורש שאלה |
| `company/directives.md` | סעיף הסמכות של המנוע (חמשת הסוגים שה-hook חוסם), ומקום להוראות |
| `company/org.yaml` | שלד: מנהל אחד עם שם זמני, `setup: pending`, בלי צוותים ופרויקטים |
| `company/identities/manager.md` | התיק של המנהל |
| `company/skills/` | `setup` (שיחת ההקמה), `reviewer`, `verify`, `ship` |
| `company/modes/night.md` | מצב לילה |
| `memory/` | `README.md`, ספר עיצוב בסיסי, מוסכמות, ותבנית `machines.md` |
| `examples/` | אמנת פרויקט, תיקי זהות, probe, ומה מוסיפים ל-`org.yaml` |

**מה בודק אותה:** `npm run check:starter` (בתוך `npm run check:contract` של ה-CI). כל עוד `setup: pending`, הבדיקה מקבלת שם בעלים ואזור זמן ריקים. בסוף שיחת ההקמה המנהל מוחק את השורה, ומאותו רגע הם חובה.

**סעיף הסמכות** בערכה מסתיים ב-`<!-- /AUTHORITY -->`. בחברה שהוקמה ממנה, `company check` משווה אותו לעותק שכאן. אם ה-hook משתנה, משנים את הסעיף כאן באותו PR.

הערכה בעברית, כמו המנוע. השמות בדוגמאות מומצאים, והמנהל מציע שמות חדשים לפי מה שבעל החברה בוחר.
