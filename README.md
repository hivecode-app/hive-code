# agent-company

חברת הסוכנים של רן. האפיון נמצא ב-[docs/SPEC.md](docs/SPEC.md).

| תיקייה | מה יש בה |
|---|---|
| `company/` | החוזה: הארגון, הזהויות, האמנות, המצבים וה-skills. משנים אותו רק ב-PR |
| `memory/` | הזיכרון המאוחד, L3 |
| `adapter/contract.yaml` | הממשקים הפנימיים של Claude Code שאנחנו נשענים עליהם, ובדיקת canary לכל אחד |
| `packages/hq` | התהליך המרכזי: store, תיבות דואר, inbox, מתזמן, watchdog, probes, API |
| `packages/shift-host` | תהליך לכל משמרת, שמחזיק את `claude -p` stream-json |
| `packages/adapter` | המודול היחיד שמכיר את Claude Code |
| `packages/mcp-company` | ה-MCP `company` (stdio, לכל משמרת) |
| `packages/hooks` | hooks מסוג command, שכותבים ל-spool |
| `packages/app` | ה-PWA |
| `spikes/` | ניסויי שער ההיתכנות |
