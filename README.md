# agent-company

חברת הסוכנים של רן. האפיון נמצא ב-[docs/SPEC.md](docs/SPEC.md).

החברה עצמה (החוזה והזיכרון) לא כאן: היא ב-repo משלה, `hive-owner/my-company`, ב-`~/company` (`COMPANY_HOME`, [docs/generic/split-runbook.md](docs/generic/split-runbook.md)).

| תיקייה | מה יש בה |
|---|---|
| `starter/` | השלד שממנו חברה חדשה מתחילה: החוזה (`company/`) והזיכרון (`memory/`) |
| `fixtures/company-home/` | חברה לדוגמה שהבדיקות של המנוע רצות עליה |
| `adapter/contract.yaml` | הממשקים הפנימיים של Claude Code שאנחנו נשענים עליהם, ובדיקת canary לכל אחד |
| `packages/hq` | התהליך המרכזי: store, תיבות דואר, inbox, מתזמן, watchdog, probes, API |
| `packages/shift-host` | תהליך לכל משמרת, שמחזיק את `claude -p` stream-json |
| `packages/adapter` | המודול היחיד שמכיר את Claude Code |
| `packages/mcp-company` | ה-MCP `company` (stdio, לכל משמרת) |
| `packages/hooks` | hooks מסוג command, שכותבים ל-spool |
| `packages/app` | האפליקציה: Flutter לאנדרואיד ול-web ([docs/app/APP-SPEC.md](docs/app/APP-SPEC.md)) |
| `spikes/` | ניסויי שער ההיתכנות |
