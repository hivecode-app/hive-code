# פריסה

## hq ב-hq-host

**מופעל מ-20/10/2026** (ספר ההפעלה: [docs/RUNBOOK.md](../docs/RUNBOOK.md)). linger מופעל ל-ran ב-hq-host (`loginctl show-user ran -p Linger` → `Linger=yes`), ולכן יחידות `--user` שורדות logout.

```bash
mkdir -p ~/.config/systemd/user
ln -sf ~/projects/agent-company/deploy/agent-company-hq.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now agent-company-hq
journalctl --user -u agent-company-hq -f
```

- **מצב:** `~/.local/state/agent-company/` (`hq.db` WAL, `api-token`, `vapid.json`, `hq.sock`, `backups/`, `shifts/`). כולם במצב 600.
- **`hq.sock`:** ה-ingest של mcp-company וה-hooks (`/v1/ops`, `/v1/recall`, לפי `packages/shared/src/company-api.ts`). בלי טוקן, ההרשאה היא הרשאת הקובץ.
- **משמרות:** כל משמרת היא מופע של `packages/shift-host/systemd/company-shift@.service`. hq מקשר את ה-template ל-`~/.config/systemd/user` בהפעלה הראשונה, כותב `shifts/<shift>/host-args.json` (עם `shift` ו-`shift-no` מה-store), ומריץ `enable --now`. משמרת שהופעלה ב-enable חוזרת אחרי אתחול. כשמשמרת נגמרת, hq מריץ עליה `disable --now`.
- **טוקן ל-API:** `node packages/hq/src/main.ts token`.
- **גיבוי ידני:** `node packages/hq/src/main.ts backup`. בנוסף hq מגבה כל שעה לבד, ושומר 48 אחרונים.
- **הגדרות:** `~/.local/state/agent-company/hq.config.json` דורס ברירות מחדל (פורט, טיימרים, RSS לנוסחת הקיבולת, פקודת ה-launch של shift-host). למשל `{"healthListen": "0.0.0.0:7421"}` פותח listener נוסף שמגיש רק `/health`.
- **כתובת ציבורית:** `deploy/caddy/hq.caddy` מוסיף את `api.hq.example.com` ל-Caddy. מוסיפים אותו רק אחרי ש-hq רץ.

## heartbeat חיצוני מ-ci-host (B.17)

**מותקן מ-20/10/2026.** נבדק בכיבוי של hq: הטלגרם הגיע אחרי 205 שניות, והודעת "חזר" הגיעה בדקה שאחרי ההפעלה. הפקודות למטה הן להתקנה מחדש.

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
