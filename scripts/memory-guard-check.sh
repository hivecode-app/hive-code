#!/usr/bin/env bash
# After `scripts/deploy.sh hq` (task 1547): what of hq's protection is really in force, read from the kernel, not from the units.
#   scripts/memory-guard-check.sh          hq's CPU weight and OOM score, the shifts' slice and each live shift
#   scripts/memory-guard-check.sh --hog    and the 07:12 case in small: a process in the shifts' slice that wants 800MB
#                                          under a 300M MemoryHigh, while hq's /health is timed every second
# Read-only, except --hog's own transient unit (stopped at the end, 40 seconds at most).
set -uo pipefail
CG=/sys/fs/cgroup
cg() { systemctl --user show "$1" -p ControlGroup --value 2>/dev/null; }
val() { cat "$CG$1/$2" 2>/dev/null || echo '?'; }

hq="$(cg agent-company-hq.service)"
pid="$(systemctl --user show agent-company-hq.service -p MainPID --value)"
echo "hq: cpu.weight=$(val "$hq" cpu.weight) (want 1000) · oom_score_adj=$(cat "/proc/$pid/oom_score_adj" 2>/dev/null || echo '?') (want 100)"
sl="$(cg app-shifts.slice)"
echo "app-shifts.slice: memory.high=$(val "$sl" memory.high) memory.max=$(val "$sl" memory.max) cpu.weight=$(val "$sl" cpu.weight)"
for u in $(systemctl --user list-units 'company-shift@*' --state=active --no-legend --plain | awk '{print $1}'); do
  c="$(cg "$u")"; p="$(systemctl --user show "$u" -p MainPID --value)"
  echo "  $u: slice=$(basename "$(dirname "$c")") memory.high=$(val "$c" memory.high) nice=$(ps -o ni= -p "$p" 2>/dev/null | tr -d ' ') oom=$(cat "/proc/$p/oom_score_adj" 2>/dev/null)"
done
echo "now: $(awk '/^MemAvailable/ {a=$2} /^SwapFree/ {s=$2} END {printf "available %.1fGB, swap free %dMB", a/1048576, s/1024}' /proc/meminfo) · memory PSI $(head -1 /proc/pressure/memory)"

[[ "${1:-}" == --hog ]] || exit 0
unit="memory-guard-hog-$$"
systemd-run --user -q --unit="$unit" --slice=app-shifts.slice -p MemoryHigh=300M -p MemoryMax=1G -p RuntimeMaxSec=40 \
  node -e 'const a=[];for(let i=0;i<80;i++)a.push(Buffer.alloc(10<<20,1));setTimeout(()=>{},5000)' || exit 1
hc="$(cg "$unit.service")"
for i in $(seq 1 10); do
  t="$( { /usr/bin/time -f %e curl -s -o /dev/null -m 10 http://127.0.0.1:7420/health; } 2>&1 )"
  echo "  ${i}s: hog $(( $(val "$hc" memory.current | tr -dc 0-9) / 1048576 ))MB of 800, throttled $(awk '$1=="high"{print $2}' "$CG$hc/memory.events" 2>/dev/null) times · hq /health ${t}s"
  sleep 1
done
systemctl --user stop "$unit" 2>/dev/null || true
