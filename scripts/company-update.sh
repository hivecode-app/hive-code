#!/usr/bin/env bash
# `company update [<tag>]`: moves an installed engine to a new tagged version (docs/generic/PLAN.md §5).
# `company update --from-tarball <file>`: the same, from a release file (scripts/release.sh) with SHA256SUMS next to it.
#
# The engine lives in ~/.local/share/agent-company/engine/<name>, and engine/current is a relative symlink to the live
# one; the units (hq, company-shift@) run from engine/current (scripts/install.sh). An update:
#   1. installs the tag (default: the highest vX.Y.Z of the engine's repo) into engine/<tag>, the way the installer
#      does (scripts/lib/engine-install.sh: the tag's release, checksum checked, with web/ and apk/; or a tree without
#      .git when the tag has no release; then `npm ci --omit=dev`);
#   2. asks the NEW engine about the company: org.yaml's format (a change is opened as a PR in the company's repo and
#      the update stops until it is merged: nothing is rewritten in place), then `company check`;
#   3. backs hq.db up and runs the new engine's migrations on a copy of it;
#   4. installs the Claude Code version the new engine is pinned to (scripts/install-claude.sh, with its canary);
#   5. switches engine/current, restarts hq safely (live shifts survive, scripts/lib/hq-restart.sh), and verifies
#      production end to end (scripts/verify-prod.mjs);
#   6. anything failing after the switch puts the previous engine and Claude Code back and restarts hq on them.
#      hq.db stays as the new hq migrated it: migrations only add (packages/hq/src/store.ts), and an older hq reads a
#      newer schema. The backup from step 3 is kept and named in the summary.
#   7. old versions go once no live shift runs them: a shift runs the code of the version that was current when it
#      started (shift-host resolves its own path), so a version is kept while a shift older than its retirement lives.
# Exit 0 = updated (or already there), 1 = failed (rolled back), 3 = waiting for the org.yaml PR.
#
# Where the engine is a development checkout and not engine/<tag> (hq-host: ~/projects/agent-company, deployed from
# main), the update is scripts/deploy.sh hq: the same checks, safe restart, verify and rollback.
set -Eeuo pipefail

self="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd -P)"
DATA="${AGENT_COMPANY_DATA:-$HOME/.local/share/agent-company}"
ENGINES="$DATA/engine"
STATE="${COMPANY_STATE:-$HOME/.local/state/agent-company}"
USTATE="$STATE/update"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

if [[ ! -L "$ENGINES/current" || "$self" != "$(readlink -f "$ENGINES/current")" ]]; then
  if [[ -x "$self/scripts/deploy.sh" && -d "$self/.git" && ! -L "$ENGINES/current" ]]; then
    echo "המנוע כאן הוא checkout ($self), לא גרסה מתויגת: העדכון הוא scripts/deploy.sh hq מ-origin/main."
    exec "$self/scripts/deploy.sh" hq
  fi
  echo "company update רץ מהמנוע החי ($ENGINES/current), לא מ-$self." >&2
  exit 2
fi

mkdir -p "$USTATE"
chmod 700 "$USTATE"
exec 9>"$USTATE/lock"
flock -n 9 || { echo "עדכון אחר כבר רץ (נעילה ב-$USTATE/lock)." >&2; exit 1; }

# shellcheck source=lib/hq-restart.sh
source "$self/scripts/lib/hq-restart.sh"
# shellcheck source=lib/engine-install.sh
source "$self/scripts/lib/engine-install.sh"

summary=()
say() { summary+=("$1"); echo "• $1"; }
step() { echo; echo "── $1"; }

cur="$(basename "$self")"
tag=""; new=""; switched=0; claude_prev=""; claude_changed=0; hq_restarted=0; backup=""

finish() {
  local rc=$1
  {
    echo
    case $rc in
      0) echo "עדכון המנוע ל-${tag:-$cur} הצליח." ;;
      3) echo "עדכון המנוע ל-$tag מחכה למיזוג של שינוי ב-org.yaml." ;;
      *) echo "עדכון המנוע ל-${tag:-?} נכשל (קוד $rc). המנוע נשאר $cur." ;;
    esac
    for s in "${summary[@]}"; do echo "- $s"; done
  } | tee "$USTATE/last-summary.txt"
}

rollback() {
  echo
  echo "── חוזר אחורה"
  if ((switched)); then
    ln -sfn "$cur" "$ENGINES/.current.new" && mv -T "$ENGINES/.current.new" "$ENGINES/current"
    rm -f "$ENGINES/$cur/.retired-at"
    date +%s >"$ENGINES/$tag/.retired-at"
    systemctl --user daemon-reload || true
    say "engine/current חזר ל-$cur"
  fi
  if ((claude_changed)); then
    if [[ -n "$claude_prev" ]]; then
      ln -sfn "$claude_prev" "$DATA/claude/.current.new" && mv -T "$DATA/claude/.current.new" "$DATA/claude/current"
      say "Claude Code חזר ל-$claude_prev"
    else
      rm -f "$DATA/claude/current"
      say "Claude Code: לא הייתה גרסה פעילה לפני העדכון, current הוסר"
    fi
  fi
  if ((hq_restarted)); then
    if systemctl --user restart agent-company-hq && wait_health; then say "hq הופעל מחדש על $cur"
    else say "hq לא חזר אחרי החזרה. journalctl --user -u agent-company-hq"; fi
    systemctl --user try-restart agent-company-web.service || say "agent-company-web לא עלה מחדש על $cur"
  fi
  if [[ -n "$backup" ]]; then say "גיבוי hq.db מלפני העדכון: $backup"; fi
}

fail() {
  [[ $BASHPID == "$$" ]] || exit 1
  trap - ERR
  set +e
  say "נכשל: $1"
  rollback
  finish 1
  exit 1
}
trap 'fail "פקודה נכשלה בשורה $LINENO: $BASH_COMMAND"' ERR

# ── which version ─────────────────────────────────────────────────────────────
step "גרסה"
url="$(engine_origin "$self")"
[[ -n "$url" ]] || fail "לא ידוע מאיזה repo המנוע ב-$self הגיע (אין .engine-version ואין origin)"
tag=""; from_tarball=""
case "${1:-}" in
  --from-tarball) from_tarball="${2:-}"; [[ -n "$from_tarball" ]] || fail "‏--from-tarball צריך קובץ" ;;
  *) tag="${1:-}" ;;
esac
if [[ -n "$from_tarball" ]]; then
  from_tarball="$(readlink -f -- "$from_tarball")"
elif [[ -z "$tag" ]]; then
  tag="$(node "$self/scripts/engine.mjs" latest-tag "$url")" || fail "לא הצלחתי לקרוא את התגים של $url"
  [[ -n "$tag" ]] || fail "אין גרסה מתויגת (vX.Y.Z) ב-$url"
fi
[[ -n "$from_tarball" || "$tag" =~ ^[A-Za-z0-9._/-]+$ ]] || fail "שם גרסה לא תקין: $tag"
if [[ -z "$from_tarball" && "$tag" == "$cur" ]]; then
  say "המנוע כבר בגרסה $tag"
  trap - ERR
  finish 0
  exit 0
fi

# ── fetch: a new directory, the live engine is not touched ───────────────────
step "הורדה"
if [[ -n "$from_tarball" ]]; then engine_install_tarball "$from_tarball" "$ENGINES" "$url" || fail "$ENGINE_ERR"
else engine_install "$url" "$tag" "$ENGINES" || fail "$ENGINE_ERR"; fi
if [[ "$ENGINE_NAME" == "$cur" ]]; then
  say "המנוע כבר בגרסה $cur ($tag)"
  trap - ERR
  finish 0
  exit 0
fi
tag="$ENGINE_NAME"
new="$ENGINES/$tag"
say "מ-$cur ל-$tag, מותקן ב-$new"

# ── the company, as the new engine reads it ──────────────────────────────────
step "החברה"
CHOME="$(node "$self/scripts/company-home.mjs" "$STATE")"
plan="$(node "$new/scripts/engine.mjs" org-plan "$CHOME")" || fail "לא הצלחתי לקרוא את $CHOME/company/org.yaml"
read -r action from to _rest <<<"$plan"
case "$action" in
  ok) say "org.yaml בפורמט $from, כמו שהמנוע החדש קורא" ;;
  newer) fail "org.yaml בפורמט $from, חדש מהמנוע $tag (קורא $to). זו לא גרסה לעדכן אליה" ;;
  missing) fail "למנוע $tag אין migration של org.yaml מ-$from ל-$to" ;;
  migrate)
    branch="engine-update/org-v$to"
    git -C "$CHOME" rev-parse --git-dir >/dev/null 2>&1 || fail "החברה ב-$CHOME היא לא repo של git: אין איך לפתוח את שינוי ה-org.yaml כ-PR"
    pr=""
    if git -C "$CHOME" remote get-url origin >/dev/null 2>&1 && command -v gh >/dev/null; then
      pr="$(cd "$CHOME" && gh pr list --head "$branch" --state open --json url --jq '.[0].url' 2>/dev/null || true)"
    fi
    if [[ -z "$pr" ]] && ! git -C "$CHOME" rev-parse -q --verify "refs/heads/$branch" >/dev/null; then
      # A detached worktree of its own: hq keeps reading main while the change waits for review, and the branch is
      # made only from a commit that has the change (a failure leaves nothing behind).
      wt="$(mktemp -d)"
      git -C "$CHOME" worktree add -q --detach "$wt" HEAD
      made=0
      if node "$new/scripts/engine.mjs" org-migrate "$wt" >"$USTATE/org-migration.md" \
        && git -C "$wt" commit -q -am "org.yaml: פורמט $to, לעדכון המנוע ל-$tag"; then
        git -C "$CHOME" branch "$branch" "$(git -C "$wt" rev-parse HEAD)" && made=1
      fi
      git -C "$CHOME" worktree remove --force "$wt" || true
      ((made)) || fail "לא הצלחתי להכין את שינוי ה-org.yaml ($USTATE/org-migration.md)"
    fi
    if [[ -z "$pr" ]] && git -C "$CHOME" remote get-url origin >/dev/null 2>&1 && command -v gh >/dev/null; then
      git -C "$CHOME" push -q -u origin "$branch" || fail "push של $branch ל-repo של החברה נכשל"
      [[ -s "$USTATE/org-migration.md" ]] || echo "עדכון המנוע ל-$tag דורש את org.yaml בפורמט $to. נפתח על ידי \`company update\`." >"$USTATE/org-migration.md"
      pr="$(cd "$CHOME" && gh pr create --head "$branch" --base "$(git rev-parse --abbrev-ref HEAD)" \
        --title "org.yaml בפורמט $to (עדכון מנוע ל-$tag)" --body-file "$USTATE/org-migration.md")" \
        || fail "פתיחת ה-PR של org.yaml נכשלה (הענף $branch נדחף)"
    fi
    if [[ -n "$pr" ]]; then say "השינוי ב-org.yaml (פורמט $from ל-$to) מחכה לסקירה: $pr"
    else say "השינוי ב-org.yaml (פורמט $from ל-$to) בענף $branch ב-$CHOME. אחרי מיזוג שלו ל-main"; fi
    say "אחרי המיזוג: company update $tag"
    trap - ERR
    finish 3
    exit 3
    ;;
  *) fail "תשובה לא צפויה מ-org-plan: $action" ;;
esac
node "$new/scripts/check-contract.mjs" "$CHOME" >"$USTATE/last-check.txt" 2>&1 || fail "company check של $tag על $CHOME נכשל ($USTATE/last-check.txt)"
say "company check של $tag עבר על $CHOME"

# ── hq.db: a backup, and the new migrations on a copy ────────────────────────
step "hq.db"
if [[ -f "$STATE/hq.db" ]]; then
  install -d -m700 "$STATE/backups"
  backup="$STATE/backups/hq-before-$tag-$(date -u +%Y%m%dT%H%M%SZ).db"
  node "$new/scripts/engine.mjs" db-backup "$STATE/hq.db" "$backup" || fail "גיבוי hq.db נכשל"
  dry="$(mktemp -d)"
  cp "$backup" "$dry/hq.db"
  schema="$(node "$new/scripts/engine.mjs" db-migrate-dry "$dry/hq.db")" || { rm -rf "$dry"; fail "ה-migrations של $tag נכשלו על עותק של hq.db"; }
  rm -rf "$dry"
  read -r s_from s_to <<<"$schema"
  if [[ "$s_from" == "$s_to" ]]; then say "hq.db: סכמה $s_from, אין migrations חדשות"
  else say "hq.db: migrations $s_from→$s_to עברו על עותק; hq ירוץ אותן כשיעלה. גיבוי: $backup"; fi
else
  say "אין עדיין hq.db: hq ייצור אותו"
fi

# ── Claude Code: the version this engine is pinned to ───────────────────────
step "Claude Code"
pin="$(node "$new/scripts/engine.mjs" pinned-claude)" || fail "לא הצלחתי לקרוא את גרסת Claude Code של $tag"
claude_prev="$(readlink "$DATA/claude/current" 2>/dev/null || true)"
if [[ "$claude_prev" == "$pin" ]]; then
  say "Claude Code $pin, כמו קודם"
else
  claude_changed=1
  "$new/scripts/install-claude.sh" "$pin" --activate >"$USTATE/last-claude.txt" 2>&1 || fail "התקנת Claude Code $pin נכשלה ($USTATE/last-claude.txt)"
  say "Claude Code ${claude_prev:-(אין)}→$pin, ה-canary עבר"
fi

# ── switch, safe restart, verify ────────────────────────────────────────────
step "החלפה"
ln -sfn "$tag" "$ENGINES/.current.new"
mv -T "$ENGINES/.current.new" "$ENGINES/current"
switched=1
systemctl --user daemon-reload
hq_restarted=1
# The new engine's lib, not the one sourced from the running (previous) engine at the top (#209).
source "$ENGINES/current/scripts/lib/hq-restart.sh"
hq_safe_restart || fail "$HQ_RESTART_MSG"
say "hq הופעל מחדש על $tag; $HQ_RESTART_MSG"
# The installer's web unit (Caddy for the app) serves from engine/current too; try-restart: nothing when there is none.
systemctl --user try-restart agent-company-web.service || fail "agent-company-web לא עלה מחדש"

step "אימות מקצה לקצה"
if COMPANY_STATE="$STATE" node "$new/scripts/verify-prod.mjs" | tee "$USTATE/last-verify.txt"; then
  say "אימות מקצה לקצה: $(tail -1 "$USTATE/last-verify.txt")"
else
  fail "אימות מקצה לקצה: $(grep -c '^✗' "$USTATE/last-verify.txt" || true) בדיקות נכשלו ($USTATE/last-verify.txt)"
fi
trap - ERR

# ── leftovers, only once the new engine is verified ──────────────────────────
# A version retired at time R (it stopped being current) goes once every live shift started after R; a version that
# never was current (an update that failed before the switch) never ran. The live one and the previous stay.
# Only `company update` moves current (the installer leaves an existing one alone), so only it writes .retired-at.
date +%s >"$ENGINES/$cur/.retired-at"
oldest=""
while read -r u; do
  [[ -n "$u" ]] || continue
  # --timestamp=unix: "@<epoch>". The default format ends in a local zone abbreviation (IDT, CST) that date -d misreads.
  ts="$(systemctl --user show --timestamp=unix -p ActiveEnterTimestamp --value "$u" 2>/dev/null || true)"
  t=0
  if [[ "$ts" =~ ^@([0-9]+)$ ]]; then t="${BASH_REMATCH[1]}"; fi
  if [[ -z "$oldest" ]] || ((t < oldest)); then oldest=$t; fi
done < <(active_shifts || echo unknown)
while read -r d; do
  n="$(basename "$d")"
  if [[ "$n" == "$tag" || "$n" == "$cur" ]]; then continue; fi
  if [[ -f "$d/.retired-at" ]]; then
    r="$(cat "$d/.retired-at" 2>/dev/null || echo)"
    [[ "$r" =~ ^[0-9]+$ ]] || continue
    if [[ -n "$oldest" ]] && ((oldest <= r)); then continue; fi
  fi
  rm -rf -- "$d" && say "נמחקה גרסה ישנה: $n"
done < <(find "$ENGINES" -mindepth 1 -maxdepth 1 -type d ! -name '.*')
finish 0
