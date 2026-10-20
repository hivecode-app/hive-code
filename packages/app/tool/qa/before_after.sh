#!/usr/bin/env bash
# Renders one golden test twice, against <base>'s lib/ and against the working tree's, and writes
# side-by-side BEFORE|AFTER images. Never touches the working tree: both runs happen in temporary
# copies of the package, and the committed goldens are not rewritten.
# Usage: tool/qa/before_after.sh test/bidi_corpus_test.dart goldens/sample_bidi [base=origin/main]
set -euo pipefail
cd "$(dirname "$0")/../.."
test="$1"; dir="$2"; base="${3:-origin/main}"
flutter="${FLUTTER:-$HOME/flutter/bin/flutter}"
state="$HOME/.local/state/agent-company/qa/$(basename "$dir")"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$state/before" "$state/after" "$state/cmp"

render() { # <package copy> <out dir>
  rm -rf "$1/test/$dir"
  (cd "$1" && "$flutter" test "$test" --update-goldens >"$1.log" 2>&1) || true
  if ! ls "$1/test/$dir"/*.png >/dev/null 2>&1; then echo "no goldens from $1:"; tail -20 "$1.log"; exit 1; fi
  cp "$1/test/$dir"/*.png "$2/"
}
for side in before after; do
  rsync -a --exclude build --exclude .dart_tool ./ "$tmp/$side/"
done
# The base's lib/ and test helpers (helpers may use newer lib API); tests and fixtures stay ours.
prefix="$(git rev-parse --show-prefix)"
rm -rf "$tmp/before/lib" && mkdir -p "$tmp/before/lib"
(cd "$(git rev-parse --show-toplevel)" && git archive "$base:${prefix}lib") | tar -x -C "$tmp/before/lib"
git show "$base:${prefix}test/helpers.dart" > "$tmp/before/test/helpers.dart" 2>/dev/null || true
render "$tmp/before" "$state/before"
render "$tmp/after" "$state/after"
python3 "$(dirname "$0")/cmp.py" "$state/before" "$state/after" "$state/cmp" ${CMP_BOTH:+--both}
echo "$state/cmp"
