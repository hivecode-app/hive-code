# The safe restart of hq, shared by scripts/deploy.sh (hq-host) and scripts/company-update.sh (every install), so
# both put a new hq live the same way. Shifts are their own units (company-shift@), outside hq's cgroup: a restart of
# hq must leave every one of them running. Sourced; every command in here is guarded, so it is safe under `set -Eeuo
# pipefail` with an ERR trap.
HQ_HEALTH_URL="${HQ_HEALTH_URL:-http://127.0.0.1:7420/health}"

# /health answers 200 within a minute.
wait_health() {
  local _
  for _ in $(seq 1 "${HQ_HEALTH_TRIES:-60}"); do
    [[ "$(curl -s -o /dev/null -w '%{http_code}' "$HQ_HEALTH_URL" || true)" == 200 ]] && return 0
    sleep 1
  done
  return 1
}

# The active shift units, one per line, sorted. Fails when systemd cannot be asked: then nobody can say they survived.
active_shifts() {
  local out
  out="$(systemctl --user list-units 'company-shift@*' --state=active --plain --no-legend)" || return 1
  awk '{print $1}' <<<"$out" | sort
}

# live_shifts from /health, or "?".
live_shifts() {
  { curl -s "$HQ_HEALTH_URL" || true; } | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).live_shifts)}catch{console.log("?")}})'
}

# Restarts hq, waits for /health, and checks that no shift unit went down. HQ_RESTART_MSG: one Hebrew line, what
# happened. Returns 1 when hq did not answer, 2 when shifts fell, 3 when the shift units could not be read (before the
# restart: hq was not restarted).
hq_safe_restart() {
  local before after gone live_before live_after
  if ! before="$(active_shifts)"; then
    HQ_RESTART_MSG="לא הצלחתי לקרוא את יחידות המשמרות לפני ה-restart (systemctl --user list-units)"
    return 3
  fi
  live_before="$(live_shifts)"
  if ! systemctl --user restart agent-company-hq || ! wait_health; then
    HQ_RESTART_MSG="hq לא עונה ב-/health דקה אחרי restart"
    return 1
  fi
  if ! after="$(active_shifts)"; then
    HQ_RESTART_MSG="לא הצלחתי לקרוא את יחידות המשמרות אחרי ה-restart (systemctl --user list-units)"
    return 3
  fi
  gone="$(comm -23 <(echo "$before") <(echo "$after") | grep . || true)"
  if [[ -n "$gone" ]]; then
    HQ_RESTART_MSG="משמרות נפלו ב-restart: $(echo "$gone" | tr '\n' ' ')"
    return 2
  fi
  live_after="$(live_shifts)"
  HQ_RESTART_MSG="$(echo "$after" | grep -c . || true) יחידות משמרת נשארו פעילות (live לפני/אחרי: $live_before/$live_after)"
  return 0
}
