# Installs one engine version into <engines>/<name>, the layout scripts/install.sh and `company update` share
# (docs/generic/PLAN.md §5): a tree without .git, `.engine-version` = "<name> <sha> <repo>", web/ (the app for the web),
# apk/ (the APK for the in-app update, in a release), `npm ci --omit=dev`, then `.install-ok`. Built in .<name>.partial
# and moved into place only at the end, so a half install never has the final name. <name> is the tag, or the first
# 12 characters of the sha for a branch or a commit.
# Two sources:
#   - a release of a tag (scripts/release.sh): agent-company-<tag>.tar.gz and SHA256SUMS from the GitHub Release of the
#     repo, checked against each other; the tree, web/ and apk/ come from it. A checksum that does not match stops.
#   - otherwise (a repo with no release for the ref, not on GitHub, a branch): `git archive` of the commit, and web/ is a
#     short page that points to the Android app (scripts/lib/web-placeholder.html). A tag of a GitHub repo whose release
#     could not be downloaded is named by its sha, not by the tag: the name v<X.Y.Z> stays for the release itself, so a
#     later `company update v<X.Y.Z>` still brings the web app and the APK.
# Sourced. engine_install <repo-url> <ref> <engines-dir>; engine_install_tarball <file> <engines-dir> <repo-url>. Both
# set ENGINE_NAME, and return 1 (ENGINE_ERR says why) on failure. They leave engine/current alone: switching is the caller's.
engine_install() {
  local url=$1 ref=$2 engines=$3 tmp sha name partial
  ENGINE_NAME=""; ENGINE_ERR=""
  tmp="$(mktemp -d)"
  local github=0
  engine_github_slug "$url" >/dev/null && github=1
  if [[ "$ref" =~ ^v[0-9] ]] && engine_release_fetch "$url" "$ref" "$tmp"; then
    engine_install_tarball "$RELEASE_TARBALL" "$engines" "$url" "$ref"; local rc=$?
    rm -rf "$tmp"; return $rc
  fi
  if ! git clone -q --depth 1 -c advice.detachedHead=false --branch "$ref" "$url" "$tmp/src" 2>/dev/null; then
    rm -rf "$tmp/src"
    if ! git clone -q "$url" "$tmp/src" 2>/dev/null || ! git -C "$tmp/src" checkout -q --detach "$ref" 2>/dev/null; then
      rm -rf "$tmp"; ENGINE_ERR="אין $ref ב-$url"; return 1
    fi
  fi
  sha="$(git -C "$tmp/src" rev-parse HEAD)"
  if git -C "$tmp/src" tag --points-at HEAD | grep -qxF -- "$ref" && ! ((github)); then name="$ref"; else name="${sha:0:12}"; fi
  if ((github)) && [[ "$ref" =~ ^v[0-9] ]]; then
    echo "ל-$ref אין שחרור להורדה מ-$url: מותקן מהקוד בשם $name, בלי האפליקציה ל-web וה-APK." >&2
  fi
  if [[ -f "$engines/$name/.install-ok" ]]; then rm -rf "$tmp"; ENGINE_NAME="$name"; return 0; fi
  partial="$engines/.$name.partial"
  mkdir -p "$engines"
  rm -rf "$partial"
  mkdir "$partial"
  if ! git -C "$tmp/src" archive HEAD | tar -x -C "$partial"; then rm -rf "$tmp" "$partial"; ENGINE_ERR="git archive של $ref נכשל"; return 1; fi
  rm -rf "$tmp"
  engine_finish "$partial" "$name" "$sha" "$url" "$engines"
}

# A release tarball: checked against the SHA256SUMS next to it, unpacked, named by its .engine-release.
engine_install_tarball() {
  local file=$1 engines=$2 url=$3 expect=${4:-} base top partial name sha _rest
  ENGINE_NAME=""; ENGINE_ERR=""
  engine_tarball_verify "$file" || return 1
  base="$(basename "$file")"
  top="$(tar -tzf "$file" 2>/dev/null | cut -d/ -f1 | sort -u)"
  if [[ ! "$top" =~ ^agent-company-[A-Za-z0-9._-]+$ ]]; then ENGINE_ERR="$base אינו שחרור של המנוע (תיקייה עליונה: ${top:-אין})"; return 1; fi
  mkdir -p "$engines"
  partial="$(mktemp -d "$engines/.release.XXXXXX")"
  if ! tar -xzf "$file" -C "$partial" --strip-components=1 --no-same-owner; then rm -rf "$partial"; ENGINE_ERR="פריסת $base נכשלה"; return 1; fi
  read -r name sha _rest <"$partial/.engine-release" 2>/dev/null || true
  if [[ ! "$name" =~ ^v[0-9][A-Za-z0-9._-]*$ || ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then rm -rf "$partial"; ENGINE_ERR="ב-$base אין .engine-release תקין"; return 1; fi
  if [[ -n "$expect" && "$name" != "$expect" ]]; then rm -rf "$partial"; ENGINE_ERR="השחרור שהורד הוא $name, לא $expect"; return 1; fi
  if [[ -f "$engines/$name/.install-ok" ]]; then rm -rf "$partial"; ENGINE_NAME="$name"; return 0; fi
  rm -rf "$engines/.$name.partial"
  if ! mv -T "$partial" "$engines/.$name.partial"; then rm -rf "$partial"; ENGINE_ERR="לא הצלחתי לכתוב ב-$engines"; return 1; fi
  engine_finish "$engines/.$name.partial" "$name" "$sha" "$url" "$engines"
}

# The common end: web/ (a placeholder when the source has none), .engine-version, npm ci, .install-ok, the final name.
engine_finish() {
  local partial=$1 name=$2 sha=$3 url=$4 engines=$5
  # Every step checked by hand: the caller runs this in `|| fail`, where set -e is off.
  if [[ ! -f "$partial/web/index.html" && -f "$partial/scripts/lib/web-placeholder.html" ]] \
    && ! { mkdir -p "$partial/web" && cp "$partial/scripts/lib/web-placeholder.html" "$partial/web/index.html"; }; then
    rm -rf "$partial"; ENGINE_ERR="לא הצלחתי לכתוב ב-$partial"; return 1
  fi
  if ! echo "$name $sha $url" >"$partial/.engine-version"; then rm -rf "$partial"; ENGINE_ERR="לא הצלחתי לכתוב ב-$partial"; return 1; fi
  if ! (cd "$partial" && npm ci --omit=dev --no-audit --no-fund >/dev/null); then rm -rf "$partial"; ENGINE_ERR="npm ci ב-$name נכשל"; return 1; fi
  if ! date -u +%FT%TZ >"$partial/.install-ok" || ! rm -rf "${engines:?}/$name" || ! mv -T "$partial" "$engines/$name"; then
    rm -rf "$partial"; ENGINE_ERR="לא הצלחתי להעביר את $name למקומו ב-$engines"; return 1
  fi
  ENGINE_NAME="$name"
}

# <file> against the SHA256SUMS in its directory: its own line must be there and match.
engine_tarball_verify() {
  local file=$1 dir base want
  dir="$(dirname "$file")"; base="$(basename "$file")"
  if [[ ! -f "$file" ]]; then ENGINE_ERR="אין קובץ $file"; return 1; fi
  want="$(awk -v f="$base" '$2 == f || $2 == "*" f { print $1; exit }' "$dir/SHA256SUMS" 2>/dev/null)"
  if [[ ! "$want" =~ ^[0-9a-f]{64}$ ]]; then ENGINE_ERR="אין checksum ל-$base ב-$dir/SHA256SUMS"; return 1; fi
  if [[ "$(sha256sum "$file" | cut -c1-64)" != "$want" ]]; then ENGINE_ERR="ה-checksum של $base לא תואם ל-SHA256SUMS. לא מתקין"; return 1; fi
}

# The release of <tag> in a GitHub repo, into <dir>: the public download, else `gh release download` (a private repo,
# a draft). Sets RELEASE_TARBALL. 1 = no release there (not GitHub, no such release, no access).
engine_release_fetch() {
  local url=$1 tag=$2 dir=$3 slug f
  RELEASE_TARBALL=""
  slug="$(engine_github_slug "$url")" || return 1
  f="agent-company-$tag.tar.gz"
  if curl -fsSL "https://github.com/$slug/releases/download/$tag/$f" -o "$dir/$f" 2>/dev/null \
    && curl -fsSL "https://github.com/$slug/releases/download/$tag/SHA256SUMS" -o "$dir/SHA256SUMS" 2>/dev/null; then :
  elif command -v gh >/dev/null && gh release download "$tag" -R "$slug" -p "$f" -p SHA256SUMS -D "$dir" --clobber >/dev/null 2>&1; then :
  else rm -f "$dir/$f" "$dir/SHA256SUMS"; return 1; fi
  RELEASE_TARBALL="$dir/$f"
}

# owner/name of a GitHub repo URL (https, ssh, or owner/name itself); 1 when it is not GitHub.
engine_github_slug() {
  [[ "$1" =~ ^(https://github\.com/|git@github\.com:|ssh://git@github\.com/)?([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)$ ]] || return 1
  local owner="${BASH_REMATCH[2]}" repo="${BASH_REMATCH[3]%.git}"
  [[ -n "${BASH_REMATCH[1]}" || ! -e "$1" ]] || return 1
  echo "$owner/$repo"
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
