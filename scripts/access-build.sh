#!/usr/bin/env bash
# access-build.sh <owner/name> <sha> <dockerfile> <tag> [context]
# What hq runs for `request_access` on `build:<name>` (packages/hq/src/access.ts, docs/request-access.md): a temporary clone
# of one sha, `docker build`, `docker push` to the registry, and the digest on the last line. Runs on the machine that
# holds the registry login; the worker that asked never sees it. Whole build log goes to a file here, the output is its tail.
set -euo pipefail
repo=${1:?repo} sha=${2:?sha} dockerfile=${3:?dockerfile} tag=${4:?tag} context=${5:-.}

# The job's output file is capped (1MB, soft): a clone and an image layer export are not output.
ulimit -S -f unlimited 2>/dev/null || true

[[ $repo =~ ^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+$ ]] || { echo "repo לא תקין: $repo"; exit 2; }
[[ $sha =~ ^[0-9a-f]{40}$ ]] || { echo "sha חייב להיות מלא (40 תווים)"; exit 2; }
# Ours: the GitHub account gh is signed in as here (the one that holds the registry login), and its ghcr.io namespace.
# hq's policy (access-policy.ts) checks the same against the catalog; this is the second check, on the machine itself.
owner=${COMPANY_BUILD_OWNER:-$(gh api user --jq .login 2>/dev/null || true)}
[[ -n $owner ]] || { echo "לא ידוע של מי ה-registry: gh לא מחובר (או COMPANY_BUILD_OWNER)"; exit 2; }
registry=${COMPANY_BUILD_REGISTRY:-ghcr.io/${owner,,}/}
[[ $tag == "$registry"* && ${tag#"$registry"} =~ ^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9_][A-Za-z0-9._-]*$ ]] || { echo "התג חייב להיות תחת $registry"; exit 2; }
for p in "$dockerfile" "$context"; do
  [[ $p != /* && $p != -* && $p != *..* ]] || { echo "נתיב לא מותר: $p"; exit 2; }
done

# A repo of someone else only with WRITE for us; ours needs no check.
if [[ ${repo%%/*} != "$owner" ]]; then
  [[ $(gh api "repos/$repo" --jq .permissions.push 2>/dev/null) == true ]] || { echo "אין לנו WRITE על $repo: לא בונים ממנו"; exit 3; }
fi

work=$(mktemp -d "${COMPANY_BUILD_TMP:-/tmp}/company-build.XXXXXX")
trap 'rm -rf "$work"' EXIT
src=$work/src
log=$work/build.log

echo "clone: $repo@${sha:0:12}"
git init -q "$src"
git -C "$src" remote add origin "https://github.com/$repo.git"
git -C "$src" -c credential.helper= -c 'credential.helper=!gh auth git-credential' fetch -q --depth 1 origin "$sha"
git -C "$src" checkout -q FETCH_HEAD
[[ $(git -C "$src" rev-parse HEAD) == "$sha" ]] || { echo "ה-sha שהורד לא זהה למבוקש"; exit 4; }

# The Dockerfile and the context stay inside the clone, also through a link.
root=$(realpath -e "$src")
df=$(realpath -e "$src/$dockerfile" 2>/dev/null) || { echo "אין Dockerfile בנתיב $dockerfile"; exit 2; }
cx=$(realpath -e "$src/$context" 2>/dev/null) || { echo "אין תיקיית context בנתיב $context"; exit 2; }
[[ -f $df && $df == "$root"/* && ( $cx == "$root" || $cx == "$root"/* ) && -d $cx ]] || { echo "ה-Dockerfile וה-context חייבים להיות בתוך ה-repo"; exit 2; }

tailof() { tail -n "$1" "$log"; }
echo "build: $tag"
if ! docker build --progress=plain -f "$df" -t "$tag" "$cx" >"$log" 2>&1; then
  echo "docker build נכשל. סוף הלוג:"; tailof 120; exit 5
fi
tailof 15
echo "push: $tag"
if ! docker push "$tag" >"$log" 2>&1; then
  echo "docker push נכשל. סוף הלוג:"; tailof 40; exit 6
fi
digest=$(sed -n 's/.*digest: \(sha256:[0-9a-f]\{64\}\).*/\1/p' "$log" | tail -n 1)
[[ -n $digest ]] || { echo "ה-push הסתיים בלי digest:"; tailof 20; exit 7; }
echo "image: ${tag%:*}@$digest"
echo "digest: $digest"
