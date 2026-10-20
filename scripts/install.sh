#!/usr/bin/env bash
# Installs agent-company on a Linux server in one command (docs/generic/PLAN.md §2), as the user who runs it:
# no root, no Docker, everything a systemd --user unit (dir-0005). Safe to run again: every step checks
# what is already there and skips it, so a second run fixes what is missing and breaks nothing.
#
#   curl -fsSL https://get.<domain>/install | bash          (later; today: bash scripts/install.sh)
#   bash scripts/install.sh [options]                         (options: --help)
#
# The steps, in order (the plan's eight; the engine comes before Claude Code because the pinned version and
# its installer live in the engine):
#   1. requirements: Ubuntu/Debian, systemd, Node 22.18+, git, gh, curl, 16GB memory
#   2. explicit consent to the workers' full access (typed "כן"), remembered in ~/.config/agent-company/install.json
#   3. the engine at a tag: ~/.local/share/agent-company/engine/<tag> (the tree, no .git), `current` -> <tag>, npm ci
#   4. Claude Code at the version the engine pins (scripts/install-claude.sh), `claude auth login`, canary
#   5. the company from starter/ in COMPANY_HOME, a local git repo
#   6. the public address: Caddy (own domain), Cloudflare Tunnel, or Tailscale Funnel; all of them go
#      through a user Caddy on 127.0.0.1:7480 that serves hq under /hq, /pair and assetlinks.json
#   7. hq.config.json, linger, the units, hq up; a pairing code and its QR in the terminal
#   8. scripts/verify-prod.mjs --install against the public address
#
# Units this script writes carry the line "$MARK" (below). It never overwrites a unit without it, so on a
# server set up by hand (hq-host) it stops instead of replacing anything.
set -euo pipefail

MARK='# managed by agent-company install.sh'
REPO_DEFAULT='https://github.com/hivecode-app/hive-code.git'
CADDY_VERSION='2.11.7'
CADDY_SHA512_amd64='a7a433a1b133efc3c8d10eb0b99d52a24b5ef5c322dc77f5282182b1c0402139ab83f3a99f0c52409df77d20123fb0b523edad8a66d8f5e49136197bf61ef0e7'
CADDY_SHA512_arm64='3db36ba90c7a6e8dda40ee3dd71fa08844c76b5fb08f61b31e5e78d2ed38e71c51dc7baed875e50d1ca1279196e84302967237386ae87c91ae9f2aaceada682e'
CLOUDFLARED_VERSION='2026.10.2'
CLOUDFLARED_SHA256_amd64='35fbdd2beb378436c7da377d7358cea8e33f9c94a6705d1d8036bf9b0d6d8005'
CLOUDFLARED_SHA256_arm64='b7e55b4d9702c2ab5f8348f780bb1db044527fc555367714c78e0595750a4665'
WEB_PORT=7480
HQ_LOCAL='http://127.0.0.1:7420'

SHARE="$HOME/.local/share/agent-company"
ENGINES="$SHARE/engine"
ENGINE="$ENGINES/current"
BIN="$SHARE/bin"
STATE="$HOME/.local/state/agent-company"
CONF="$HOME/.config/agent-company"
UNITS="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
RECORD="$CONF/install.json"

usage() {
  cat <<'EOF'
bash scripts/install.sh [options]   (later: curl -fsSL https://get.<domain>/install | bash -s -- [options])
  --address funnel|tunnel|domain|local   how the phone reaches hq (asked when missing; remembered)
  --domain NAME                          for tunnel and domain
  --company-home DIR                     where the company lives (default: $COMPANY_HOME, else ~/company)
  --repo URL|PATH                        the engine repo (default: $AGENT_COMPANY_REPO, else GitHub)
  --version REF                          engine tag (default: the newest v* tag; main when there is none)
  --accept-full-access                   the consent of step 2, for a non-interactive run
  --skip-claude-login                    test runs only: no `claude auth login` and no canary
env: CLOUDFLARE_TUNNEL_TOKEN (tunnel; replaces a saved one), INSTALL_MIN_MEM_GB (default 16)
EOF
}

# Everything runs from main, called on the last line: under `curl | bash`, a download cut short runs nothing.
main() {
address=""; domain=""; company_home=""; repo="${AGENT_COMPANY_REPO:-$REPO_DEFAULT}"; version=""
accept=0; skip_login=0
while (($#)); do
  case "$1" in
    --address) address="${2:?}"; shift 2 ;;
    --domain) domain="${2:?}"; shift 2 ;;
    --company-home) company_home="${2:?}"; shift 2 ;;
    --repo) repo="${2:?}"; shift 2 ;;
    --version) version="${2:?}"; shift 2 ;;
    --accept-full-access) accept=1; shift ;;
    --skip-claude-login) skip_login=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ארגומנט לא מוכר: $1 (--help)" >&2; exit 2 ;;
  esac
done

# ── output ───────────────────────────────────────────────────────────────────
step() { printf '\n\033[1m%s/8 · %s\033[0m\n' "$1" "$2"; }
say() { printf '  %s\n' "$*"; }
done_() { printf '  ✓ %s\n' "$*"; }
die() { printf '\n  ✗ %s\n' "$1" >&2; shift; for l in "$@"; do printf '    %s\n' "$l" >&2; done; exit 1; }
has_tty() { [ -r /dev/tty ] && [ -w /dev/tty ] && { : </dev/tty; } 2>/dev/null; }
# Under `curl | bash` stdin is the script itself: every answer comes from the terminal.
ask() { local q="$1" a; has_tty || die "אין terminal לשאלה: $q" "הריצו מ-terminal, או העבירו את התשובה כ-flag (--help)."; printf '  %s ' "$q" >/dev/tty; IFS= read -r a </dev/tty; printf '%s' "$a"; }

# install.json: what this machine already answered (consent, address, domain, company home). Small JSON, via node.
record_get() { [ -f "$RECORD" ] && node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=r[process.argv[2]];if(v!=null)process.stdout.write(String(v))' "$RECORD" "$1" 2>/dev/null || true; }
record_set() {
  mkdir -p "$CONF"
  node -e 'const fs=require("fs");const [f,...kv]=process.argv.slice(1);let r={};try{r=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}
for(let i=0;i<kv.length;i+=2)r[kv[i]]=kv[i+1];fs.writeFileSync(f,JSON.stringify(r,null,2)+"\n",{mode:0o600})' "$RECORD" "$@"
}

[ "$(id -u)" -ne 0 ] || die "לא מריצים את ההתקנה כ-root." "החברה רצה כמשתמש הרגיל שלך, כ-systemd --user. הריצו שוב בלי sudo."
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export NPM_CONFIG_UPDATE_NOTIFIER=false

# ── 1. requirements ──────────────────────────────────────────────────────────
step 1 "דרישות"
missing=()
os_id=""; os_like=""
if [ -r /etc/os-release ]; then os_id="$(. /etc/os-release; echo "${ID:-}")"; os_like="$(. /etc/os-release; echo "${ID_LIKE:-}")"; fi
case " $os_id $os_like " in *" ubuntu "*|*" debian "*) ;; *) missing+=("מערכת הפעלה: צריך Ubuntu או Debian (נמצא: ${os_id:-לא ידוע})") ;; esac
[ -d /run/systemd/system ] || missing+=("systemd: המכונה לא רצה עם systemd")
case "$(uname -m)" in x86_64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; *) arch=""; missing+=("מעבד: צריך x86_64 או arm64 (נמצא $(uname -m))") ;; esac
if command -v node >/dev/null; then
  nv="$(node -p 'process.versions.node')"
  node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)' \
    || missing+=("Node $nv: צריך 22.18 ומעלה (המנוע רץ TypeScript ישירות)")
else missing+=("Node 22.18 ומעלה: לא מותקן (https://nodejs.org או nvm)"); fi
for c in npm git gh curl tar; do command -v "$c" >/dev/null || missing+=("$c: לא מותקן"); done
min_gb="${INSTALL_MIN_MEM_GB:-16}"
mem_kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
# A 16GB machine reports a little less (the kernel keeps some): 93% is enough.
[ "$mem_kb" -ge $((min_gb * 1024 * 1024 * 93 / 100)) ] || missing+=("זיכרון: $((mem_kb / 1024 / 1024))GB, צריך ${min_gb}GB לפחות (כ-5GB לכל עובד פעיל)")
# A server set up by hand (hq-host) has these units, as symlinks or without the mark: stop before writing anything.
for u in agent-company-hq.service agent-company-web.service agent-company-tunnel.service company-shift@.service; do
  f="$UNITS/$u"
  if [ -L "$f" ] || { [ -e "$f" ] && ! grep -qxF "$MARK" "$f"; }; then
    missing+=("‏$f קיים ולא נוצר על ידי ההתקנה: המכונה כבר מוגדרת ביד, וההתקנה לא נוגעת בה")
  fi
done
((${#missing[@]} == 0)) || die "חסרים דברים במכונה. אחרי שמסדרים אותם מריצים שוב:" "${missing[@]}"
done_ "$(. /etc/os-release; echo "$PRETTY_NAME") · systemd · Node $nv · git · gh · $((mem_kb / 1024 / 1024))GB"
gh auth status >/dev/null 2>&1 || say "‏gh לא מחובר. לא חוסם את ההתקנה, אבל העובדים צריכים אותו ל-PR: gh auth login"

# ── 2. consent ───────────────────────────────────────────────────────────────
step 2 "הגישה של העובדים"
if [ -n "$(record_get accepted_at)" ]; then
  done_ "אושר ב-$(record_get accepted_at)"
else
  cat <<'EOF'
  העובדים בחברה הם סשנים של Claude Code שרצים עם bypassPermissions, בשמך, על המכונה הזו:
  - הם יכולים לקרוא, לכתוב ולמחוק כל קובץ של המשתמש הזה, ולהריץ כל פקודה בלי לשאול.
  - הם משתמשים ב-repos, בחשבון GitHub (gh) ובדפדפן שלך, ויכולים לפרוס ולגלוש בשמך.
  - החסימות היחידות: מחיקת שורש המערכת או הבית, פרמוט, כתיבה ישירה לדיסק, fork bomb וכיבוי המכונה.
  - פעולה חדשה כלפי אנשים בחוץ (מייל, פרסום, תשלום) מחכה לאישור שלך.
EOF
  if ((accept)); then answer="כן"; say "‏--accept-full-access: אושר."
  else answer="$(ask 'מאשר? הקלד "כן" כדי להמשיך:')"; fi
  [ "$answer" = "כן" ] || die "לא אושר, ההתקנה נעצרה. בלי הגישה הזו המנוע לא עובד."
  record_set accepted_at "$(date -Is)"
  done_ "אושר"
fi

# ── 3. the engine ────────────────────────────────────────────────────────────
step 3 "המנוע"
if [ -L "$ENGINE" ] && [ -f "$ENGINE/.install-ok" ]; then
  done_ "מותקן: $(readlink "$ENGINE"). עדכון גרסה: company update"
else
  if [ -z "$version" ]; then
    version="$(git ls-remote --tags --refs --sort=-v:refname "$repo" 'v*' 2>/dev/null | head -1 | sed 's#.*refs/tags/##')" || true
    [ -n "$version" ] || { version=main; say "אין עדיין גרסה מתויגת ב-$repo: מתקינה את main."; }
  fi
  # An annotated tag lists its tag object first; the commit is the ^{} line.
  refs="$(git ls-remote "$repo" "refs/tags/$version^{}" "refs/tags/$version" "refs/heads/$version" 2>/dev/null)" || true
  sha="$( { grep -F '^{}' <<<"$refs" || head -1 <<<"$refs"; } | head -1 | cut -f1)"
  [ -n "$sha" ] || { [[ "$version" =~ ^[0-9a-f]{7,40}$ ]] && sha="$version"; } \
    || die "לא מצאתי את $version ב-$repo." "repo פרטי? gh auth login ואז gh auth setup-git, ומריצים שוב."
  # A tag keeps its name; a branch or a commit is named by its commit, so `current` always means one tree.
  if git ls-remote --tags "$repo" "refs/tags/$version" | grep -q .; then name="$version"; else name="${sha:0:12}"; fi
  dest="$ENGINES/$name"
  if [ ! -f "$dest/.install-ok" ]; then
    tmp="$ENGINES/.$name.partial"; src="$ENGINES/.$name.git"
    rm -rf "$tmp" "$src" "$dest"
    mkdir -p "$ENGINES" "$tmp"
    say "מוריד את $version ($name) מ-$repo"
    # A fixed tree, not a git checkout: nobody pulls new code into what the units run (the lesson of 21/10).
    # A new version is a new directory and a new `current`, by company update.
    git clone --quiet --bare "$repo" "$src"
    git -C "$src" archive "$sha" | tar -x -C "$tmp"
    rm -rf "$src"
    printf '%s %s %s\n' "$name" "$sha" "$repo" >"$tmp/.engine-version"
    say "מתקין תלויות (npm ci)"
    (cd "$tmp" && npm ci --omit=dev --no-audit --no-fund --loglevel=error >/dev/null)
    touch "$tmp/.install-ok"
    mv "$tmp" "$dest"
  fi
  ln -sfn "$name" "$ENGINE"
  done_ "מותקן: $name ב-$dest"
fi
if [ -f "$ENGINE/scripts/company" ]; then
  mkdir -p "$HOME/.local/bin"
  ln -sfn "$ENGINE/scripts/company" "$HOME/.local/bin/company"
fi

# ── 4. Claude Code ───────────────────────────────────────────────────────────
step 4 "Claude Code"
claude_ver="$(sed -n "s/^export const PINNED_VERSION = '\(.*\)';/\1/p" "$ENGINE/packages/adapter/src/binary.ts")"
[ -n "$claude_ver" ] || die "לא מצאתי את PINNED_VERSION במנוע ($ENGINE/packages/adapter/src/binary.ts)."
claude_root="$SHARE/claude"
claude="$claude_root/$claude_ver/claude"
if [ -x "$claude" ]; then done_ "גרסה $claude_ver מותקנת"
else say "מתקין את Claude Code $claude_ver (גרסה נעולה, לא נוגע ב-claude הגלובלי)"; bash "$ENGINE/scripts/install-claude.sh" "$claude_ver" >/dev/null; done_ "גרסה $claude_ver הותקנה"; fi
logged_in() { DISABLE_AUTOUPDATER=1 "$claude" auth status >/dev/null 2>&1; }
if logged_in; then done_ "מחובר לחשבון Claude"
elif ((skip_login)); then say "‏--skip-claude-login: בלי התחברות. העובדים לא יעלו עד claude auth login."
else
  has_tty || die "צריך להתחבר לחשבון Claude, ואין terminal." "הריצו מ-terminal."
  say "מתחבר לחשבון Claude שלך (מנוי Pro או Max). נפתח קישור: מתחברים בדפדפן ומדביקים את הקוד כאן."
  DISABLE_AUTOUPDATER=1 "$claude" auth login --claudeai </dev/tty >/dev/tty 2>&1 || true
  logged_in || die "ההתחברות ל-Claude לא הושלמה. מריצים שוב את ההתקנה, והיא ממשיכה מכאן."
  done_ "מחובר לחשבון Claude"
fi
if [ "$(readlink "$claude_root/current" 2>/dev/null)" = "$claude_ver" ]; then done_ "canary עבר, current -> $claude_ver"
elif logged_in; then
  say "מריץ canary: משמרת קצרה אחת שבודקת שהגרסה עובדת עם המנוע (כדקה)"
  mkdir -p "$CONF"
  bash "$ENGINE/scripts/install-claude.sh" "$claude_ver" --activate >"$CONF/canary.log" 2>&1 \
    || die "ה-canary נכשל, הגרסה לא הופעלה." "$(tail -5 "$CONF/canary.log")"
  rm -f "$CONF/canary.log"
  done_ "canary עבר, current -> $claude_ver"
else say "בלי התחברות אין canary. המנוע ישתמש ב-$claude_ver ישירות."; fi

# ── 5. the company ───────────────────────────────────────────────────────────
step 5 "החברה"
company_home="${company_home:-${COMPANY_HOME:-$(record_get company_home)}}"
company_home="${company_home:-$HOME/company}"
company_home="${company_home/#\~/$HOME}"
mkdir -p "$(dirname "$company_home")"
company_home="$(cd "$(dirname "$company_home")" && pwd)/$(basename "$company_home")"
if [ -f "$company_home/company/org.yaml" ]; then
  done_ "קיימת ב-$company_home. ההתקנה לא נוגעת בה."
else
  if [ -e "$company_home" ] && [ -n "$(ls -A "$company_home" 2>/dev/null)" ]; then
    die "$company_home קיימת ואינה ריקה, ואין בה company/org.yaml." "בוחרים תיקייה אחרת: --company-home <dir>."
  fi
  # Built aside and moved in at the end: a run that fails halfway leaves no half company to skip next time.
  part="$company_home.partial"
  rm -rf "$part"; mkdir -p "$part"
  cp -r "$ENGINE/starter/company" "$ENGINE/starter/memory" "$ENGINE/starter/examples" "$part/"
  git -C "$part" init --quiet -b main
  git -C "$part" add -A
  ident=()
  git -C "$part" config user.name >/dev/null || ident+=(-c "user.name=$(id -un)")
  git -C "$part" config user.email >/dev/null || ident+=(-c "user.email=$(id -un)@$(hostname)")
  git -C "$part" "${ident[@]}" commit --quiet -m "החברה נוצרה מערכת הפתיחה של agent-company ($(readlink "$ENGINE"))" \
    || die "ה-commit הראשון של החברה נכשל (למשל commit.gpgsign בלי מפתח זמין). מתקנים ומריצים שוב."
  # An existing empty dir (maybe a mount point) gets the contents; otherwise the dir itself moves in.
  if [ -d "$company_home" ]; then
    cp -a "$part"/. "$company_home"/ || die "העתקת החברה ל-$company_home נכשלה."
    rm -rf "$part"
  else mv -T "$part" "$company_home"; fi
  [ -f "$company_home/company/org.yaml" ] || die "החברה לא נוצרה ב-$company_home."
  done_ "נוצרה ב-$company_home מערכת הפתיחה, כ-repo git"
fi
record_set company_home "$company_home"
node "$ENGINE/scripts/check-contract.mjs" "$company_home" >/dev/null 2>"$CONF/check.err" \
  && done_ "company check עבר" || say "company check מצא בעיות בחברה (המנהל יתקן בהקמה): $(head -3 "$CONF/check.err" | tr '\n' ' ')"
rm -f "$CONF/check.err"

# ── 6. the public address ────────────────────────────────────────────────────
step 6 "כתובת ציבורית"
address="${address:-$(record_get address)}"
domain="${domain:-$(record_get domain)}"
if [ -z "$address" ]; then
  has_tty || die "אין terminal לבחירת כתובת." "העבירו --address funnel|tunnel|domain|local."
  cat <<'EOF' >/dev/tty
  איך הטלפון יגיע לשרת?
    1. Tailscale Funnel: בלי דומיין. כתובת קבועה <machine>.<tailnet>.ts.net עם HTTPS, בחינם (ברירת המחדל)
    2. Cloudflare Tunnel: יש לך דומיין ב-Cloudflare
    3. דומיין שמצביע לשרת הזה: Caddy עם TLS אוטומטי
    4. רק מקומי (localhost): לבדיקה, הטלפון לא יגיע
EOF
  case "$(ask 'מספר [1]:')" in 1|"") address=funnel ;; 2) address=tunnel ;; 3) address=domain ;; 4) address=local ;; *) die "אפשרות לא מוכרת." ;; esac
fi
case "$address" in funnel|tunnel|domain|local) ;; *) die "‏--address: funnel, tunnel, domain או local." ;; esac
if [[ "$address" = tunnel || "$address" = domain ]] && [ -z "$domain" ]; then domain="$(ask 'הדומיין (למשל hq.example.com):')"; fi
domain="${domain#https://}"; domain="${domain%%/*}"
if [[ "$address" = tunnel || "$address" = domain ]]; then
  [[ "$domain" =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || die "דומיין לא תקין: '$domain'"
fi

# Pinned downloads: the file is kept only when its hash matches the one written above.
fetch_pinned() { # url dest algo hash
  local tmp; tmp="$(mktemp)"
  curl -fsSL "$1" -o "$tmp" || { rm -f "$tmp"; die "ההורדה נכשלה: $1"; }
  echo "$4  $tmp" | "${3}sum" -c --status || { rm -f "$tmp"; die "ה-hash של $1 לא תואם. לא מתקינה."; }
  mv "$tmp" "$2"
}
mkdir -p "$BIN"
caddy="$BIN/caddy-$CADDY_VERSION"
if [ ! -x "$caddy" ]; then
  sha_var="CADDY_SHA512_$arch"
  tgz="$(mktemp)"
  fetch_pinned "https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION/caddy_${CADDY_VERSION}_linux_$arch.tar.gz" "$tgz" sha512 "${!sha_var}"
  tar -xzf "$tgz" -C "$BIN" caddy || die "פריסת Caddy מהארכיון נכשלה."
  mv "$BIN/caddy" "$caddy"
  chmod 755 "$caddy"
  rm -f "$tgz"
fi
done_ "Caddy $CADDY_VERSION"

origin=""
case "$address" in
  local) origin="http://localhost:$WEB_PORT" ;;
  domain|tunnel) origin="https://$domain" ;;
  funnel)
    command -v tailscale >/dev/null || die "Tailscale לא מותקן. מתקינים פעם אחת (דורש sudo), ומריצים שוב:" \
      "curl -fsSL https://tailscale.com/install.sh | sh" "sudo tailscale up" "sudo tailscale set --operator=$(id -un)"
    ts_json="$(tailscale status --json 2>/dev/null)" || die "tailscale לא עונה. sudo tailscale up, ומריצים שוב."
    ts_host="$(node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8"));if(s.BackendState!=="Running")process.exit(1);process.stdout.write((s.Self?.DNSName??"").replace(/\.$/,""))' <<<"$ts_json")" \
      || die "Tailscale לא מחובר. sudo tailscale up, ומריצים שוב."
    [ -n "$ts_host" ] || die "ל-Tailscale אין שם DNS למכונה. מפעילים MagicDNS ו-HTTPS ב-tailnet ומריצים שוב:" "https://login.tailscale.com/admin/dns"
    origin="https://$ts_host" ;;
esac
record_set address "$address" domain "$domain"

# The web app: an engine release that ships the web build serves it; otherwise a short page that points to the app.
web="$ENGINE/packages/app/build/web"
if [ ! -f "$web/index.html" ]; then
  web="$SHARE/web-placeholder"
  mkdir -p "$web"
  cat >"$web/index.html" <<'EOF'
<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>החברה</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.6">
<h1 style="font-size:1.4rem">השרת של החברה עובד</h1>
<p>הגרסה הזו של המנוע עוד לא כוללת את האפליקציה ל-web. נכנסים מהאפליקציה לאנדרואיד: סורקים את ה-QR מההתקנה, או מדביקים את הקישור במסך הכניסה.</p>
</body></html>
EOF
fi

# The routes live in one snippet. The loopback site answers any Host, because Funnel and Tunnel send their own
# (a site named 127.0.0.1 would answer every other Host with Caddy's empty 200). A domain gets its own TLS site too.
domain_site=""
[ "$address" = domain ] && domain_site="$(printf '\n%s {\n\timport hq\n}' "$domain")"
caddyfile="$CONF/Caddyfile"
caddy_new="$(cat <<EOF
$MARK
# hq's public face: one origin, hq under /hq (the app's layout), the pairing page and assetlinks.json from hq,
# the web app at the root. Funnel and Tunnel point at 127.0.0.1:$WEB_PORT; a domain gets TLS from Caddy itself.
{
	admin off
	$( [ "$address" = domain ] || printf 'auto_https off' )
}

(hq) {
	encode zstd gzip
	handle_path /hq/* {
		reverse_proxy 127.0.0.1:7420 {
			flush_interval -1
		}
	}
	@pairing path /pair /.well-known/assetlinks.json
	handle @pairing {
		reverse_proxy 127.0.0.1:7420
	}
	handle {
		root * $web
		header Cache-Control "no-cache"
		header X-Robots-Tag "noindex, nofollow"
		try_files {path} /index.html
		file_server
	}
}

http://:$WEB_PORT {
	bind 127.0.0.1
	import hq
}
$domain_site
EOF
)"
mkdir -p "$CONF"
changed_web=0
if [ "$(cat "$caddyfile" 2>/dev/null)" != "$caddy_new" ]; then printf '%s\n' "$caddy_new" >"$caddyfile"; changed_web=1; fi
"$caddy" validate --config "$caddyfile" --adapter caddyfile >/dev/null 2>"$CONF/caddy.err" \
  || die "קובץ ה-Caddy לא תקין:" "$(tail -3 "$CONF/caddy.err")"
rm -f "$CONF/caddy.err"
if [ "$address" = domain ]; then
  low="$(cat /proc/sys/net/ipv4/ip_unprivileged_port_start 2>/dev/null || echo 1024)"
  if [ "$low" -gt 80 ] && ! getcap "$caddy" 2>/dev/null | grep -q cap_net_bind_service; then
    die "Caddy צריך הרשאה להאזין לפורטים 80 ו-443. פקודה אחת עם sudo, ואז מריצים שוב:" "sudo setcap cap_net_bind_service=+ep $caddy"
  fi
fi

# ── units ────────────────────────────────────────────────────────────────────
node_bin="$(command -v node)"
unit_path="$(dirname "$node_bin"):$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
changed_units=()
write_unit() { # name content
  local f="$UNITS/$1"
  if [ -L "$f" ] || { [ -e "$f" ] && ! grep -qxF "$MARK" "$f"; }; then
    die "‏$f קיים ולא נוצר על ידי ההתקנה. לא דורסת אותו." "המכונה הזו כבר מוגדרת ביד; ההתקנה מיועדת לשרת חדש."
  fi
  mkdir -p "$UNITS"
  if [ "$(cat "$f" 2>/dev/null)" != "$2" ]; then printf '%s\n' "$2" >"$f"; changed_units+=("$1"); fi
}

write_unit agent-company-web.service "$MARK
[Unit]
Description=agent-company public face (Caddy: hq under /hq, pairing, the web app)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=$caddy run --config $caddyfile --adapter caddyfile
Restart=always
RestartSec=2

[Install]
WantedBy=default.target"

if [ "$address" = tunnel ]; then
  cf="$BIN/cloudflared-$CLOUDFLARED_VERSION"
  if [ ! -x "$cf" ]; then
    sha_var="CLOUDFLARED_SHA256_$arch"
    fetch_pinned "https://github.com/cloudflare/cloudflared/releases/download/$CLOUDFLARED_VERSION/cloudflared-linux-$arch" "$cf" sha256 "${!sha_var}"
    chmod 755 "$cf"
  fi
  # CLOUDFLARE_TUNNEL_TOKEN always wins: that is how a wrong saved token gets replaced.
  if [ ! -s "$CONF/cloudflared.env" ] || [ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]; then
    token="${CLOUDFLARE_TUNNEL_TOKEN:-}"
    if [ -z "$token" ]; then
      has_tty || die "צריך את ה-token של ה-Cloudflare Tunnel, ואין terminal." "מריצים עם CLOUDFLARE_TUNNEL_TOKEN=<token>."
      cat <<EOF >/dev/tty
  ב-Cloudflare: Zero Trust → Networks → Tunnels → Create a tunnel (Cloudflared). שם: מה שתרצה.
  ב-Public Hostname: $domain → HTTP → 127.0.0.1:$WEB_PORT. אחר כך מעתיקים את ה-token מפקודת ההתקנה שהוא מציג.
EOF
      token="$(ask 'ה-token של ה-tunnel:')"
    fi
    token="${token##* }"
    [ -n "$token" ] || die "בלי token אין tunnel."
    if [ "$(cat "$CONF/cloudflared.env" 2>/dev/null)" != "TUNNEL_TOKEN=$token" ]; then
      (umask 077; printf 'TUNNEL_TOKEN=%s\n' "$token" >"$CONF/cloudflared.env")
      changed_units+=(agent-company-tunnel.service)
    fi
  fi
  write_unit agent-company-tunnel.service "$MARK
[Unit]
Description=agent-company Cloudflare Tunnel ($domain -> 127.0.0.1:$WEB_PORT)
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=$CONF/cloudflared.env
ExecStart=$cf tunnel --no-autoupdate run
Restart=always
RestartSec=5

[Install]
WantedBy=default.target"
  done_ "Cloudflare Tunnel $CLOUDFLARED_VERSION ל-$domain"
fi

write_unit agent-company-hq.service "$MARK
# company hq (B.1). Shifts run as their own units (company-shift@<shift>), so restarting hq never kills one (B.5).
[Unit]
Description=agent-company hq (store, mailboxes, inbox, scheduler, watchdog, probes, API)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$ENGINE
ExecStart=$node_bin $ENGINE/packages/hq/src/main.ts
Environment=NODE_ENV=production
Environment=PATH=$unit_path
EnvironmentFile=-$CONF/hq.env
UMask=0077
Restart=always
RestartSec=2
TimeoutStopSec=20
KillMode=mixed

[Install]
WantedBy=default.target"

write_unit company-shift@.service "$MARK
# One shift = one instance: company-shift@<shift>.service. hq writes host-args.json, then enable --now.
[Unit]
Description=agent-company shift %i
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
Environment=DISABLE_AUTOUPDATER=1
Environment=PATH=$unit_path
UMask=0077
ExecStart=$node_bin $ENGINE/packages/shift-host/src/cli.ts --args-file %h/.local/state/agent-company/shifts/%i/host-args.json
Restart=on-failure
RestartSec=1
RestartPreventExitStatus=75 76 2
KillMode=mixed
TimeoutStopSec=20

[Install]
WantedBy=default.target"

# ── 7. hq ────────────────────────────────────────────────────────────────────
step 7 "hq"
mkdir -p "$STATE"; chmod 700 "$STATE"
cfg_changed="$(node - "$STATE/hq.config.json" "$company_home" "$origin" "$UNITS/company-shift@.service" "$(id -un)" "$HOME" <<'EOF'
const fs = require('fs');
const [file, companyHome, origin, shiftTemplate, user, home] = process.argv.slice(2);
let c = {};
try { c = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
const before = JSON.stringify(c);
const host = new URL(origin).hostname;
c.companyHome = companyHome;
delete c.companyDir;
c.apiUrl = `${origin}/hq`;
c.appReleaseDir = null;
c.shiftTemplate = shiftTemplate;
c.defaultCwd ??= home;
c.auth = { ...(c.auth ?? {}) };
// A new address means a new rpId: passkeys made for the old one stop working there (pairing still does).
c.auth.rpId = host;
c.auth.appUrl = origin;
c.auth.origins = [origin];
c.auth.userName ??= user;
c.auth.userDisplayName ??= user;
const after = JSON.stringify(c);
if (after !== before) fs.writeFileSync(file, JSON.stringify(c, null, 2) + '\n', { mode: 0o600 });
process.stdout.write(after !== before ? '1' : '0');
EOF
)"
done_ "hq.config.json: $origin, החברה ב-$company_home"

if [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" != yes ]; then
  loginctl enable-linger "$(id -un)" 2>/dev/null \
    || die "צריך להפעיל linger, כדי שהחברה תמשיך לרוץ כשאתה לא מחובר ואחרי הפעלה מחדש. פקודה אחת, ואז מריצים שוב:" "sudo loginctl enable-linger $(id -un)"
fi
done_ "linger פעיל: החברה רצה גם בלי חיבור ואחרי הפעלה מחדש"

systemctl --user daemon-reload
units=(agent-company-hq.service agent-company-web.service)
[ "$address" = tunnel ] && units+=(agent-company-tunnel.service)
systemctl --user enable --quiet "${units[@]}"
# Restart only what changed (a restart of hq is safe: shifts are their own units and survive it).
for u in "${units[@]}"; do
  restart=0
  [[ " ${changed_units[*]} " = *" $u "* ]] && restart=1
  [ "$u" = agent-company-hq.service ] && [ "$cfg_changed" = 1 ] && restart=1
  [ "$u" = agent-company-web.service ] && ((changed_web)) && restart=1
  if ((restart)); then systemctl --user restart "$u"; else systemctl --user start "$u"; fi
done
for _ in $(seq 60); do curl -fsS "$HQ_LOCAL/health" >/dev/null 2>&1 && break; sleep 0.5; done
curl -fsS "$HQ_LOCAL/health" >/dev/null 2>&1 || die "hq לא עלה." "journalctl --user -u agent-company-hq -n 30"
for _ in $(seq 20); do curl -fsS "http://127.0.0.1:$WEB_PORT/hq/health" >/dev/null 2>&1 && break; sleep 0.5; done
curl -fsS "http://127.0.0.1:$WEB_PORT/hq/health" >/dev/null 2>&1 || die "Caddy לא מעביר ל-hq." "journalctl --user -u agent-company-web -n 30"
done_ "hq רץ (${units[*]})"

if [ "$address" = funnel ]; then
  # On only when the same site both proxies to our Caddy and is open to Funnel.
  funnel_on() {
    tailscale funnel status --json 2>/dev/null | node -e '
const s = JSON.parse(require("fs").readFileSync(0, "utf8") || "{}"), want = "127.0.0.1:" + process.argv[1];
const on = Object.entries(s.Web ?? {}).some(([site, w]) => s.AllowFunnel?.[site] &&
  Object.values(w.Handlers ?? {}).some((h) => String(h.Proxy ?? "").includes(want)));
process.exit(on ? 0 : 1)' "$WEB_PORT"
  }
  if funnel_on; then done_ "Funnel פעיל: $origin"
  else
    say "מפעיל Tailscale Funnel ל-127.0.0.1:$WEB_PORT. אם Funnel עוד לא מאושר ב-tailnet, יופיע קישור לאישור."
    tailscale funnel --bg "http://127.0.0.1:$WEB_PORT" </dev/null 2>&1 | sed 's/^/    /' || true
    funnel_on \
      || die "Funnel לא הופעל." "אם כתוב Access denied: sudo tailscale set --operator=$(id -un)" "אם Funnel לא מאושר: מאשרים בקישור שהודפס, ומריצים שוב."
    done_ "Funnel פעיל: $origin"
  fi
fi

# hq's own warnings (an empty timezone until the setup conversation) stay out of the QR's way.
pair_out="$(node "$ENGINE/packages/hq/src/main.ts" pair --qr 2>"$CONF/pair.err")" || die "קוד הצימוד לא נוצר:" "$(tail -3 "$CONF/pair.err")"
rm -f "$CONF/pair.err"
say "קוד צימוד לטלפון (תקף 10 דקות). סורקים במצלמה של הטלפון:"
printf '%s\n' "$pair_out" | sed 's/^/  /'
say "קוד חדש בכל זמן: node $ENGINE/packages/hq/src/main.ts pair --qr"

# ── 8. verify ────────────────────────────────────────────────────────────────
step 8 "בדיקה מבחוץ"
if [ "$address" = tunnel ] || [ "$address" = domain ]; then
  for _ in $(seq 30); do curl -fsS "$origin/hq/health" >/dev/null 2>&1 && break; sleep 2; done
fi
if out="$(node "$ENGINE/scripts/verify-prod.mjs" --install 2>&1)"; then
  printf '%s\n' "$out" | sed 's/^/  /'
  printf '\n\033[1mהחברה מותקנת וזמינה ב-%s. סורקים את ה-QR, והמנהל מחכה לך באפליקציה.\033[0m\n' "$origin"
  # From this server the ts.net name may resolve inside the tailnet, so the check above need not cross Funnel.
  [ "$address" = funnel ] && say "ב-Funnel הבדיקה רצה מהשרת עצמו. מהטלפון, עם Wi-Fi כבוי, פותחים $origin/pair?code=TEST כדי לראות שהכתובת נגישה מבחוץ."
  return 0
else
  printf '%s\n' "$out" | sed 's/^/  /'
  hint=()
  [ "$address" = tunnel ] && hint=("ב-tunnel: journalctl --user -u agent-company-tunnel -n 30. token אחר: CLOUDFLARE_TUNNEL_TOKEN=<token> ומריצים שוב.")
  die "חלק מהבדיקות נכשלו (למעלה). מתקנים ומריצים שוב את ההתקנה: היא ממשיכה ממה שכבר קיים." "${hint[@]}"
fi
}

main "$@"
