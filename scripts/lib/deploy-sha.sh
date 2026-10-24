# Which commit scripts/deploy.sh puts live, and moving the checkout there. Sourced by deploy.sh (and its test,
# scripts/deploy-sha.test.mjs). A deploy is origin/main by default; `--sha <sha>` (or DEPLOY_SHA) deploys a commit in
# the middle of the range instead, so the PRs that got a GO go live without the ones after them that did not (22/10:
# #186 with GO, #188 without, #191 with). Fast-forward only: the commit is on origin/main and the checkout is at or
# before it. A later plain deploy continues from there.
#
# deploy_sha_move <want or empty>: run in the checkout, after `git fetch origin main`. Sets DEPLOY_PREV (HEAD before),
# DEPLOY_SHA_TO (HEAD after) and DEPLOY_MOVED (1 when HEAD moved). On a refusal: DEPLOY_SHA_ERR (one Hebrew line),
# returns 1 and moves nothing. Every command is guarded, so it is safe under `set -Eeuo pipefail` with an ERR trap.
deploy_sha_move() {
  local want="${1:-}" target main
  DEPLOY_SHA_ERR=""; DEPLOY_MOVED=0
  DEPLOY_PREV="$(git rev-parse HEAD)"
  main="$(git rev-parse origin/main)"
  if [[ -z "$want" ]]; then
    target="$main"
  else
    target="$(git rev-parse -q --verify "$want^{commit}" 2>/dev/null)" \
      || { DEPLOY_SHA_ERR="אין commit יחיד בשם $want (לא קיים, או sha קצר מדי ודו-משמעי)"; return 1; }
    git merge-base --is-ancestor "$target" "$main" \
      || { DEPLOY_SHA_ERR="${target:0:7} לא נמצא ב-origin/main: פורסים רק מה שמוזג"; return 1; }
  fi
  if [[ "$DEPLOY_PREV" != "$target" ]]; then
    if ! git merge-base --is-ancestor "$DEPLOY_PREV" "$target"; then
      if [[ -z "$want" ]]; then DEPLOY_SHA_ERR="main המקומי התפצל מ-origin/main"
      elif git merge-base --is-ancestor "$target" "$DEPLOY_PREV"; then DEPLOY_SHA_ERR="${target:0:7} לפני מה שכבר בפרודקשן (${DEPLOY_PREV:0:7}): פריסה לא חוזרת אחורה"
      else DEPLOY_SHA_ERR="ה-checkout (${DEPLOY_PREV:0:7}) לא אב של ${target:0:7}"; fi
      return 1
    fi
    git merge -q --ff-only "$target" || { DEPLOY_SHA_ERR="git merge --ff-only ${target:0:7} נכשל"; return 1; }
    DEPLOY_MOVED=1
  fi
  DEPLOY_SHA_TO="$(git rev-parse HEAD)"
}

# deploy_move_or_reexec <script> [args...]: deploy_sha_move (with $want_sha), and when the move brought a new
# scripts/deploy.sh or scripts/lib/, run that version instead of this one (#209). bash reads a script as it goes, so
# after the checkout moves the old copy would go on with the old steps (22/10: it linked a unit the new commit had
# removed, and the deploy rolled back). The new run gets DEPLOY_PREV/DEPLOY_SHA_TO/DEPLOY_MOVED in its environment
# and does not move again; it also inherits the lock (fd 9, which deploy.sh then does not reopen). DEPLOY_REEXEC=1 marks that run, so it cannot loop.
# Returns 1 with DEPLOY_SHA_ERR on a refusal, like deploy_sha_move.
deploy_move_or_reexec() {
  local script="$1"; shift
  if [[ "${DEPLOY_REEXEC:-}" == 1 ]]; then
    DEPLOY_SHA_ERR=""
    if [[ -z "${DEPLOY_PREV:-}" || "${DEPLOY_SHA_TO:-}" != "$(git rev-parse HEAD)" ]]; then
      DEPLOY_SHA_ERR="הרצה חוזרת (DEPLOY_REEXEC) בלי DEPLOY_PREV/DEPLOY_SHA_TO שמתאימים ל-HEAD"
      return 1
    fi
    # Values for this run only: the checks and builds it starts are not re-execs.
    export -n DEPLOY_REEXEC DEPLOY_PREV DEPLOY_SHA_TO DEPLOY_MOVED
    return 0
  fi
  deploy_sha_move "${want_sha:-}" || return 1
  local rc=0
  git diff --quiet "$DEPLOY_PREV" "$DEPLOY_SHA_TO" -- scripts/deploy.sh scripts/lib || rc=$?
  # 1 is "changed"; anything else is git failing, and then the new copy is the safe side.
  ((rc <= 1)) || echo "git diff על הסקריפטים נכשל (קוד $rc): ממשיך עם הגרסה החדשה ליתר ביטחון" >&2
  if ((rc != 0)); then
    echo "scripts/deploy.sh או scripts/lib השתנו בטווח: ממשיך עם הגרסה של ${DEPLOY_SHA_TO:0:7}"
    export DEPLOY_REEXEC=1 DEPLOY_PREV DEPLOY_SHA_TO DEPLOY_MOVED
    exec bash "$script" "$@"
  fi
}
