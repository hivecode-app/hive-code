#!/usr/bin/env bash
# The one way to put agent-company into production on hq-host (#54). Nothing is edited by hand on
# the server: everything below comes from this repo at origin/main.
#
#   scripts/deploy.sh hq      hq + its user units (and hq.env), safe restart: live shifts survive
#   scripts/deploy.sh app     the app: web at https://app.hq.example.com/ and the APK
#   scripts/deploy.sh caddy   deploy/caddy/agent-company.caddy -> /etc/caddy/sites/, validate, reload
#   scripts/deploy.sh all     hq, app, caddy, in that order
#
# Every run: refuses unless it runs from ~/projects/agent-company on a clean main that is (or
# fast-forwards to) origin/main; runs the checks (contract, typecheck, tests; flutter analyze and
# tests for the app); builds; installs; then verifies production end to end (scripts/verify-prod.mjs).
# Anything that fails rolls back what this run changed, and the exit code is non-zero. The last
# line is a Hebrew summary (also in ~/.local/state/agent-company/deploy/last-summary.txt).
set -Eeuo pipefail

target="${1:-}"
case "$target" in hq | app | caddy | all) ;; *) echo "usage: scripts/deploy.sh hq|app|caddy|all" >&2; exit 2 ;; esac

PROD="$HOME/projects/agent-company"
repo="$(cd "$(dirname "$0")/.." && pwd -P)"
STATE="$HOME/.local/state/agent-company"
DSTATE="$STATE/deploy"
WWW=/var/www/hq-app
APP_URL=https://app.hq.example.com
FLUTTER="${FLUTTER:-$HOME/flutter/bin/flutter}"
APKSIGNER="${APKSIGNER:-/opt/android-sdk/build-tools/36.0.0/apksigner}"
AAPT2="${AAPT2:-/opt/android-sdk/build-tools/36.0.0/aapt2}"
DICTATE_ENV="${DICTATE_ENV:-$HOME/projects/dictate-server/server/.env}"
UNITS="$HOME/.config/systemd/user"
# Hand-made backups of our Caddy blocks from before this script (20/10/2026). Same list in drift-check.sh.
shopt -s nullglob
CADDY_BAKS=(/etc/caddy/Caddyfile.bak-{api-hq,hq-app,hq-app-token,app-root,assetlinks,remove-master-token,night-leftovers,pre-dictate,mockups,tab-hq,bet6,bet7}-* /etc/caddy/Caddyfile.bak-hq-2*)
shopt -u nullglob
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

mkdir -p "$DSTATE"
chmod 700 "$DSTATE"
exec 9>"$DSTATE/lock"
flock -n 9 || { echo "פריסה אחרת כבר רצה (נעילה ב-$DSTATE/lock)." >&2; exit 1; }

summary=()
say() { summary+=("$1"); echo "• $1"; }
step() { echo; echo "── $1"; }

# What this run changed, for the rollback.
prev_sha=""; sha=""; moved_checkout=0; lock_changed=1; hq_restarted=0; app_swapped=0; prev_release=""; caddy_changed=0

finish() {
  local rc=$1
  {
    echo
    if ((rc == 0)); then echo "פריסה ($target) של ${sha:0:7} הצליחה."; else echo "פריסה ($target) נכשלה (קוד $rc)."; fi
    for s in "${summary[@]}"; do echo "- $s"; done
  } | tee "$DSTATE/last-summary.txt"
}

rollback() {
  echo
  echo "── חוזר אחורה"
  if ((caddy_changed)); then
    sudo -n install -m644 "$DSTATE/caddy-prev/Caddyfile" /etc/caddy/Caddyfile
    if [[ -f "$DSTATE/caddy-prev/agent-company.caddy" ]]; then
      sudo -n install -m644 "$DSTATE/caddy-prev/agent-company.caddy" /etc/caddy/sites/agent-company.caddy
    else
      sudo -n rm -f /etc/caddy/sites/agent-company.caddy
    fi
    if sudo -n systemctl reload caddy; then say "Caddy חזר להגדרה הקודמת"; else say "Caddy: גם החזרה נכשלה, צריך לבדוק ידנית (journalctl -u caddy)"; fi
  fi
  if ((app_swapped)); then
    if [[ -n "$prev_release" ]]; then
      sudo -n ln -sfn "$prev_release" "$WWW/.current.new" && sudo -n mv -T "$WWW/.current.new" "$WWW/current"
      say "האפליקציה חזרה ל-$(basename "$prev_release")"
    else
      sudo -n rm -f "$WWW/current"
      say "האפליקציה: אין release קודם, current הוסר"
    fi
  fi
  if ((moved_checkout)); then
    git reset -q --keep "$prev_sha"
    if ! git diff --quiet "$prev_sha" "$sha" -- package-lock.json; then npm ci --no-audit --no-fund >/dev/null; rm -f "$DSTATE/npm-lock.sha256"; fi
    say "ה-checkout חזר ל-${prev_sha:0:7}"
  fi
  if ((hq_restarted)); then
    systemctl --user restart agent-company-hq
    if wait_health; then say "hq הופעל מחדש על ${prev_sha:0:7}"; else say "hq לא חזר אחרי החזרה. journalctl --user -u agent-company-hq"; fi
  fi
}

fail() {
  # The ERR trap also fires inside $(...) subshells (set -E): only the main shell rolls back.
  [[ $BASHPID == "$$" ]] || exit 1
  trap - ERR
  set +e
  say "נכשל: $1"
  rollback
  finish 1
  exit 1
}
trap 'fail "פקודה נכשלה בשורה $LINENO: $BASH_COMMAND"' ERR

wait_health() {
  for _ in $(seq 1 60); do
    [[ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7420/health)" == 200 ]] && return 0
    sleep 1
  done
  return 1
}
active_shifts() { systemctl --user list-units 'company-shift@*' --state=active --plain --no-legend | awk '{print $1}' | sort; }

# ── preflight: only the production checkout, clean main, at origin/main ──────
step "בדיקה מקדימה"
[[ "$repo" == "$(cd "$PROD" && pwd -P)" ]] || { echo "רק מ-$PROD (משם hq רץ). כאן: $repo" >&2; exit 1; }
cd "$repo"
[[ "$(git rev-parse --abbrev-ref HEAD)" == main ]] || { echo "ה-checkout לא על main." >&2; exit 1; }
[[ -z "$(git status --porcelain)" ]] || { echo "ה-checkout לא נקי:" >&2; git status --short >&2; exit 1; }
git fetch -q origin main
prev_sha="$(git rev-parse HEAD)"
if [[ "$prev_sha" != "$(git rev-parse origin/main)" ]]; then
  git merge-base --is-ancestor HEAD origin/main || { echo "main המקומי התפצל מ-origin/main." >&2; exit 1; }
  git merge -q --ff-only origin/main
  moved_checkout=1
fi
sha="$(git rev-parse HEAD)"
# npm ci only when package-lock.json differs from the one the last `npm ci` here installed.
lock_hash="$(sha256sum package-lock.json | cut -c1-64)"
if [[ -d node_modules && "$(cat "$DSTATE/npm-lock.sha256" 2>/dev/null)" == "$lock_hash" ]]; then lock_changed=0; fi
# Before the first recorded `npm ci`: trust node_modules if this run did not change the lock file.
if [[ -d node_modules && ! -f "$DSTATE/npm-lock.sha256" ]] && git diff --quiet "$prev_sha" "$sha" -- package-lock.json; then
  lock_changed=0
  echo "$lock_hash" >"$DSTATE/npm-lock.sha256"
fi
if ((moved_checkout)); then say "ה-checkout עודכן מ-${prev_sha:0:7} ל-${sha:0:7} ($(git log -1 --format=%s | cut -c1-60))"; else say "ה-checkout כבר ב-origin/main (${sha:0:7})"; fi

# ── checks ───────────────────────────────────────────────────────────────────
# Before the first `all`, Caddy still has the hand-written blocks (open /dictate, old paths) and the
# end-to-end check fails for any single target. So the first run has to be `all`.
if [[ "$target" != all ]] && ! node scripts/caddy-main.mjs --check </etc/caddy/Caddyfile >/dev/null; then
  fail "ה-Caddyfile הראשי עוד לא הומר (אין import sites/*.caddy). הפריסה הראשונה חייבת להיות: scripts/deploy.sh all"
fi

step "בדיקות"
# npm ci replaces node_modules under the running hq and shifts: only when the lock file changed.
if ((lock_changed)); then npm ci --no-audit --no-fund >/dev/null; echo "$lock_hash" >"$DSTATE/npm-lock.sha256"; say "npm ci (package-lock.json השתנה)"; fi
npm run -s check:contract >/dev/null || fail "check:contract"
npm run -s test:contract >/dev/null 2>&1 || fail "test:contract"
npm run -s test:deploy >/dev/null 2>&1 || fail "test:deploy"
npm run -s typecheck || fail "typecheck"
npm test >"$DSTATE/last-test.log" 2>&1 || fail "npm test (הלוג: $DSTATE/last-test.log)"
say "contract, typecheck ו-npm test עברו ($(grep -m1 -o 'pass [0-9]*' "$DSTATE/last-test.log" | tail -1 || true))"
if [[ "$target" == app || "$target" == all ]]; then
  (cd packages/app && "$FLUTTER" pub get >/dev/null && "$FLUTTER" analyze >/dev/null) || fail "flutter analyze"
  (cd packages/app && "$FLUTTER" test >"$DSTATE/last-flutter-test.log" 2>&1) || fail "flutter test (הלוג: $DSTATE/last-flutter-test.log)"
  say "flutter analyze ו-flutter test עברו"
fi

# ── hq ───────────────────────────────────────────────────────────────────────
deploy_hq() {
  step "hq"
  # hq.env: server-side secrets, never in git. Today only dictate-server's token, from dictate-server's own .env.
  install -d -m700 "$HOME/.config/agent-company"
  local tok env
  tok="$(sed -n 's/^DICTATE_TOKEN=//p' "$DICTATE_ENV" | tail -1)"
  [[ -n "$tok" ]] || fail "אין DICTATE_TOKEN ב-$DICTATE_ENV"
  env="$(mktemp "$HOME/.config/agent-company/.hq.env.XXXXXX")"
  printf '# Written by scripts/deploy.sh hq. Do not edit; the source is %s.\nDICTATE_TOKEN=%s\n' "$DICTATE_ENV" "$tok" >"$env"
  chmod 600 "$env"
  if cmp -s "$env" "$HOME/.config/agent-company/hq.env"; then rm -f "$env"; else mv -f "$env" "$HOME/.config/agent-company/hq.env"; say "hq.env נכתב (600)"; fi

  # User units: symlinks to this checkout, so there is one copy and nothing to drift.
  mkdir -p "$UNITS"
  for u in agent-company-hq.service actions-runner-company.service agent-company-drift.service agent-company-drift.timer; do
    [[ "$(readlink "$UNITS/$u" || true)" == "$repo/deploy/$u" ]] || { ln -sfn "$repo/deploy/$u" "$UNITS/$u"; say "יחידה $u מקושרת ל-repo"; }
  done
  # vscode-workspace runs an installed copy on purpose: a branch switch in a checkout must not break it.
  install -Dm644 scripts/vscode-workspace.mjs "$HOME/.local/lib/agent-company/vscode-workspace.mjs"
  install -Dm644 deploy/vscode-workspace.service "$UNITS/vscode-workspace.service"
  install -Dm644 deploy/vscode-workspace.timer "$UNITS/vscode-workspace.timer"
  mkdir -p "$HOME/live"
  systemctl --user daemon-reload
  systemctl --user enable -q agent-company-hq actions-runner-company
  systemctl --user enable -q --now agent-company-drift.timer vscode-workspace.timer

  # Safe restart: shifts are their own units (company-shift@), outside hq's cgroup.
  local before after gone live_before live_after
  before="$(active_shifts)"
  live_before="$({ curl -s http://127.0.0.1:7420/health || true; } | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).live_shifts)}catch{console.log("?")}})')"
  systemctl --user restart agent-company-hq
  hq_restarted=1
  wait_health || fail "hq לא עונה ב-/health דקה אחרי restart"
  after="$(active_shifts)"
  gone="$(comm -23 <(echo "$before") <(echo "$after") | grep . || true)"
  [[ -z "$gone" ]] || fail "משמרות נפלו ב-restart: $(echo "$gone" | tr '\n' ' ')"
  live_after="$({ curl -s http://127.0.0.1:7420/health || true; } | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).live_shifts)}catch{console.log("?")}})')"
  say "hq הופעל מחדש על ${sha:0:7}; $(echo "$after" | grep -c . || true) יחידות משמרת נשארו פעילות (live לפני/אחרי: $live_before/$live_after)"
}

# ── app ──────────────────────────────────────────────────────────────────────
deploy_app() {
  step "app"
  # A new dir per build (sha + time): a rerun at the same commit never touches the live release.
  local rel="$WWW/releases/$sha-$(date +%Y%m%d%H%M%S)" apk size hex got want build code name
  # One APK per ABI keeps the download small; the owner's phone (OnePlus 13) is arm64.
  # The build number is the commit count of main, so every deploy has a higher versionCode than the
  # one before (Android adds 1000 x ABI on top); the in-app update compares exactly that number.
  [[ "$(git rev-parse --is-shallow-repository)" == false ]] || fail "ה-checkout רדוד, ולכן מספר ה-build לא אמין"
  build="$(git rev-list --count HEAD)"
  (cd packages/app \
    && "$FLUTTER" build web --release --base-href / --no-web-resources-cdn >/dev/null \
    && "$FLUTTER" build apk --release --split-per-abi --build-number="$build" --dart-define=HQ_URL="$APP_URL/hq" >/dev/null) || fail "flutter build"
  apk=packages/app/build/app/outputs/flutter-apk/app-arm64-v8a-release.apk
  size="$(stat -c %s "$apk")"
  ((size > 5 * 1024 * 1024)) || fail "ה-APK קטן מדי ($size bytes)"
  hex="$("$APKSIGNER" verify --print-certs "$apk" | sed -n 's/.*certificate SHA-256 digest: \([0-9a-f]\{64\}\).*/\1/p' | head -1)"
  got="$(echo -n "$hex" | xxd -r -p | base64 -w0 | tr '+/' '-_' | tr -d '=')"
  want="$(grep -o 'android:apk-key-hash:[A-Za-z0-9_-]\+' packages/hq/src/config.ts | head -1 | cut -d: -f3)"
  [[ -n "$got" && "$got" == "$want" ]] || fail "ה-APK לא חתום במפתח השחרור ($got, ציפיתי ל-$want)"
  # The versionCode Android will see, read from the APK itself (not from what we asked Flutter for).
  code="$("$AAPT2" dump badging "$apk" | sed -n "s/^package: .* versionCode='\([0-9]*\)'.*/\1/p")"
  name="$("$AAPT2" dump badging "$apk" | sed -n "s/^package: .* versionName='\([^']*\)'.*/\1/p")"
  [[ "$code" =~ ^[0-9]+$ ]] || fail "לא הצלחתי לקרוא את ה-versionCode של ה-APK"
  # A lower or equal versionCode would never be offered (and Android would not install it over the live one).
  local live
  live="$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version_code||0)}catch{console.log(0)}' "$WWW/current/app-release.json")"
  ((code > live)) || fail "ה-versionCode החדש ($code) לא גבוה מזה שבאוויר ($live)"

  sudo -n install -d -o "$(id -un)" -m755 "$WWW/releases"
  mkdir -p "$rel.tmp/.well-known"
  rsync -a packages/app/build/web/ "$rel.tmp/"
  cp "$apk" "$rel.tmp/agent-company.apk"
  # What hq offers the app as "the newest version" (packages/hq/src/app-release.ts).
  node -e 'const [code, name, sha, sha256, bytes] = process.argv.slice(1);
    console.log(JSON.stringify({ version_code: +code, version_name: name, sha, apk: "agent-company.apk", sha256, bytes: +bytes }))' \
    "$code" "$name" "$sha" "$(sha256sum "$apk" | cut -c1-64)" "$size" >"$rel.tmp/app-release.json"
  cp deploy/caddy/assetlinks.json "$rel.tmp/.well-known/assetlinks.json"
  echo "$sha" >"$rel.tmp/.deployed-sha"
  chmod -R a+rX "$rel.tmp"
  mv "$rel.tmp" "$rel"
  rm -rf packages/app/build/web packages/app/build/app/intermediates packages/app/build/app/tmp

  # Only a real earlier release counts (first deploy: none, so the rollback removes current).
  prev_release="$(readlink -e "$WWW/current" 2>/dev/null || true)"
  if [[ "$prev_release" != "$WWW"/releases/* ]]; then prev_release=""; fi
  sudo -n ln -sfn "$rel" "$WWW/.current.new"
  sudo -n mv -T "$WWW/.current.new" "$WWW/current"
  app_swapped=1
  # Keep the live release, the one before it, and the newest three.
  local keep
  keep="$(printf '%s\n%s\n' "$rel" "$prev_release"; ls -1dt "$WWW"/releases/*/ 2>/dev/null | head -3 | sed 's:/$::')"
  for d in "$WWW"/releases/*/; do
    d="${d%/}"
    grep -qxF "$d" <<<"$keep" || rm -rf "$d"
  done
  say "האפליקציה ($APP_URL/) וה-APK ($((size / 1048576)) MB, חתימה תקינה, versionCode $code) מ-${sha:0:7}"
}

# ── caddy ────────────────────────────────────────────────────────────────────
deploy_caddy() {
  step "caddy"
  [[ -e "$WWW/current" ]] || fail "אין $WWW/current: קודם scripts/deploy.sh app"
  local stage
  stage="$(mktemp -d)"
  mkdir -p "$stage/sites"
  node scripts/caddy-main.mjs </etc/caddy/Caddyfile >"$stage/Caddyfile"
  # Sites of other projects in /etc/caddy/sites stay as they are; validate sees all of them.
  for f in /etc/caddy/sites/*.caddy; do
    if [[ -e "$f" && "$(basename "$f")" != agent-company.caddy ]]; then cp "$f" "$stage/sites/"; fi
  done
  cp deploy/caddy/agent-company.caddy "$stage/sites/agent-company.caddy"
  sudo -n caddy validate --adapter caddyfile --config "$stage/Caddyfile" >"$DSTATE/caddy-validate.log" 2>&1 \
    || fail "caddy validate נכשל (הלוג: $DSTATE/caddy-validate.log)"
  if cmp -s "$stage/Caddyfile" /etc/caddy/Caddyfile && cmp -s "$stage/sites/agent-company.caddy" /etc/caddy/sites/agent-company.caddy; then
    say "Caddy ללא שינוי"
    rm -rf "$stage"
    return
  fi
  # One previous copy for the rollback, in our state dir (not another Caddyfile.bak-* in /etc/caddy).
  rm -rf "$DSTATE/caddy-prev"
  mkdir -p "$DSTATE/caddy-prev"
  cp /etc/caddy/Caddyfile "$DSTATE/caddy-prev/Caddyfile"
  if [[ -f /etc/caddy/sites/agent-company.caddy ]]; then cp /etc/caddy/sites/agent-company.caddy "$DSTATE/caddy-prev/"; fi
  chmod -R go-rwx "$DSTATE/caddy-prev"
  caddy_changed=1
  sudo -n install -d -m755 /etc/caddy/sites
  sudo -n install -m644 "$stage/sites/agent-company.caddy" /etc/caddy/sites/agent-company.caddy
  sudo -n install -m644 "$stage/Caddyfile" /etc/caddy/Caddyfile
  rm -rf "$stage"
  sudo -n systemctl reload caddy || fail "systemctl reload caddy נכשל"
  sleep 2
  [[ "$(curl -s -o /dev/null -w '%{http_code}' https://api.hq.example.com/health)" == 200 ]] || fail "api.hq לא עונה אחרי reload"
  say "Caddy: /etc/caddy/sites/agent-company.caddy מ-${sha:0:7}, validate עבר, reload"
}

case "$target" in
  hq) deploy_hq ;;
  app) deploy_app ;;
  caddy) deploy_caddy ;;
  all) deploy_hq; deploy_app; deploy_caddy ;;
esac

# ── end to end ───────────────────────────────────────────────────────────────
step "אימות מקצה לקצה"
if node scripts/verify-prod.mjs | tee "$DSTATE/last-verify.txt"; then
  say "אימות מקצה לקצה: $(tail -1 "$DSTATE/last-verify.txt")"
else
  { grep '^✗' "$DSTATE/last-verify.txt" || true; } | while read -r l; do echo "  $l"; done
  fail "אימות מקצה לקצה: $(grep -c '^✗' "$DSTATE/last-verify.txt" || true) בדיקות נכשלו ($DSTATE/last-verify.txt)"
fi
trap - ERR
# What runs now, for drift-check: written only after the end-to-end check passed.
if [[ "$target" == hq || "$target" == all ]]; then echo "$sha" >"$DSTATE/hq.sha"; fi
if [[ "$target" == caddy || "$target" == all ]]; then echo "$sha" >"$DSTATE/caddy.sha"; fi
# "מה לבדוק" (#108): hq hears which merged PRs are now live. Production is already verified: a failure here is said, not fatal.
if out="$(node scripts/deploy-report.mjs "$target" "$sha" 2>&1)"; then say "$out"; else say "$out (הפריסה עצמה הצליחה. לשלוח שוב: node scripts/deploy-report.mjs $target $sha)"; fi

# ── leftovers, only once production is verified ──────────────────────────────
# /var/www/hq-app holds exactly current, releases/ and qa/; hand-made Caddyfile backups of our sites
# are superseded by deploy/caddy-prev. Only our own backup names (CADDY_BAKS): other projects' backups
# in /etc/caddy (OpenClaw, dictate...) are not ours to touch.
if [[ "$target" == caddy || "$target" == all ]]; then
  for x in "$WWW"/* "$WWW"/.well-known; do
    [[ -e "$x" ]] || continue
    case "$(basename "$x")" in current | releases | qa) ;; *) sudo -n rm -rf -- "$x" && say "נמחקה שארית: $x" ;; esac
  done
  for f in "${CADDY_BAKS[@]}"; do
    sudo -n rm -f -- "$f" && say "נמחק גיבוי ידני: $f"
  done
fi
finish 0
