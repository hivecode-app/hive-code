#!/usr/bin/env bash
# Builds the landing page into one directory that GitHub Pages serves as is (site/README.md).
# The screenshots, the logo and the fonts are not copied into site/: they come from where they live, so the page
# always shows the current app and brand.
#   site/build.sh [OUT]     default OUT: site/_site
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="${1:-$root/site/_site}"
rm -rf "$out"
mkdir -p "$out/screenshots" "$out/brand" "$out/fonts"
cp "$root/site/index.html" "$root/site/style.css" "$out/"
cp "$root"/docs/assets/screenshots/*.png "$out/screenshots/"
for f in logo-light.svg logo-dark.svg mark-light.svg mark-dark.svg; do
  cp "$root/docs/brand/hive-code/$f" "$out/brand/"
done
for f in Heebo-400.ttf Heebo-500.ttf Heebo-700.ttf JetBrainsMono-400.ttf; do
  cp "$root/packages/app/assets/fonts/$f" "$out/fonts/"
done
# Both fonts are under the SIL Open Font License 1.1; OFL.txt in the app carries Heebo's copyright line, so the
# license goes out once per font, each with its own line.
cp "$root/packages/app/assets/fonts/OFL.txt" "$out/fonts/OFL-Heebo.txt"
sed '1s|.*|Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)|' \
  "$root/packages/app/assets/fonts/OFL.txt" >"$out/fonts/OFL-JetBrainsMono.txt"
echo "$out"
