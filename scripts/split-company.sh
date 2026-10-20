#!/usr/bin/env bash
# The company leaves the engine repo (docs/generic/PLAN.md §1 step 3; the order: docs/generic/split-runbook.md).
# company/ and memory/ go, with their history (git filter-repo), to a private repo of their own, cloned at COMPANY_HOME.
#
#   scripts/split-company.sh --dry-run    everything up to the GitHub repo, in a temp dir: what would go, the contract
#                                         check on it. Creates nothing on GitHub and touches no checkout.
#   scripts/split-company.sh              the same, then creates the repo, pushes, and clones it to COMPANY_HOME.
#
# Options: --repo owner/name (default hive-owner/my-company) · --home DIR (default ~/company) ·
#          --engine DIR (the engine checkout to split from, default this one; it is cloned from its origin, so the
#          split starts from origin/main and not from local state).
# Does not deploy and does not change hq.config.json in the state dir: that is `scripts/deploy.sh hq` (runbook).
set -Eeuo pipefail

DRY=0
REPO=hive-owner/my-company
CHOME="$HOME/company"
ENGINE="$(cd "$(dirname "$0")/.." && pwd -P)"
while (($#)); do
  case "$1" in
    --dry-run) DRY=1 ;;
    --repo) REPO="${2:?}"; shift ;;
    --home) CHOME="${2:?}"; shift ;;
    --engine) ENGINE="$(cd "${2:?}" && pwd -P)"; shift ;;
    *) echo "usage: scripts/split-company.sh [--dry-run] [--repo owner/name] [--home DIR] [--engine DIR]" >&2; exit 2 ;;
  esac
  shift
done
case "$CHOME" in /*) ;; *) CHOME="$(pwd -P)/$CHOME" ;; esac
CHOME="${CHOME%/}"
HERE="$(cd "$(dirname "$0")" && pwd -P)"
export PATH="$PATH:$HOME/.local/bin"   # pipx installs git-filter-repo there

say() { echo "• $1"; }
die() { echo "✗ $1" >&2; exit 1; }

# ── preflight ────────────────────────────────────────────────────────────────
git filter-repo --version >/dev/null 2>&1 || die "אין git-filter-repo. התקנה: pipx install git-filter-repo (או apt install git-filter-repo)"
url="$(git -C "$ENGINE" remote get-url origin)" || die "ל-$ENGINE אין origin"
slug="$(sed -E 's#^(https://github\.com/|git@github\.com:)##; s#\.git$##' <<<"$url")"
[[ "$slug" =~ ^[^/]+/[^/]+$ ]] || die "origin של $ENGINE ($url) הוא לא repo ב-GitHub"
[[ "$slug" != "$REPO" ]] || die "--repo הוא ה-repo של המנוע עצמו"
if [[ -e "$CHOME" ]] && [[ -n "$(ls -A "$CHOME" 2>/dev/null)" ]]; then die "$CHOME כבר קיים ולא ריק"; fi
if gh repo view "$REPO" >/dev/null 2>&1; then
  ((DRY)) && say "אזהרה: $REPO כבר קיים ב-GitHub (בלי --dry-run זו עצירה)" || die "$REPO כבר קיים ב-GitHub"
fi
# A rolling memory PR still open on the engine holds updates that would stay behind (packages/hq/src/memory-files.ts).
open_pr="$(gh pr list -R "$slug" --head company/memory-updates --state open --json url --jq '.[0].url' 2>/dev/null || true)"
[[ -z "$open_pr" ]] || say "אזהרה: PR הזיכרון המאוחד עוד פתוח ($open_pr). למזג או לסגור אותו לפני הפיצול, אחרת העדכונים בו נשארים מאחור"

work="$(mktemp -d "${TMPDIR:-/tmp}/split-company.XXXXXX")"
src="$work/company"

# ── the split ────────────────────────────────────────────────────────────────
step() { echo; echo "── $1"; }
step "clone של $slug (origin/main)"
git clone -q --no-local --branch main --single-branch "$url" "$src"
from="$(git -C "$src" rev-parse HEAD)"
say "מ-${from:0:7}: $(git -C "$src" log -1 --format=%s)"

step "git filter-repo: company/ ו-memory/ עם ההיסטוריה שלהם"
(cd "$src" && git filter-repo --quiet --path company/ --path memory/)
say "$(git -C "$src" rev-list --count HEAD) קומיטים, $(git -C "$src" ls-files | wc -l) קבצים"
# Nothing of the engine may come along (filter-repo keeps only these paths, so this only guards the script itself).
other="$(git -C "$src" ls-files | grep -Ev '^(company|memory)/' || true)"
[[ -z "$other" ]] || die "בתוצאה יש קבצים מחוץ ל-company/ ו-memory/: $(head -3 <<<"$other" | tr '\n' ' ')"

step "התאמות: companyHome ב-hq.config.json, וקישורים למנוע"
cfg="$src/company/hq.config.json"
if [[ -f "$cfg" ]]; then
  # The company says where it lives: deploy.sh installs this file as hq.config.json, and from then on hq, the shifts
  # and the scripts resolve COMPANY_HOME from it (packages/shared/src/company-home.ts).
  node -e '
    const fs = require("fs"); const [file, home] = process.argv.slice(1);
    const text = fs.readFileSync(file, "utf8"); JSON.parse(text);
    if (/"companyHome"\s*:/.test(text)) throw new Error("companyHome is already set in " + file);
    const out = text.replace(/^\{\s*\n/, `{\n  "companyHome": ${JSON.stringify(home)},\n`);
    if (out === text) throw new Error("unexpected format: " + file);
    JSON.parse(out); fs.writeFileSync(file, out);' "$cfg" "$CHOME"
  say "company/hq.config.json: \"companyHome\": \"$CHOME\""
else
  say "אזהרה: אין company/hq.config.json. בלי companyHome בו, צריך להגדיר COMPANY_HOME ב-hq.config.json ידנית"
fi
node "$HERE/split-links.mjs" "$src" "$ENGINE" "$slug" | sed 's/^/  /'
git -C "$src" add -A
git -C "$src" -c core.hooksPath=/dev/null commit -q -m "החברה ב-COMPANY_HOME: companyHome ב-hq.config.json, וקישורים למנוע

פוצל מ-$slug@${from:0:12} (scripts/split-company.sh)." || say "אין מה להתאים"

step "check:contract על התוצאה"
node "$HERE/check-contract.mjs" "$src" || die "check:contract נכשל על התוצאה ($src)"

if ((DRY)); then
  echo
  echo "dry-run: שום דבר לא נוצר ב-GitHub ושום checkout לא השתנה. התוצאה לבדיקה: $src"
  echo "בלי --dry-run: gh repo create $REPO --private, push, ו-clone ל-$CHOME."
  exit 0
fi

# ── GitHub and COMPANY_HOME ──────────────────────────────────────────────────
step "בדיקה שלא נכנס כלום ל-company/ או memory/ במנוע מאז ${from:0:7}"
git -C "$ENGINE" fetch -q origin main
if ! git -C "$ENGINE" diff --quiet "$from" origin/main -- company memory; then
  die "בזמן הפיצול נכנסו שינויים ל-company/ או memory/ ב-$slug. להריץ שוב (ולכבות קודם את memory-files בלוח, ראו split-runbook)"
fi

step "repo פרטי: $REPO"
gh repo create "$REPO" --private --description "החברה: החוזה (company/) והזיכרון (memory/), מ-$slug" >/dev/null
git -C "$src" remote add origin "https://github.com/$REPO.git"
git -C "$src" push -q -u origin main
say "נדחף: $(git -C "$src" rev-parse --short HEAD)"

step "clone ל-$CHOME"
gh repo clone "$REPO" "$CHOME" -- -q
say "COMPANY_HOME מוכן: $CHOME ($(git -C "$CHOME" rev-parse --short HEAD))"
rm -rf "$work"

echo
echo "הפיצול גמור. הלאה, לפי docs/generic/split-runbook.md: פריסה עם COMPANY_HOME=$CHOME, verify-prod, ורק אחרי זה PR שמוחק את company/ ו-memory/ מהמנוע."
