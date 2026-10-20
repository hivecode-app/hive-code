# דוגמאות להעתקה

מה שהמנהל מעתיק ומתאים בשיחת ההקמה ([skills/setup](../company/skills/setup/SKILL.md)), ומה שכל עובד מעתיק כשהוא מוסיף פרויקט או זהות אחר כך. הדוגמאות מראות צורה, לא תוכן: השמות, הכתובות והפקודות כאן מומצאים.

| קובץ | מה יש בו |
|---|---|
| [org-additions.yaml](org-additions.yaml) | מה נכנס ל-`company/org.yaml` לכל פרויקט פעיל: רשומה ב-`projects`, צוות, ראש צוות. ובנוסף צוות ניטור |
| [projects/example-app.md](projects/example-app.md) | אמנת פרויקט: `checkouts`, `commands`, `ci_check`, חריגה עם סיבה, ו-probe בסיסי |
| [projects/old-site.md](projects/old-site.md) | אמנה של פרויקט רדום: בלי צוות ובלי checkouts |
| [identities/aviv.md](identities/aviv.md) | תיק של ראש צוות פרויקט, עם חמשת הסעיפים שהבדיקה דורשת |
| [identities/hadar.md](identities/hadar.md) | תיק של ראש צוות הניטור |

**ה-probe** יושב באמנה של הפרויקט, ברשימה `monitoring`. ה-probe-runner של hq מריץ אותו כשהאוטומציה `prod-probes` של ראש צוות הניטור דולקת. היום הוא תומך ב-`http` בלבד (GET, בלי טוקנים). סוג אחר נרשם כ"לא נתמך" ולא נבלע בשקט.

`company check` רץ על הדוגמאות האלה בבדיקות של המנוע (`scripts/check-contract.test.mjs`): הן מוכנסות לשלד, והחוזה שנוצר חייב לעבור.
