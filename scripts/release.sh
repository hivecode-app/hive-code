#!/usr/bin/env bash
# An engine release (docs/generic/PLAN.md §5): one tarball the installer and `company update` deploy as engine/<tag>.
#
#   scripts/release.sh <X.Y.Z> [--ref REF] [--out DIR] [--no-publish]
#
# From the commit REF (default HEAD, which must be on origin/main to publish):
#   1. the engine tree, `git archive` of the commit, without what is not the engine (company/, memory/, research/,
#      spikes/, docs/): the engine is the same for every company, and the company lives in COMPANY_HOME;
#   2. the app for the web (Flutter web, no hq address built in: the app finds hq at <origin>/hq) in web/;
#   3. the generic APK (app.hivecode, no Firebase: packages/app/android/app/build.gradle.kts), signed with the release
#      key (never the debug key), in apk/agent-company.apk, with apk/app-release.json for the in-app update
#      (packages/hq/src/app-release.ts) and the key's hash, which install.sh adds to hq's passkey origins;
#   4. .engine-release: "<tag> <sha>".
# All in agent-company-v<X.Y.Z>.tar.gz (one top dir, agent-company-v<X.Y.Z>/), next to SHA256SUMS.
# Then the annotated tag v<X.Y.Z> on the commit, pushed, and a GitHub Release with both files: a draft prerelease
# (the repo is private). Publishes to the origin of the checkout: run it from the engine repo (hive-owner/company-engine,
# the default of install.sh), not from agent-company. --no-publish only builds into --out.
#
# Built from a clean export of the commit, never from the working tree, so the release is exactly the tag.
# Needs (hq-host): ~/flutter, the Android SDK, the release key (~/.local/state/agent-company/android/key.properties).
# HIVECODE_APK_KEY_HASH=<b64url sha256>, when set, is the key the APK must be signed with.
set -euo pipefail

FLUTTER="${FLUTTER:-$HOME/flutter/bin/flutter}"
# task-297: no Gradle or Kotlin daemon outlives the build (a leftover held 8GB for 3 hours on 21/10). The app's
# gradle.properties says so; this says it for a checkout whose properties file is older.
export GRADLE_OPTS="${GRADLE_OPTS:-} -Dorg.gradle.daemon=false -Dorg.gradle.project.kotlin.compiler.execution.strategy=in-process"
APKSIGNER="${APKSIGNER:-/opt/android-sdk/build-tools/36.0.0/apksigner}"
AAPT2="${AAPT2:-/opt/android-sdk/build-tools/36.0.0/aapt2}"
# Not the engine: the company's contract and memory, research notes, spikes and the design docs (scripts/clean-history.sh
# removes most of them from the history too).
EXCLUDE=(company memory research spikes docs)

die() { echo "release: $*" >&2; exit 1; }
say() { echo "• $*"; }

version=""; ref=HEAD; out=""; publish=1
while (($#)); do
  case "$1" in
    --ref) ref="${2:?}"; shift 2 ;;
    --out) out="${2:?}"; shift 2 ;;
    --no-publish) publish=0; shift ;;
    -h|--help) sed -n '2,21p' "$0"; exit 0 ;;
    -*) die "ארגומנט לא מוכר: $1" ;;
    *) [[ -z "$version" ]] || die "גרסה אחת בלבד"; version="$1"; shift ;;
  esac
done
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "שימוש: scripts/release.sh <X.Y.Z> [--ref REF] [--out DIR] [--no-publish]"
tag="v$version"
name="agent-company-$tag"
repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

sha="$(git rev-parse --verify "$ref^{commit}")" || die "אין commit בשם $ref"
[[ "$(git rev-parse --is-shallow-repository)" == false ]] || die "ה-checkout רדוד, ולכן מספר ה-build לא אמין"
if ((publish)); then
  command -v gh >/dev/null || die "צריך gh לפרסום"
  git fetch -q origin main --tags
  git merge-base --is-ancestor "$sha" origin/main || die "${sha:0:7} לא נמצא ב-origin/main: משחררים רק מ-main"
  # An annotated tag lists its tag object first; the commit is the ^{} line.
  refs="$(git ls-remote origin "refs/tags/$tag^{}" "refs/tags/$tag")"
  remote_tag="$( { grep -F '^{}' <<<"$refs" || head -1 <<<"$refs"; } | head -1 | cut -f1)"
  [[ -z "$remote_tag" || "$remote_tag" == "$sha" ]] || die "התג $tag כבר קיים ב-origin על ${remote_tag:0:7}, לא על ${sha:0:7}"
  if gh release view "$tag" >/dev/null 2>&1; then die "כבר יש GitHub Release בשם $tag"; fi
fi
for t in "$FLUTTER" "$APKSIGNER" "$AAPT2"; do [[ -x "$t" ]] || die "חסר $t"; done

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
out="${out:-$repo_root/dist/$tag}"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
rm -f "$out/$name.tar.gz" "$out/SHA256SUMS"

# ── the app, built from an export of the commit ───────────────────────────────
say "בונה את האפליקציה מ-${sha:0:7} (web ו-APK)"
mkdir "$work/src"
git archive "$sha" packages/app | tar -x -C "$work/src"
# The release is the same app for everyone: no owner's applicationId or Firebase project.
unset HIVECODE_ANDROID_CONFIG
# The commit count of main is the versionCode, as in scripts/deploy.sh app: a release and a deploy of the same
# commit are the same build number, and a later one is always higher.
build="$(git rev-list --count "$sha")"
(cd "$work/src/packages/app" \
  && "$FLUTTER" pub get >/dev/null \
  && "$FLUTTER" build web --release --base-href / --no-web-resources-cdn --no-wasm-dry-run >/dev/null \
  && "$FLUTTER" build apk --release --split-per-abi --build-number="$build" --build-name="$version" >/dev/null) \
  || die "flutter build נכשל"
web="$work/src/packages/app/build/web"
apk="$work/src/packages/app/build/app/outputs/flutter-apk/app-arm64-v8a-release.apk"
[[ -f "$web/index.html" ]] || die "ה-build של web לא נוצר"
size="$(stat -c %s "$apk")"
((size > 5 * 1024 * 1024)) || die "ה-APK קטן מדי ($size bytes)"
certs="$("$APKSIGNER" verify --print-certs "$apk")" || die "apksigner דחה את ה-APK"
! grep -q 'CN=Android Debug' <<<"$certs" || die "ה-APK חתום במפתח ה-debug: אין key.properties של מפתח השחרור"
hex="$(sed -n 's/.*certificate SHA-256 digest: \([0-9a-f]\{64\}\).*/\1/p' <<<"$certs" | head -1)"
got="$(echo -n "$hex" | xxd -r -p | base64 -w0 | tr '+/' '-_' | tr -d '=')"
[[ -n "$got" ]] || die "לא הצלחתי לקרוא את חתימת ה-APK"
[[ -z "${HIVECODE_APK_KEY_HASH:-}" || "$got" == "$HIVECODE_APK_KEY_HASH" ]] || die "ה-APK לא חתום במפתח השחרור ($got, ציפיתי ל-$HIVECODE_APK_KEY_HASH)"
code="$("$AAPT2" dump badging "$apk" | sed -n "s/^package: .* versionCode='\([0-9]*\)'.*/\1/p")"
vname="$("$AAPT2" dump badging "$apk" | sed -n "s/^package: .* versionName='\([^']*\)'.*/\1/p")"
[[ "$code" =~ ^[0-9]+$ ]] || die "לא הצלחתי לקרוא את ה-versionCode של ה-APK"

# ── the tarball ───────────────────────────────────────────────────────────────
stage="$work/stage/$name"
mkdir -p "$stage"
excl=(); for d in "${EXCLUDE[@]}"; do excl+=(":(exclude)$d"); done
git archive "$sha" -- . "${excl[@]}" | tar -x -C "$stage"
cp -r "$web" "$stage/web"
mkdir "$stage/apk"
cp "$apk" "$stage/apk/agent-company.apk"
node -e 'const [code, name, sha, sha256, bytes, key] = process.argv.slice(1);
  console.log(JSON.stringify({ version_code: +code, version_name: name, sha, apk: "agent-company.apk", sha256, bytes: +bytes, apk_key_hash: key }))' \
  "$code" "$vname" "$sha" "$(sha256sum "$apk" | cut -c1-64)" "$size" "$got" >"$stage/apk/app-release.json"
echo "$tag $sha" >"$stage/.engine-release"
chmod -R u+rwX,go+rX "$stage"
# The same bytes for the same commit: names sorted, one owner, the commit's time.
mtime="$(git show -s --format=%ct "$sha")"
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime="@$mtime" -C "$work/stage" -cf - "$name" | gzip -n >"$out/$name.tar.gz"
(cd "$out" && sha256sum "$name.tar.gz" >SHA256SUMS)
say "$out/$name.tar.gz ($(($(stat -c %s "$out/$name.tar.gz") / 1048576)) MB): המנוע ב-${sha:0:7}, web, ‏APK ‏versionCode $code ($vname), חתימה תקינה"

((publish)) || { say "בלי פרסום (--no-publish). SHA256SUMS ב-$out"; exit 0; }

# ── tag and release ───────────────────────────────────────────────────────────
if [[ -z "$remote_tag" ]]; then
  git rev-parse -q --verify "refs/tags/$tag" >/dev/null || git tag -a "$tag" "$sha" -m "agent-company $tag"
  [[ "$(git rev-parse "$tag^{commit}")" == "$sha" ]] || die "התג המקומי $tag לא על ${sha:0:7}"
  git push -q origin "refs/tags/$tag"
fi
say "התג $tag על ${sha:0:7} ב-origin"
notes="המנוע ב-${sha:0:7}, עם האפליקציה ל-web וה-APK (versionCode $code).
התקנה: \`bash scripts/install.sh --version $tag\`, או מקובץ: \`--from-tarball $name.tar.gz\` (עם SHA256SUMS לידו). עדכון: \`company update $tag\`."
url="$(gh release create "$tag" "$out/$name.tar.gz" "$out/SHA256SUMS" --verify-tag --draft --prerelease --title "agent-company $tag" --notes "$notes")"
say "GitHub Release (draft, prerelease): $url"
