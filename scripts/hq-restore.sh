#!/usr/bin/env bash
# Puts a backup of hq.db live (docs/RUNBOOK.md, "שחזור hq.db"):
#   scripts/hq-restore.sh ~/.local/state/agent-company/backups/hq-2026-10-25T101046Z.db.zst
# Restores it to a new file and checks it (main.ts restore) while hq still runs, then stops hq, moves the current
# hq.db (with its -wal/-shm) aside to hq.db.before-restore-<stamp>, puts the restored one in its place and starts hq
# again (scripts/lib/hq-restart.sh). Shifts are their own units and keep running. Nothing is deleted.
set -Eeuo pipefail
src="${1:?usage: scripts/hq-restore.sh <backup.db.zst|backup.db>}"
[[ -f "$src" ]] || { echo "אין קובץ כזה: $src" >&2; exit 2; }
engine="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="${COMPANY_STATE:-$HOME/.local/state/agent-company}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
restored="$STATE/hq.db.restored-$stamp"
aside="$STATE/hq.db.before-restore-$stamp"

trap 'echo "השחזור נעצר באמצע (שורה $LINENO). ה-hq.db הקודם: $aside (אם הועבר), המשוחזר: $restored. hq: $(systemctl --user is-active agent-company-hq || true)" >&2' ERR
node "$engine/packages/hq/src/main.ts" restore "$src" "$restored" --state "$STATE"
systemctl --user stop agent-company-hq
for s in '' -wal -shm; do [[ -e "$STATE/hq.db$s" ]] && mv "$STATE/hq.db$s" "$aside$s"; done
mv "$restored" "$STATE/hq.db"
systemctl --user start agent-company-hq
# shellcheck source=lib/hq-restart.sh
source "$engine/scripts/lib/hq-restart.sh"
wait_health || { echo "hq לא עלה אחרי השחזור. ה-hq.db הקודם ב-$aside" >&2; exit 1; }
echo "שוחזר מ-$src. ה-hq.db הקודם נשמר ב-$aside"
