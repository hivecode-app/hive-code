---
name: verify
description: Verify that a change really works before claiming it is done, in the agent company. Use before saying "done", before requesting review, before merging, and before asking for GO. Runs the project's checks and a real end-to-end proof, and reports evidence, not impressions.
---

# אימות לפני "גמרתי"

"עובד" זו טענה עם ראיה. בלי ראיה, כותבים "לא אימתתי" ולמה.

## שלבים

1. **מה צריך להיות נכון?** כתוב בשורה אחת או שתיים מה המשימה הבטיחה, במונחים שאפשר לבדוק.
2. **הבדיקות של הפרויקט**, לפי האמנה (`company/projects/<p>.md`, טבלת "פקודות"): בדיקות, typecheck, lint, build. כשהחוזה (`company/`, `memory/`) השתנה, גם `company check`.
3. **הוכחה אמיתית מקצה לקצה**, לא רק יחידה: להריץ את ה-CLI, לקרוא ל-endpoint, לפתוח את המסך, לשחזר את הבאג ולראות שהוא נעלם.
4. **בדוק את הקבצים ששינית** לסימנים של עבודה לא גמורה: placeholder, stub, `test.skip`, `.only`, ענף שלא מומש, קוד debug שנשכח.
5. **כשל שלא קשור אליך:** אם בדיקה נכשלה גם לפני השינוי שלך, הראה את זה (הרצה על `main`), רשום אותו כלקח בזיכרון הפרויקט, ואל תסתיר אותו.

## הפלט

```
### אימות
- <פקודה> → <תוצאה: עבר / נכשל, עם השורה הרלוונטית>
- הוכחה: <מה הרצתי ומה ראיתי>
- לא אומת: <מה, ולמה>
```

## כללים

- אין שקט מזויף. בדיקה שלא רצה לא "עברה".
- אם האימות נכשל, ממשיכים לתקן. לא מדווחים "גמרתי".
- פריט שאי אפשר לאמת כאן (למשל דורש את הטלפון של בעל החברה) נכתב במפורש ב"לא אומת".
