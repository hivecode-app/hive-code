# The safe restart of hq, shared by scripts/deploy.sh (hq-host) and scripts/company-update.sh (every install), so
# both put a new hq live the same way. Shifts are their own units (company-shift@), outside hq's cgroup: a restart of
# hq must leave every one of them running. Sourced; every command in here is guarded, so it is safe under `set -Eeuo
# pipefail` with an ERR trap.
HQ_HEALTH_URL="${HQ_HEALTH_URL:-http://127.0.0.1:7420/health}"
# Where this copy of the lib lives, so engine.mjs is the one of the same tree. A caller that sources it before the
# checkout of the new version (scripts/deploy.sh) must source it again after, or the old copy runs (#209).
_HQ_RESTART_ENGINE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/engine.mjs"

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

# The active shift units that hq itself ended on purpose after event seq $1 (it put them to rest under pressure, closed
# the task...), one per line, sorted. These left the active list because of the new hq doing its job, not because the
# restart killed them. Empty when the db cannot be read (said in the message when a unit then fails): a missing unit
# still fails, as before.
rested_shifts() {
  { node "$_HQ_RESTART_ENGINE" shifts-rested "${COMPANY_STATE:-$HOME/.local/state/agent-company}/hq.db" "${1:-0}" 2>/dev/null || true; } | sort
}

# Restarts hq, waits for /health, and checks that no shift unit went down. HQ_RESTART_MSG: one Hebrew line, what
# happened. Returns 1 when hq did not answer, 2 when shifts fell, 3 when the shift units could not be read (before the
# restart: hq was not restarted).
hq_safe_restart() {
  local before after gone rested seq live_before live_after
  if ! before="$(active_shifts)"; then
    HQ_RESTART_MSG="לא הצלחתי לקרוא את יחידות המשמרות לפני ה-restart (systemctl --user list-units)"
    return 3
  fi
  live_before="$(live_shifts)"
  seq="$(node "$_HQ_RESTART_ENGINE" events-seq "${COMPANY_STATE:-$HOME/.local/state/agent-company}/hq.db" 2>/dev/null || true)"
  [[ "$seq" =~ ^[0-9]+$ ]] || seq=0
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
    # Rested or closed by hq with a recorded reason after the restart: not a fall. Only a unit that vanished without
    # such a record (a crash) fails the deploy.
    rested="$(rested_shifts "$seq")"
    gone="$(comm -23 <(echo "$gone") <(echo "$rested") | grep . || true)"
  fi
  if [[ -n "$gone" ]]; then
    HQ_RESTART_MSG="משמרות נפלו ב-restart: $(echo "$gone" | tr '\n' ' ')"
    [[ -f "${COMPANY_STATE:-$HOME/.local/state/agent-company}/hq.db" ]] || HQ_RESTART_MSG+=" (אין hq.db לבדוק בו אם hq העביר אותן למנוחה)"
    return 2
  fi
  live_after="$(live_shifts)"
  HQ_RESTART_MSG="$(echo "$after" | grep -c . || true) יחידות משמרת נשארו פעילות (live לפני/אחרי: $live_before/$live_after)"
  return 0
}
