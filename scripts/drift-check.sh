#!/usr/bin/env bash
# noga/drift-check (company/org.yaml): is production exactly what scripts/deploy.sh would make from
# origin/main? Read-only: it changes nothing on the server.
#
#   scripts/drift-check.sh            prints every difference; exit 1 when there is one
#   scripts/drift-check.sh --report   the same, and puts the differences in the owner's inbox (from
#                                     noga), unless the automation is switched off on the board.
#                                     Run nightly by deploy/agent-company-drift.timer.
#
# Checks: the production checkout (clean main == origin/main), hq and the app running what main has,
# the Caddy files (ours in /etc/caddy/sites, and only one import line of ours in the main Caddyfile),
# the user units, hq.env, hq.config.json, the old secret path past its removal date, and leftovers of hand edits.
set -uo pipefail

PROD="${AGENT_COMPANY_PROD:-$HOME/projects/agent-company}" # override only to try this script from another checkout
STATE="$HOME/.local/state/agent-company"
DSTATE="$STATE/deploy"
WWW=/var/www/hq-app
UNITS="$HOME/.config/systemd/user"
DICTATE_ENV="${DICTATE_ENV:-$HOME/projects/dictate-server/server/.env}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
cd "$PROD" || exit 2

drift=()
d() { drift+=("$1"); }

# ── the checkout ─────────────────────────────────────────────────────────────
git fetch -q origin main 2>/dev/null || d "git fetch נכשל, ולכן ההשוואה היא מול origin/main הישן"
head="$(git rev-parse HEAD)"
main="$(git rev-parse origin/main)"
[[ "$(git rev-parse --abbrev-ref HEAD)" == main ]] || d "ה-checkout בפרודקשן ($PROD) לא על main"
[[ -z "$(git status --porcelain)" ]] || d "ה-checkout בפרודקשן לא נקי: $(git status --porcelain | wc -l) קבצים"
[[ "$head" == "$main" ]] || d "ה-checkout בפרודקשן ב-${head:0:7}, ו-origin/main ב-${main:0:7}: יש מיזוג שלא נפרס"

# What changed between a deployed commit and origin/main, in the given paths.
changed_since() { ! git diff --quiet "$1" "$main" -- "${@:2}" 2>/dev/null; }

# ── hq ───────────────────────────────────────────────────────────────────────
hq_sha="$(cat "$DSTATE/hq.sha" 2>/dev/null || true)"
if [[ -z "$hq_sha" ]]; then
  d "אין רישום של פריסת hq ($DSTATE/hq.sha): hq לא נפרס דרך scripts/deploy.sh"
elif changed_since "$hq_sha" packages deploy package.json package-lock.json ':!packages/app'; then
  d "hq רץ על ${hq_sha:0:7}, וב-main יש שינויים בקוד שלו מאז"
fi
systemctl --user is-active -q agent-company-hq || d "agent-company-hq לא פעיל"

# ── the app ──────────────────────────────────────────────────────────────────
app_sha="$(cat "$WWW/current/.deployed-sha" 2>/dev/null)"
if [[ ! -e "$WWW/current" ]]; then
  d "אין $WWW/current: האפליקציה לא נפרסה דרך scripts/deploy.sh"
elif changed_since "$app_sha" packages/app deploy/caddy/assetlinks.json; then
  d "האפליקציה ב-${app_sha:0:7}, וב-main יש שינויים ב-packages/app מאז"
fi

# ── Caddy ────────────────────────────────────────────────────────────────────
if ! git show "$main:deploy/caddy/agent-company.caddy" 2>/dev/null | cmp -s - /etc/caddy/sites/agent-company.caddy; then
  d "/etc/caddy/sites/agent-company.caddy שונה מ-deploy/caddy/agent-company.caddy ב-main"
fi
why="$(node scripts/caddy-main.mjs --check </etc/caddy/Caddyfile)" || d "ב-/etc/caddy/Caddyfile: $why"
# Our own hand-made backups only (same list as deploy.sh); other projects keep theirs.
shopt -s nullglob
our_baks=(/etc/caddy/Caddyfile.bak-{api-hq,hq-app,hq-app-token,app-root,assetlinks,remove-master-token,night-leftovers,pre-dictate,mockups,tab-hq,bet6,bet7}-* /etc/caddy/Caddyfile.bak-hq-2*)
shopt -u nullglob
baks=${#our_baks[@]}
((baks == 0)) || d "$baks גיבויי Caddyfile.bak* עם אתרי החברה ב-/etc/caddy (שאריות של עריכות ידניות)"

# The old secret path: a 301 for one week, then gone (docs/RUNBOOK.md).
until_date="$(sed -n 's/.*הנתיב הסודי הישן.*עד \([0-9]\{2\}\)\/\([0-9]\{2\}\)\/\([0-9]\{4\}\).*/\3-\2-\1/p' docs/RUNBOOK.md | head -1)"
if [[ -n "$until_date" ]] && grep -q '/[0-9a-f]\{32\}/hq/\*' /etc/caddy/sites/agent-company.caddy 2>/dev/null \
  && [[ "$(date +%F)" > "$until_date" ]]; then
  d "הנתיב הסודי הישן עדיין ב-Caddy, ומועד ההסרה ($until_date) עבר"
fi

# ── units, hq.env, leftovers ─────────────────────────────────────────────────
for u in agent-company-hq.service agent-company-drift.service agent-company-drift.timer; do
  [[ "$(readlink "$UNITS/$u")" == "$PROD/deploy/$u" ]] || d "היחידה $u לא מקושרת ל-$PROD/deploy/$u"
done
systemctl --user is-enabled -q agent-company-drift.timer || d "agent-company-drift.timer לא מופעל"
# The company (COMPANY_HOME, scripts/company-home.mjs): this checkout, or its own checkout after the split.
chome="$(node scripts/company-home.mjs "$STATE")"
if [[ "$chome" == "$(pwd -P)" ]]; then
  cmain="$main"; cgit=(git)
else
  cgit=(git -C "$chome")
  "${cgit[@]}" fetch -q origin main 2>/dev/null || d "git fetch של החברה ב-$chome נכשל, ולכן ההשוואה היא מול origin/main הישן"
  cmain="$("${cgit[@]}" rev-parse origin/main 2>/dev/null)" || d "אין origin/main בחברה ב-$chome"
  [[ "$("${cgit[@]}" rev-parse HEAD 2>/dev/null)" == "$cmain" ]] || d "החברה ב-$chome לא ב-origin/main (פריסה מעדכנת אותה)"
  [[ -z "$("${cgit[@]}" status --porcelain 2>/dev/null)" ]] || d "החברה ב-$chome לא נקייה"
fi
# This machine's own checks, next to its own deploy steps (company/local/deploy-hq.sh): one line per difference.
if [[ -f "$chome/company/local/drift-check.sh" ]]; then
  local_out="$(UNITS="$UNITS" bash "$chome/company/local/drift-check.sh")" || d "$chome/company/local/drift-check.sh נכשל (קוד $?)"
  while IFS= read -r l; do [[ -n "$l" ]] && d "$l"; done <<<"$local_out"
fi
"${cgit[@]}" show "$cmain:company/hq.config.json" 2>/dev/null | cmp -s - "$STATE/hq.config.json" \
  || d "$STATE/hq.config.json שונה מ-company/hq.config.json ב-main של החברה ($chome) (או חסר: אז hq רץ עם ברירות מחדל גנריות)"
envf="$HOME/.config/agent-company/hq.env"
if [[ ! -f "$envf" ]]; then
  d "אין $envf (הטוקן של dictate-server בשביל hq)"
else
  [[ "$(stat -c %a "$envf")" == 600 ]] || d "$envf בהרשאות $(stat -c %a "$envf") ולא 600"
  [[ "$(sed -n 's/^DICTATE_TOKEN=//p' "$envf")" == "$(sed -n 's/^DICTATE_TOKEN=//p' "$DICTATE_ENV" | tail -1)" ]] \
    || d "DICTATE_TOKEN ב-hq.env לא תואם לזה של dictate-server"
fi
for x in "$WWW"/* "$WWW"/.well-known; do
  [[ -e "$x" ]] || continue
  n="$(basename "$x")"
  case "$n" in current | releases | qa) ;; *) d "שארית ב-$WWW: $n" ;; esac
done
if [[ -e "$STATE/app-path" && ( -z "$until_date" || "$(date +%F)" > "$until_date" ) ]]; then d "שארית: $STATE/app-path (הנתיב הסודי הישן, מועד ההסרה עבר)"; fi

# ── result ───────────────────────────────────────────────────────────────────
if ((${#drift[@]} == 0)); then
  echo "אין סטייה: הפרודקשן תואם ל-origin/main (${main:0:7})."
  exit 0
fi
echo "נמצאו ${#drift[@]} סטיות מ-origin/main (${main:0:7}):"
printf -- '- %s\n' "${drift[@]}"

if [[ "${1:-}" == --report ]]; then
  T="$(cat "$STATE/api-token")"
  enabled="$(curl -s -H "Authorization: Bearer $T" http://127.0.0.1:7420/api/toggles \
    | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const t=JSON.parse(s).toggles.find(x=>x.key==="noga/drift-check");console.log(t?t.enabled:true)}catch{console.log(true)}})')"
  if [[ "$enabled" != true ]]; then echo "noga/drift-check כבוי בלוח: לא שולח לתיבה."; exit 1; fi
  body="$(printf -- '- %s\n' "${drift[@]}")
התיקון הוא תמיד מה-repo: scripts/deploy.sh all מ-$PROD (docs/RUNBOOK.md), לא עריכה בשרת."
  key="drift-$(date +%F)-$(printf '%s' "$body" | sha256sum | cut -c1-12)"
  node -e '
    const [title, body, key, token] = process.argv.slice(1);
    fetch("http://127.0.0.1:7420/api/inbox", { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ kind: "incident", from: "noga", title, body, urgency: "normal", blocking: false, msg_id: key }) })
      .then(async (r) => { if (!r.ok) { console.error(`inbox: ${r.status} ${await r.text()}`); process.exit(3); } console.log("נשלח לתיבה."); })
      .catch((e) => { console.error(`inbox: ${e.message}`); process.exit(3); });
  ' "סטייה בפרודקשן: ${#drift[@]} דברים לא תואמים ל-main" "$body" "$key" "$T" || exit 3
  exit 0 # reported: the timer's unit stays green, the inbox carries it
fi
exit 1
