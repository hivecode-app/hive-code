# Installs one engine version into <engines>/<name>, the layout scripts/install.sh and `company update` share
# (docs/generic/PLAN.md §5): a tree without .git (`git archive` of the commit), `.engine-version` = "<name> <sha> <repo>",
# `npm ci --omit=dev`, then `.install-ok`. Built in .<name>.partial and moved into place only at the end, so a half
# install never has the final name. <name> is the tag, or the first 12 characters of the sha for a branch or a commit.
# Sourced. engine_install <repo-url> <ref> <engines-dir>; sets ENGINE_NAME; returns 1 (ENGINE_ERR says why) on failure.
# Leaves engine/current alone: switching is the caller's.
engine_install() {
  local url=$1 ref=$2 engines=$3 tmp sha name partial
  ENGINE_NAME=""; ENGINE_ERR=""
  tmp="$(mktemp -d)"
  if ! git clone -q --depth 1 -c advice.detachedHead=false --branch "$ref" "$url" "$tmp/src" 2>/dev/null; then
    rm -rf "$tmp/src"
    if ! git clone -q "$url" "$tmp/src" 2>/dev/null || ! git -C "$tmp/src" checkout -q --detach "$ref" 2>/dev/null; then
      rm -rf "$tmp"; ENGINE_ERR="אין $ref ב-$url"; return 1
    fi
  fi
  sha="$(git -C "$tmp/src" rev-parse HEAD)"
  if git -C "$tmp/src" tag --points-at HEAD | grep -qxF -- "$ref"; then name="$ref"; else name="${sha:0:12}"; fi
  if [[ -f "$engines/$name/.install-ok" ]]; then rm -rf "$tmp"; ENGINE_NAME="$name"; return 0; fi
  partial="$engines/.$name.partial"
  mkdir -p "$engines"
  rm -rf "$partial"
  mkdir "$partial"
  if ! git -C "$tmp/src" archive HEAD | tar -x -C "$partial"; then rm -rf "$tmp" "$partial"; ENGINE_ERR="git archive של $ref נכשל"; return 1; fi
  rm -rf "$tmp"
  # Every step checked by hand: the caller runs this in `|| fail`, where set -e is off.
  if ! echo "$name $sha $url" >"$partial/.engine-version"; then rm -rf "$partial"; ENGINE_ERR="לא הצלחתי לכתוב ב-$partial"; return 1; fi
  if ! (cd "$partial" && npm ci --omit=dev --no-audit --no-fund >/dev/null); then rm -rf "$partial"; ENGINE_ERR="npm ci ב-$name נכשל"; return 1; fi
  if ! date -u +%FT%TZ >"$partial/.install-ok" || ! rm -rf "${engines:?}/$name" || ! mv -T "$partial" "$engines/$name"; then
    rm -rf "$partial"; ENGINE_ERR="לא הצלחתי להעביר את $name למקומו ב-$engines"; return 1
  fi
  ENGINE_NAME="$name"
}

# The repo an installed engine came from, as a URL git can clone: the third field of .engine-version ("owner/name" is
# GitHub, accepted for hand-written files; the installer writes a URL or a local path), else its git origin (an engine
# that is a checkout).
engine_origin() {
  local dir=$1 repo=""
  if [[ -f "$dir/.engine-version" ]]; then read -r _ _ repo <"$dir/.engine-version" || true; fi
  if [[ -z "$repo" ]]; then repo="$(git -C "$dir" remote get-url origin 2>/dev/null || true)"; fi
  if [[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then repo="https://github.com/$repo.git"; fi
  echo "$repo"
}
