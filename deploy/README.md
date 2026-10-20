# פריסה

**יש דרך אחת לפרוס, והיא `scripts/deploy.sh`.** לא עורכים שום דבר ביד בשרת: לא את `/etc/caddy`, לא יחידות systemd, ולא את `/var/www/hq-app`. כל שינוי נכנס ב-PR, ואחרי המיזוג מריצים:

```bash
cd ~/projects/agent-company
scripts/deploy.sh all          # או hq | app | caddy
```

ספר ההפעלה: [docs/RUNBOOK.md](../docs/RUNBOOK.md).

## מה הסקריפט עושה

1. **בדיקה מקדימה.** רץ רק מ-`~/projects/agent-company` (משם hq רץ), על `main` נקי. אם `origin/main` מקדים, הוא עושה fast-forward. אם הענף התפצל או שיש שינויים מקומיים, הוא נעצר. הפריסה הראשונה חייבת להיות `all`, כי היא זו שממירה את ה-Caddyfile הראשי. ‏`npm ci` רץ רק כש-`package-lock.json` השתנה, כדי לא להחליף את `node_modules` מתחת ל-hq שרץ.
2. **בדיקות.** `npm ci`, ‏contract, ‏`test:deploy`, ‏typecheck ו-`npm test`. ל-`app` ול-`all` גם `flutter analyze` ו-`flutter test`.
3. **פריסה** של היעד:
   - **`hq`:** כותב את `~/.config/agent-company/hq.env` (הרשאות 600) מתוך `.env` של dictate-server. מקשר ל-`~/.config/systemd/user` את `agent-company-hq`, ‏`actions-runner-company` ו-`agent-company-drift` (service ו-timer), ומתקין עותק של vscode-workspace. אחרי זה `daemon-reload` ו-restart ל-hq. בסוף בודק ש-`/health` חזר, ושכל יחידות `company-shift@` שרצו לפני ה-restart עדיין רצות.
   - **`app`:** בונה web בשורש ו-APK ‏(arm64, עם `HQ_URL=https://app.hq.example.com/hq`). בודק את הגודל ואת חתימת השחרור, ואז כותב release ב-`/var/www/hq-app/releases/<sha>/` (web, ‏`agent-company.apk`, ‏`.well-known/assetlinks.json`). ההחלפה היא symlink אטומי `current`. נשמרים ה-release הנוכחי, הקודם ושלושת האחרונים.
   - **`caddy`:** מתקין את `deploy/caddy/agent-company.caddy` ל-`/etc/caddy/sites/agent-company.caddy`. ב-Caddyfile הראשי הוא מוודא שיש שורת `import sites/*.caddy` אחת ואין אף בלוק של החברה (`scripts/caddy-main.mjs`). בלוקים של אתרים אחרים (desk, ‏dictate, ‏calltr, ‏k8s) נשארים כמו שהם. ההגדרה נבדקת ב-`caddy validate` לפני ההתקנה, ואחרי זה `reload`.
4. **אימות מקצה לקצה** (`scripts/verify-prod.mjs`), מבחוץ כמו טלפון:
   - `/health` עונה.
   - בלי טוקן נחסמים `/api/board`, ‏WS והכתבה.
   - קוד צימוד הופך ל-token של מכשיר. איתו `/api/board` עונה 200, ה-WS נפתח, וההכתבה עוברת דרך hq. בסוף מכשיר הבדיקה מבוטל, וה-token שלו נחסם.
   - האפליקציה נטענת בשורש, ‏assetlinks מוגש, וה-APK להורדה, בגודל סביר וחתום במפתח ש-hq מכיר.
   - `tab.hq` מגיע למסירת הטאב של hq (‏`127.0.0.1:7422`), ורק ל-`/h/` ול-`/ws/`.
   - הנתיב הישן מפנה לשורש.
5. **חזרה אחורה.** כל כישלון מחזיר את מה שהריצה הזאת שינתה: את Caddy מהעותק ב-`~/.local/state/agent-company/deploy/caddy-prev/`, את האפליקציה ל-release הקודם, ואת ה-checkout ל-commit הקודם, עם restart ל-hq. קוד היציאה לא אפס.
6. **סיכום בעברית** בסוף הפלט, ונשמר גם ב-`~/.local/state/agent-company/deploy/last-summary.txt`.

## hq: מה צריך לדעת

- **מצב:** `~/.local/state/agent-company/` (`hq.db` WAL, `api-token`, `vapid.json`, `hq.sock`, `backups/`, `shifts/`). כולם במצב 600.
- **`hq.sock`:** ה-ingest של mcp-company וה-hooks (`/v1/ops`, `/v1/recall`, לפי `packages/shared/src/company-api.ts`). בלי טוקן, ההרשאה היא הרשאת הקובץ.
- **משמרות:** כל משמרת היא מופע של `packages/shift-host/systemd/company-shift@.service`. hq מקשר את ה-template ל-`~/.config/systemd/user` בהפעלה הראשונה, כותב `shifts/<shift>/host-args.json` (עם `shift` ו-`shift-no` מה-store), ומריץ `enable --now`. משמרת שהופעלה ב-enable חוזרת אחרי אתחול. כשמשמרת נגמרת, hq מריץ עליה `disable --now`.
- **טוקן ל-API:** `node packages/hq/src/main.ts token`.
- **גיבוי ידני:** `node packages/hq/src/main.ts backup`. בנוסף hq מגבה כל שעה לבד, ושומר 48 אחרונים.
- **הגדרות:** `~/.local/state/agent-company/hq.config.json` דורס ברירות מחדל (פורט, טיימרים, RSS לנוסחת הקיבולת, פקודת ה-launch של shift-host). למשל `{"healthListen": "0.0.0.0:7421"}` פותח listener נוסף שמגיש רק `/health`.
- **מסירת טאב (B.9):** hq מאזין גם על `127.0.0.1:7422` (`tab.listen` ב-`hq.config.json`, `null` מכבה) ומגיש שם רק את דף הטלפון (`/h/<token>`, `/ws/<token>`). הבלוק `tab.hq` ב-`deploy/caddy/agent-company.caddy` מחבר אליו את `tab.hq.example.com`. ה-CDP של ה-Chrome המשותף: `tab.cdpUrl` (ברירת מחדל `http://127.0.0.1:9222`). `browser_ask_user` של browser-memory יוצר מסירה דרך `hq.sock`.

## סודות

- אין סודות ב-git וגם לא ב-Caddy. ‏hq בודק כל token בעצמו.
- **`~/.config/agent-company/hq.env`** (הרשאות 600): היום רק `DICTATE_TOKEN`, הטוקן ש-hq שולח ל-dictate-server. הסקריפט כותב אותו מ-`~/projects/dictate-server/server/.env`, ולכן מקור האמת הוא dictate-server.
- **הטוקן של hq** (`~/.local/state/agent-company/api-token`) ומפתח החתימה של האנדרואיד (`~/.local/state/agent-company/android/`) נשארים בשרת.

## בדיקת סטייה (נגה)

`scripts/drift-check.sh` בודק בלי לשנות כלום שהפרודקשן הוא בדיוק מה ש-`deploy.sh` היה בונה מ-`origin/main`:

- ה-checkout נקי ועל `origin/main`.
- hq והאפליקציה רצים על הקוד של main.
- קובצי Caddy תואמים.
- היחידות מקושרות.
- ל-hq.env יש הרשאות 600.
- אין גיבויי Caddyfile ידניים של החברה, ואין שאריות ב-`/var/www/hq-app`.
- הנתיב הישן לא נשאר אחרי מועד ההסרה.

`agent-company-drift.timer` מריץ אותו כל לילה ב-03:40 (שעון בנגקוק), עם `--report`. כל סטייה נכנסת לתיבה של רן מנגה. האוטומציה היא `noga/drift-check` ב-`company/org.yaml`, ואפשר לכבות אותה בלוח. התיקון לסטייה הוא תמיד פריסה מה-repo.

## heartbeat חיצוני מ-ci-host (B.17)

ci-host היא מכונה אחרת, ולכן היא לא חלק מ-`deploy.sh`. **מותקן מ-20/10/2026.** נבדק בכיבוי של hq: הטלגרם הגיע אחרי 205 שניות, והודעת "חזר" הגיעה בדקה שאחרי ההפעלה. הפקודות למטה הן להתקנה מחדש.

התקנה (ב-ci-host linger כבר מופעל):

```bash
# מ-hq-host
scp -i ~/.ssh/ci2_ed25519 deploy/ci-host/heartbeat.sh deploy/ci-host/agent-company-heartbeat.{service,timer} ran@203.0.113.11:/tmp/
ssh -i ~/.ssh/ci2_ed25519 ran@203.0.113.11 '
  mkdir -p ~/agent-company-heartbeat ~/.config/systemd/user ~/.config/agent-company
  mv /tmp/heartbeat.sh ~/agent-company-heartbeat/ && chmod +x ~/agent-company-heartbeat/heartbeat.sh
  mv /tmp/agent-company-heartbeat.service /tmp/agent-company-heartbeat.timer ~/.config/systemd/user/'
# טוקן הבוט: אותו בוט ש-~/bin/telegram-send משתמש בו
TOKEN=$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.openclaw/openclaw.json")))["channels"]["telegram"]["botToken"])')
ssh -i ~/.ssh/ci2_ed25519 ran@203.0.113.11 "umask 077; cat > ~/.config/agent-company/heartbeat.env" <<EOF
HQ_HEALTH_URLS="https://api.hq.example.com/health"
TELEGRAM_BOT_TOKEN=$TOKEN
TELEGRAM_CHAT=100000001
HQ_HOST_HOST=203.0.113.10
EOF
ssh -i ~/.ssh/ci2_ed25519 ran@203.0.113.11 'systemctl --user daemon-reload && systemctl --user enable --now agent-company-heartbeat.timer'
```

בדיקה (מבחן קבלה 5 של שלב 1): `systemctl --user stop agent-company-hq` ב-hq-host. תוך 3 דקות מגיעה הודעה מ-ci-host, ואחרי `start` מגיעה הודעת "חזר".
