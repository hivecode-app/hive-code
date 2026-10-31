#!/usr/bin/env bash
# noga/drift-check (company/org.yaml): is production what was deployed and approved? Read-only: it changes
# nothing on the server.
#
# Drift is production differing from what deploy.sh put there: hand edits, a checkout moved without a deploy
# (a manual git pull), live config that differs from main, a unit or Caddy file changed. Production BEHIND
# origin/main is not drift ("deploy only after GO"): that is a summary of merged and not deployed (what waits
# for a GO or a deploy comes from hq, /api/deploys/waiting), and opens nothing. The judgement is in drift-lib.mjs.
#
#   scripts/drift-check.sh            prints every difference; exit 1 when there is one
#   scripts/drift-check.sh --report   the same, and puts the differences in the owner's inbox (from
#                                     noga), unless the automation is switched off on the board.
#                                     Run nightly by deploy/agent-company-drift.timer.
#
# Checks: the production checkout (clean main, exactly a deployed commit), hq and the app running what main has,
# the Caddy files (ours in /etc/caddy/sites, and only one import line of ours in the main Caddyfile),
# the user units, hq.env, hq.config.json, the old secret path, and leftovers of hand edits.
set -uo pipefail

PROD="${AGENT_COMPANY_PROD:-$HOME/projects/agent-company}" # override only to try this script from another checkout
STATE="$HOME/.local/state/agent-company"
DSTATE="$STATE/deploy"
WWW=/var/www/hq-app
UNITS="$HOME/.config/systemd/user"
DICTATE_ENV="${DICTATE_ENV:-$HOME/projects/dictate-server/server/.env}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
cd "$PROD" || exit 2

drift=(); shorts=()
# d <detail> [short]: the detail is for the body; the short is the owner's words, with no sha and no path.
d() { drift+=("$1"); shorts+=("${2:-$1}"); }
T="$(cat "$STATE/api-token" 2>/dev/null)"

# ── the checkout ─────────────────────────────────────────────────────────────
git fetch -q origin main 2>/dev/null || true
main="$(git rev-parse origin/main)"
hq_sha="$(cat "$DSTATE/hq.sha" 2>/dev/null || true)"
app_sha="$(cat "$WWW/current/.deployed-sha" 2>/dev/null || true)"
caddy_sha="$(cat "$DSTATE/caddy.sha" 2>/dev/null || true)"
while IFS=$'\t' read -r short detail; do
  [[ -n "$short" ]] && d "$detail" "$short"
done < <(node scripts/drift-lib.mjs checkout "$PROD" "$hq_sha" "$app_sha" "$caddy_sha")

# ── hq ───────────────────────────────────────────────────────────────────────
systemctl --user is-active -q agent-company-hq || d "agent-company-hq לא פעיל" "hq לא פעיל"

# ── the app ──────────────────────────────────────────────────────────────────
[[ -e "$WWW/current" ]] || d "אין $WWW/current: האפליקציה לא נפרסה דרך scripts/deploy.sh" "האפליקציה לא נפרסה"

# ── Caddy ────────────────────────────────────────────────────────────────────
# What is live is compared with what was deployed (the checkout, after the check above), not with main.
if ! git show "HEAD:deploy/caddy/agent-company.caddy" 2>/dev/null | cmp -s - /etc/caddy/sites/agent-company.caddy; then
  d "/etc/caddy/sites/agent-company.caddy שונה מ-deploy/caddy/agent-company.caddy שנפרס" "קובץ ה-Caddy בשרת שונה ממה שנפרס"
fi
why="$(node scripts/caddy-main.mjs --check </etc/caddy/Caddyfile)" || d "ב-/etc/caddy/Caddyfile: $why" "ה-Caddyfile הראשי בשרת שונה ממה שנפרס"
# Our own hand-made backups only (same list as deploy.sh); other projects keep theirs.
shopt -s nullglob
our_baks=(/etc/caddy/Caddyfile.bak-{api-hq,hq-app,hq-app-token,app-root,assetlinks,remove-master-token,night-leftovers,pre-dictate,mockups,tab-hq,bet6,bet7}-* /etc/caddy/Caddyfile.bak-hq-2*)
shopt -u nullglob
baks=${#our_baks[@]}
((baks == 0)) || d "$baks גיבויי Caddyfile.bak* עם אתרי החברה ב-/etc/caddy (שאריות של עריכות ידניות)" "נשארו בשרת שאריות של עריכות ידניות ב-Caddy"

# The old secret path (docs/RUNBOOK.md, "המעבר לשורש") left Caddy on 01/11/2026, and deploy.sh caddy deletes its record.
if grep -q '/[0-9a-f]\{32\}/hq/\*' /etc/caddy/sites/agent-company.caddy 2>/dev/null; then
  d "הנתיב הסודי הישן עדיין ב-Caddy" "הנתיב הסודי הישן של האפליקציה עדיין פעיל"
fi

# ── units, hq.env, leftovers ─────────────────────────────────────────────────
for u in agent-company-hq.service agent-company-drift.service agent-company-drift.timer agent-company-disk-clean.service agent-company-disk-clean.timer; do
  [[ "$(readlink "$UNITS/$u")" == "$PROD/deploy/$u" ]] || d "היחידה $u לא מקושרת ל-$PROD/deploy/$u" "שירות של החברה בשרת לא מחובר למה שנפרס"
done
systemctl --user is-enabled -q agent-company-drift.timer || d "agent-company-drift.timer לא מופעל" "בדיקת הסטייה הלילית כבויה"
systemctl --user is-enabled -q agent-company-disk-clean.timer || d "agent-company-disk-clean.timer לא מופעל" "הניקוי היומי של הדיסק כבוי"
# The company (COMPANY_HOME, scripts/company-home.mjs): this checkout, or its own checkout after the split.
chome="$(node scripts/company-home.mjs "$STATE")"
if [[ "$chome" == "$(pwd -P)" ]]; then
  cgit=(git)
else
  cgit=(git -C "$chome")
  # Behind origin/main is not drift: a deploy brings the company up to date. Hand edits are.
  [[ -z "$("${cgit[@]}" status --porcelain 2>/dev/null)" ]] || d "החברה ב-$chome לא נקייה" "קבצי החברה בשרת שונו ביד"
fi
# This machine's own checks, next to its own deploy steps (company/local/deploy-hq.sh): one line per difference.
if [[ -f "$chome/company/local/drift-check.sh" ]]; then
  local_out="$(UNITS="$UNITS" bash "$chome/company/local/drift-check.sh")" || d "$chome/company/local/drift-check.sh נכשל (קוד $?)" "בדיקת הסטייה של המכונה נכשלה"
  while IFS= read -r l; do [[ -n "$l" ]] && d "$l" "הגדרות של המכונה בשרת שונות ממה שנפרס"; done <<<"$local_out"
fi
# The live config against the company as deployed (its checkout), not against a main that is waiting for a GO.
"${cgit[@]}" show "HEAD:company/hq.config.json" 2>/dev/null | cmp -s - "$STATE/hq.config.json" \
  || d "$STATE/hq.config.json שונה מ-company/hq.config.json בחברה שנפרסה ($chome) (או חסר: אז hq רץ עם ברירות מחדל גנריות)" "ההגדרות החיות של hq שונות ממה שאושר"
envf="$HOME/.config/agent-company/hq.env"
if [[ ! -f "$envf" ]]; then
  d "אין $envf (הטוקן של dictate-server בשביל hq)" "חסר ל-hq הטוקן של ההכתבה"
else
  [[ "$(stat -c %a "$envf")" == 600 ]] || d "$envf בהרשאות $(stat -c %a "$envf") ולא 600" "קובץ הטוקנים של hq פתוח לקריאה"
  [[ "$(sed -n 's/^DICTATE_TOKEN=//p' "$envf")" == "$(sed -n 's/^DICTATE_TOKEN=//p' "$DICTATE_ENV" | tail -1)" ]] \
    || d "DICTATE_TOKEN ב-hq.env לא תואם לזה של dictate-server" "הטוקן של ההכתבה ב-hq לא תואם"
fi
for x in "$WWW"/* "$WWW"/.well-known; do
  [[ -e "$x" ]] || continue
  n="$(basename "$x")"
  case "$n" in current | releases | qa) ;; *) d "שארית ב-$WWW: $n" "נשארו בשרת קבצים ישנים של האפליקציה" ;; esac
done
if [[ -e "$STATE/app-path" ]]; then d "שארית: $STATE/app-path (הנתיב הסודי הישן)" "נשארה בשרת שארית של הנתיב הסודי הישן"; fi

# ── merged and not deployed: a summary, never drift ──────────────────────────
pending=""
if [[ -n "$hq_sha" ]]; then
  waiting="$(curl -sf -m 10 -H "Authorization: Bearer $T" "http://127.0.0.1:7420/api/deploys/waiting?project=agent-company" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{console.log(JSON.parse(s).prs.join(" "))}catch{}})')"
  pending="$(node scripts/drift-lib.mjs pending "$PROD" "$hq_sha" "$main" $waiting)"
fi

# ── result ───────────────────────────────────────────────────────────────────
if ((${#drift[@]} == 0)); then
  echo "אין סטייה: הפרודקשן הוא מה שנפרס (${hq_sha:0:7})."
  [[ -z "$pending" ]] || echo "$pending"
  exit 0
fi
echo "נמצאו ${#drift[@]} סטיות ממה שנפרס:"
printf -- '- %s\n' "${drift[@]}"
[[ -z "$pending" ]] || { echo; echo "$pending"; }

if [[ "${1:-}" == --report ]]; then
  enabled="$(curl -s -H "Authorization: Bearer $T" http://127.0.0.1:7420/api/toggles \
    | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const t=JSON.parse(s).toggles.find(x=>x.key==="noga/drift-check");console.log(t?t.enabled:true)}catch{console.log(true)}})')"
  if [[ "$enabled" != true ]]; then echo "noga/drift-check כבוי בלוח: לא שולח לתיבה."; exit 1; fi
  body="$(printf -- '- %s\n' "${drift[@]}")
${pending:+
$pending
}
התיקון הוא תמיד מה-repo: scripts/deploy.sh all מ-$PROD (docs/RUNBOOK.md), לא עריכה בשרת."
  key="drift-$(date +%F)-$(printf '%s' "$body" | sha256sum | cut -c1-12)"
  title="$(printf '%s\n' "${shorts[@]}" | node scripts/drift-lib.mjs title)"
  node -e '
    const [title, body, key, token] = process.argv.slice(1);
    fetch("http://127.0.0.1:7420/api/inbox", { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ kind: "incident", from: "noga", title, body, urgency: "normal", blocking: false, msg_id: key }) })
      .then(async (r) => { if (!r.ok) { console.error(`inbox: ${r.status} ${await r.text()}`); process.exit(3); } console.log("נשלח לתיבה."); })
      .catch((e) => { console.error(`inbox: ${e.message}`); process.exit(3); });
  ' "$title" "$body" "$key" "$T" || exit 3
  exit 0 # reported: the timer's unit stays green, the inbox carries it
fi
exit 1
