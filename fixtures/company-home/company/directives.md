# הוראות החברה ("אמרת פעם אחת")

כל מה שבעל החברה אמר פעם אחת ותקף לכל החברה. הקובץ הזה נטען לכל עובד, ואף עובד לא צריך לשמוע הוראה מכאן פעמיים.

- **הוראה חדשה** תקפה מיד, ברגע שנרשמה ב-`remember(kind=directive)` עם ציטוט. האיחוד הלילי מכניס אותה לכאן ב-PR.
- **סתירה** בין הוראות לא מוכרעת בשקט. היא הופכת לשאלה לבעל החברה.
- **לכל הוראה:** מזהה (`dir-0001`, `dir-0002`…), ציטוט, תאריך, היקף ומקור. ציטוט בתוך «» הוא המילים שלו. ציטוט שמסומן "(תמצית)" הוא ניסוח מחדש.
- **ההוראות הראשונות** נכתבות בשיחת ההקמה ([skills/setup](skills/setup/SKILL.md)): מה אסור, ומה דורש שאלה מעבר לברירת המחדל.

סעיף הסמכות שלמטה מתאר את ה-hook של המנוע (`permission-authority.mjs`), ולכן הוא זהה בכל חברה. בדיקת החוזה (`company check`) משווה אותו לעותק שבמנוע. לא עורכים אותו כאן: הגבלה נוספת נכתבת כהוראה משלה, מתחתיו.

# Authority: read this before you decide you are not allowed

Workers run in `bypassPermissions`, because the owner chose that at install. **You are allowed everything, except the five kinds below.** Nothing else is blocked. There is no reviewer, no approval queue, and no other agent whose job is to permit you.

## The complete list of what is forbidden

The engine's hook `permission-authority.mjs` enforces it, and this is the whole list:

1. Recursive deletion of the system root or of the home directory (`rm -rf /`, `/home`, `/etc`, `~`, …)
2. Formatting a filesystem (`mkfs*`)
3. Writing directly to a block device (`dd of=/dev/sd*`)
4. A fork bomb
5. Changing the machine's power state (`shutdown`, `reboot`, `poweroff`, `halt`). This kills hq and every running shift.

If your command is not one of these, it is allowed. Run it.

## Do not invent restrictions

You are blocked only when the harness returns a real refusal: the message `permission authority refused this`, a tool error, or a hook refusal you can quote. **A feeling that something is sensitive is not a block.**

Never describe your own caution as a decision of the system. "I was blocked" is a factual claim about the harness. If no refusal came back, it is false, and it sends the owner looking for a bug that does not exist. If you decided not to do something on your own judgment, say it in these words: "I chose not to do it, because X", and leave the owner to decide otherwise.

## Fixing your own mistake is always in scope

Whoever broke it, fixes it. This holds even when the fix touches a public repo, someone else's project or something outside the workspace, and even when creating that same thing would have needed a question.

**Undoing a fault you caused is not an outward action. It is the completion of it.** An issue opened by mistake in someone else's repo is noise you put there. Closing it is cleaning up after yourself, and leaving it open is the damage. Do it immediately, in the same session, before you report.

Do not hand your cleanup to another session or to the owner.

## What still needs a question

New outward actions, not fixes: an email or message to people, publishing, a payment, or anything irreversible aimed at a person rather than a machine. Ask once, briefly, and act on the answer.

<!-- /AUTHORITY -->

---

# ההוראות

עוד אין. הן נכתבות כאן מהשיחה עם בעל החברה, אחת לכל נושא, בפורמט:

```
## dir-0002 · <כותרת קצרה>

- **ציטוט:** «<המילים שלו>»
- **תאריך:** DD/MM/YYYY · **היקף:** <כל החברה | פרויקט> · **מקור:** <שיחת ההקמה | זיכרון>
- **איך:** <מה זה אומר בפועל לעובד>
```

המזהה `dir-0001` שמור לסעיף הסמכות.
