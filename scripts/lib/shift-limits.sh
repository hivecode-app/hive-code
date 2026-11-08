# Sourced by scripts/deploy.sh hq (task 1547). Brings the processes of the shifts already running to the template's Nice and
# OOMScoreAdjust (packages/shift-host/systemd/company-shift@.service): systemd sets both when a process starts, so a shift
# that began before the template changed keeps the old ones until it ends. Only up: a user may raise both, never lower.
# $1: the units, `company-shift@*` by default. Prints one line for deploy.sh.
shift_limits_live() {
  local tpl="${SHIFT_TEMPLATE:-$HOME/projects/agent-company/packages/shift-host/systemd/company-shift@.service}"
  local nice adj u cg pid n=0 fixed=0
  nice="$(sed -n 's/^Nice=//p' "$tpl" | tail -1)"
  adj="$(sed -n 's/^OOMScoreAdjust=//p' "$tpl" | tail -1)"
  [[ -n "$nice" && -n "$adj" ]] || { echo "shift-limits: אין Nice או OOMScoreAdjust ב-$tpl"; return 0; }
  for u in $(systemctl --user list-units "${1:-company-shift@*}" --state=active --no-legend --plain 2>/dev/null | awk '{print $1}'); do
    cg="$(systemctl --user show "$u" -p ControlGroup --value 2>/dev/null)"
    [[ -n "$cg" && -d "/sys/fs/cgroup$cg" ]] || continue
    n=$((n + 1))
    local hit=0
    while read -r pid; do
      [[ -n "$pid" ]] || continue
      if (( $(cat "/proc/$pid/oom_score_adj" 2>/dev/null || echo "$adj") < adj )); then echo "$adj" >"/proc/$pid/oom_score_adj" 2>/dev/null && hit=1; fi
      if (( $(ps -o ni= -p "$pid" 2>/dev/null || echo "$nice") < nice )); then renice -n "$nice" -p "$pid" >/dev/null 2>&1 && hit=1; fi
    done < <(find "/sys/fs/cgroup$cg" -name cgroup.procs -exec cat {} + 2>/dev/null)
    fixed=$((fixed + hit))
  done
  echo "משמרות חיות: $n, תוקנו ל-Nice=$nice ו-OOMScoreAdjust=$adj: $fixed"
}
