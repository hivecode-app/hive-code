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
