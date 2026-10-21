#!/usr/bin/env bash
# The one way to put agent-company into production on hq-host (#54). Nothing is edited by hand on
# the server: everything below comes from this repo at origin/main (or a merged commit before it, --sha).
#
#   scripts/deploy.sh hq      hq + its user units, hq.env and hq.config.json, safe restart: live shifts survive
#   scripts/deploy.sh app     the app: web at the appUrl of the company's hq.config.json (COMPANY_HOME), and the APK
#   scripts/deploy.sh caddy   deploy/caddy/agent-company.caddy -> /etc/caddy/sites/, validate, reload
#   scripts/deploy.sh all     hq, app, caddy, in that order
#   scripts/deploy.sh <target> --sha <sha>   (or DEPLOY_SHA=<sha>) up to that merged commit only, not all of
#                             origin/main: the PRs with a GO, without a later one still waiting (scripts/lib/deploy-sha.sh)
#
# Every run: refuses unless it runs from ~/projects/agent-company on a clean main that is (or
# fast-forwards to) origin/main, or the requested sha; runs the checks (contract, typecheck, tests; flutter analyze and
# tests for the app); builds; installs; then verifies production end to end (scripts/verify-prod.mjs).
# Anything that fails rolls back what this run changed, and the exit code is non-zero. The last
# line is a Hebrew summary (also in ~/.local/state/agent-company/deploy/last-summary.txt).
set -Eeuo pipefail

usage() { echo "usage: scripts/deploy.sh hq|app|caddy|all [--sha <sha>]" >&2; exit 2; }
target="${1:-}"
case "$target" in hq | app | caddy | all) ;; *) usage ;; esac
want_sha="${DEPLOY_SHA:-}"
shift
while (($#)); do
  case "$1" in
    --sha) [[ -n "${2:-}" ]] || usage; want_sha="$2"; shift 2 ;;
    --sha=?*) want_sha="${1#--sha=}"; shift ;;
    *) usage ;;
  esac
done

PROD="$HOME/projects/agent-company"
repo="$(cd "$(dirname "$0")/.." && pwd -P)"
STATE="$HOME/.local/state/agent-company"
DSTATE="$STATE/deploy"
WWW=/var/www/hq-app
# The company (company/, memory/) is at COMPANY_HOME (scripts/company-home.mjs): env, else hq.config.json's companyHome,
# else this checkout. Its own values (domains, names, accounts): <COMPANY_HOME>/company/hq.config.json, read after the preflight.
CHOME=""
HQ_CONFIG_SRC=""
APP_URL=""
API_URL=""
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
prev_sha=""; sha=""; range_log=""; moved_checkout=0; company_prev=""; moved_company=0; lock_changed=1; hq_restarted=0; app_swapped=0; prev_release=""; caddy_changed=0; config_changed=0

finish() {
  local rc=$1
  {
    echo
    if ((rc == 0)); then echo "פריסה ($target) של ${sha:0:7} הצליחה."; else echo "פריסה ($target) נכשלה (קוד $rc)."; fi
    for s in "${summary[@]}"; do echo "- $s"; done
    # What this run brought, to check against the GOs (git log prev..sha).
    if [[ -n "$range_log" ]]; then echo "הטווח שנפרס (${prev_sha:0:7}..${sha:0:7}):"; sed 's/^/  /' <<<"$range_log"; fi
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
  if ((config_changed)); then
    if [[ -f "$DSTATE/hq.config.prev.json" ]]; then
      install -m600 "$DSTATE/hq.config.prev.json" "$STATE/hq.config.json"
      say "hq.config.json חזר לקודם"
    else
      rm -f "$STATE/hq.config.json"
      say "hq.config.json הוסר (לא היה לפני הפריסה)"
    fi
  fi
  if ((moved_company)); then
    git -C "$CHOME" reset -q --keep "$company_prev"
    say "החברה ב-$CHOME חזרה ל-${company_prev:0:7}"
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

# wait_health, active_shifts, hq_safe_restart: the same safe restart `company update` uses.
# shellcheck source=lib/hq-restart.sh
source "$repo/scripts/lib/hq-restart.sh"
# shellcheck source=lib/deploy-sha.sh
source "$repo/scripts/lib/deploy-sha.sh"

# ── preflight: only the production checkout, clean main, at origin/main (or the sha asked for) ──
step "בדיקה מקדימה"
[[ "$repo" == "$(cd "$PROD" && pwd -P)" ]] || { echo "רק מ-$PROD (משם hq רץ). כאן: $repo" >&2; exit 1; }
cd "$repo"
[[ "$(git rev-parse --abbrev-ref HEAD)" == main ]] || { echo "ה-checkout לא על main." >&2; exit 1; }
[[ -z "$(git status --porcelain)" ]] || { echo "ה-checkout לא נקי:" >&2; git status --short >&2; exit 1; }
git fetch -q origin main
deploy_sha_move "$want_sha" || { echo "$DEPLOY_SHA_ERR." >&2; exit 1; }
prev_sha="$DEPLOY_PREV"; sha="$DEPLOY_SHA_TO"; moved_checkout="$DEPLOY_MOVED"
range_log="$(git log --oneline "$prev_sha..$sha")"
if [[ -n "$range_log" ]]; then echo "הטווח שנפרס (${prev_sha:0:7}..${sha:0:7}):"; sed 's/^/  /' <<<"$range_log"; fi
if [[ -n "$want_sha" ]]; then
  rest="$(git rev-list --count "$sha..origin/main")"
  say "פריסה עד ${sha:0:7} (--sha); $rest commits ב-origin/main אחריו לא נפרסים בריצה הזו"
fi
# npm ci only when package-lock.json differs from the one the last `npm ci` here installed.
lock_hash="$(sha256sum package-lock.json | cut -c1-64)"
if [[ -d node_modules && "$(cat "$DSTATE/npm-lock.sha256" 2>/dev/null)" == "$lock_hash" ]]; then lock_changed=0; fi
# Before the first recorded `npm ci`: trust node_modules if this run did not change the lock file.
if [[ -d node_modules && ! -f "$DSTATE/npm-lock.sha256" ]] && git diff --quiet "$prev_sha" "$sha" -- package-lock.json; then
  lock_changed=0
  echo "$lock_hash" >"$DSTATE/npm-lock.sha256"
fi
# The company: COMPANY_HOME. When it is a checkout of its own (after the split, docs/generic/split-runbook.md), it
# moves to its origin/main here too, like this one: a contract change takes effect with the deploy, as before.
CHOME="$(node scripts/company-home.mjs "$STATE")"
HQ_CONFIG_SRC="$CHOME/company/hq.config.json"
if [[ "$CHOME" != "$repo" ]]; then
  git -C "$CHOME" rev-parse --git-dir >/dev/null 2>&1 || fail "COMPANY_HOME ($CHOME) הוא לא checkout של git"
  [[ "$(git -C "$CHOME" rev-parse --abbrev-ref HEAD)" == main ]] || fail "החברה ב-$CHOME לא על main"
  [[ -z "$(git -C "$CHOME" status --porcelain)" ]] || fail "החברה ב-$CHOME לא נקייה: $(git -C "$CHOME" status --short | head -3 | tr '\n' ' ')"
  git -C "$CHOME" fetch -q origin main
  company_prev="$(git -C "$CHOME" rev-parse HEAD)"
  if [[ "$company_prev" != "$(git -C "$CHOME" rev-parse origin/main)" ]]; then
    git -C "$CHOME" merge-base --is-ancestor HEAD origin/main || fail "main של החברה ב-$CHOME התפצל מ-origin/main"
    git -C "$CHOME" merge -q --ff-only origin/main
    moved_company=1
  fi
  say "החברה מ-$CHOME ($(git -C "$CHOME" rev-parse --short HEAD))"
fi
# The URLs come from the company's hq.config.json (the one this run installs).
cfg_get() { node -e 'const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const v = process.argv[2].split(".").reduce((o, k) => o?.[k], c); if (typeof v === "string" && v) console.log(v.replace(/\/+$/, ""))' "$HQ_CONFIG_SRC" "$1"; }
[[ -f "$HQ_CONFIG_SRC" ]] || fail "אין $HQ_CONFIG_SRC: בלי הערכים של החברה hq רץ עם ברירות מחדל גנריות"
APP_URL="$(cfg_get auth.appUrl)" || fail "$HQ_CONFIG_SRC לא JSON תקין"
API_URL="$(cfg_get apiUrl)"
[[ -n "$APP_URL" && -n "$API_URL" ]] || fail "חסרים auth.appUrl או apiUrl ב-$HQ_CONFIG_SRC"
# Memory registries (packages/hq/src/memory-registry.ts) land on main by themselves, also while a GO waits: they are
# pulled with the rest, but they are memory, not what this deploy brings, so the summary leaves them out.
code_subject="$(git log -n1 --format=%s --invert-grep -E --grep='^Company-Memory-Registry: ' "$prev_sha..$sha")"
if [[ -n "$code_subject" ]]; then say "ה-checkout עודכן מ-${prev_sha:0:7} ל-${sha:0:7} ($(cut -c1-60 <<<"$code_subject"))"; else say "ה-checkout כבר ב-${sha:0:7}, אין בו קוד חדש"; fi

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

  # hq.config.json: this company's values (names, domains, accounts, Telegram), from git. Without it
  # hq starts with the generic defaults, so it is in place before the restart.
  if cmp -s "$HQ_CONFIG_SRC" "$STATE/hq.config.json"; then
    say "hq.config.json תואם ל-$HQ_CONFIG_SRC"
  else
    rm -f "$DSTATE/hq.config.prev.json"
    if [[ -f "$STATE/hq.config.json" ]]; then install -m600 "$STATE/hq.config.json" "$DSTATE/hq.config.prev.json"; fi
    config_changed=1
    install -m600 "$HQ_CONFIG_SRC" "$STATE/.hq.config.json.new"
    mv -f "$STATE/.hq.config.json.new" "$STATE/hq.config.json"
    say "hq.config.json נכתב מ-$HQ_CONFIG_SRC (600)"
  fi

  # User units: symlinks to this checkout, so there is one copy and nothing to drift.
  mkdir -p "$UNITS"
  for u in agent-company-hq.service agent-company-drift.service agent-company-drift.timer; do
    [[ "$(readlink "$UNITS/$u" || true)" == "$repo/deploy/$u" ]] || { ln -sfn "$repo/deploy/$u" "$UNITS/$u"; say "יחידה $u מקושרת ל-repo"; }
  done
  # company-ci moved to ci-host (deploy/ci-host/): the old runner unit here goes, link and all.
  if [[ -L "$UNITS/actions-runner-company.service" ]]; then
    systemctl --user disable -q --now actions-runner-company 2>/dev/null || true
    rm -f "$UNITS/actions-runner-company.service"
    say "היחידה actions-runner-company הוסרה (company-ci רץ ב-ci-host)"
  fi
  systemctl --user daemon-reload
  systemctl --user enable -q agent-company-hq
  systemctl --user enable -q --now agent-company-drift.timer
  # This machine's own steps (not the engine's): <COMPANY_HOME>/company/local/deploy-hq.sh, when the company has one.
  local hook="$CHOME/company/local/deploy-hq.sh" out
  if [[ -f "$hook" ]]; then
    out="$(UNITS="$UNITS" bash "$hook")" || fail "$hook נכשל"
    say "השלבים המקומיים של החברה ($hook): $(tail -1 <<<"$out")"
  fi

  # Nodes (hq.config.json `nodes`, packages/hq/src/nodes.ts): the engine there to this commit, so the shifts there run
  # the same code. A node that fails is said here, not a failed deploy (one that does not answer gets no task from hq).
  local n nout
  for n in $(node -e 'for (const x of JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).nodes || []) console.log(x.name)' "$STATE/hq.config.json"); do
    if nout="$(timeout 600 bash "$repo/scripts/node-install.sh" "$n" --update 2>&1)"; then say "$(tail -1 <<<"$nout")"
    else say "השרת $n לא עודכן (המשמרות שם רצות על הגרסה הקודמת; כיבוי: המתג node:$n): $(tail -1 <<<"$nout")"; fi
  done

  # Safe restart: shifts are their own units (company-shift@), outside hq's cgroup (scripts/lib/hq-restart.sh).
  hq_restarted=1
  hq_safe_restart || fail "$HQ_RESTART_MSG"
  say "hq הופעל מחדש על ${sha:0:7}; $HQ_RESTART_MSG"
}

# ── app ──────────────────────────────────────────────────────────────────────
deploy_app() {
  step "app"
  # A new dir per build (sha + time): a rerun at the same commit never touches the live release.
  local rel="$WWW/releases/$sha-$(date +%Y%m%d%H%M%S)" apk size hex got want build code name
  # No hq address goes into the APK: one app for every server, which it learns from a pairing link or
  # its sign-in screen (packages/app/lib/data/backend_select.dart). One APK per ABI keeps the download small; the owner's phone (OnePlus 13) is arm64.
  # The build number is the commit count of main, so every deploy has a higher versionCode than the
  # one before (Android adds 1000 x ABI on top); the in-app update compares exactly that number.
  [[ "$(git rev-parse --is-shallow-repository)" == false ]] || fail "ה-checkout רדוד, ולכן מספר ה-build לא אמין"
  build="$(git rev-list --count HEAD)"
  (cd packages/app \
    && "$FLUTTER" build web --release --base-href / --no-web-resources-cdn >/dev/null \
    && "$FLUTTER" build apk --release --split-per-abi --build-number="$build" >/dev/null) || fail "flutter build"
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
  [[ "$(curl -s -o /dev/null -w '%{http_code}' "$API_URL/health")" == 200 ]] || fail "$API_URL לא עונה אחרי reload"
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
