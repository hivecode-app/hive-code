#!/usr/bin/env bash
# Repos on a node at the commit they are on here: the nested repos of a project's checkout (lumo's server/ and
# reference/*, which its worktrees link to) and the node's mirrors (~/projects/whatsmeow). Runs there, from stdin:
#   bash -s -- <own 0|1> [<path> <owner/name> <sha>]... < scripts/repo-sync.sh
# node-install.sh runs it, and hq right after it makes a task's worktree on a node (nodes.ts RemoteWorkspaces.create).
# - Missing: cloned (from GitHub; REPO_SYNC_BASE in tests), and marked as node-install's (.git/agent-company-node).
# - Ours (marked, or any repo on a node with no user of its own, own=0): detached on the commit.
# - Its user's (own=1, no mark): only fast-forwarded along its branch's upstream, as the `git pull --ff-only` it has
#   had so far. One already past
#   ours is left (ahead: it has all of it); one that went another way stays where it is.
# - Tracked changes: nothing moves. No lock: two runs at once on one repo, one may say "stays" (git's index.lock); a
#   repo the worktrees share (server/) moves under a task already running there, as it does on hq-host. One line per repo, "<path> ok|moved|ahead|stays <why>"; exit 0 (a repo left behind is
#   said, it does not stop the task).
main() {
  exec </dev/null
  local own="$1"; shift
  while (($# >= 3)); do sync_one "$own" "$1" "$2" "$3"; shift 3; done
}

sync_one() {
  local own="$1" p="$2" r="$3" sha="$4" head branch
  if [[ ! -d "$p/.git" ]]; then
    git clone --quiet "${REPO_SYNC_BASE:-https://github.com}/$r" "$p" 2>/dev/null || { echo "$p stays: clone of $r failed"; return; }
    touch "$p/.git/agent-company-node"
  fi
  head="$(git -C "$p" rev-parse HEAD 2>/dev/null)"
  [[ "$head" == "$sha" ]] && { echo "$p ok ${sha:0:9}"; return; }
  if ! git -C "$p" cat-file -e "$sha^{commit}" 2>/dev/null; then
    git -C "$p" fetch --quiet origin 2>/dev/null
    git -C "$p" cat-file -e "$sha^{commit}" 2>/dev/null || git -C "$p" fetch --quiet origin "$sha" 2>/dev/null
    git -C "$p" cat-file -e "$sha^{commit}" 2>/dev/null || { echo "$p stays: ${sha:0:9} is not in origin ($r)"; return; }
  fi
  [[ -z "$(git -C "$p" status --porcelain --untracked-files=no 2>/dev/null)" ]] || { echo "$p stays: changes there"; return; }
  if [[ "$own" == 0 || -e "$p/.git/agent-company-node" ]]; then
    git -C "$p" checkout --quiet --detach "$sha" 2>/dev/null || { echo "$p stays: checkout ${sha:0:9} failed"; return; }
  elif git -C "$p" merge-base --is-ancestor "$sha" "$head" 2>/dev/null; then
    echo "$p ahead ${head:0:9}, past ${sha:0:9} (its user's)"; return
  elif ! git -C "$p" merge-base --is-ancestor "$head" "$sha" 2>/dev/null; then
    echo "$p stays: ${head:0:9} there is not an ancestor of ${sha:0:9} (its user's)"; return
  elif branch="$(git -C "$p" symbolic-ref -q --short HEAD)"; then
    # Only along its branch's own upstream, as `pull` would: a feature branch is not moved to main's commit.
    git -C "$p" merge-base --is-ancestor "$sha" "$branch@{u}" 2>/dev/null \
      || { echo "$p stays: ${sha:0:9} is not on the upstream of $branch (its user's)"; return; }
    git -C "$p" merge --quiet --ff-only "$sha" 2>/dev/null || { echo "$p stays: fast-forward of $branch failed"; return; }
  else
    git -C "$p" checkout --quiet --detach "$sha" 2>/dev/null || { echo "$p stays: checkout ${sha:0:9} failed"; return; }
  fi
  echo "$p moved ${head:0:9} → ${sha:0:9}"
}

main "$@"
