#!/usr/bin/env bash
# Publishes the working tree's web build as a QA copy next to the owner's app, at <app path>/qa/
# (same origin, so it can reach hq through the same gateway). The owner's build is not touched.
# Drive it with tool/qa/pw.mjs --url=<printed url> and QA_HQ=gateway (see pw.mjs).
# Usage: tool/qa/publish_qa.sh [remove]
set -euo pipefail
cd "$(dirname "$0")/../.."
flutter="${FLUTTER:-$HOME/flutter/bin/flutter}"
secret="$(cat "$HOME/.local/state/agent-company/app-path")"
dest="/var/www/hq-app/$secret/qa"
if [[ "${1:-}" == remove ]]; then rm -rf "$dest"; echo "removed $dest"; exit 0; fi
"$flutter" build web --release --base-href "/$secret/qa/" --no-web-resources-cdn >/dev/null
mkdir -p "$dest"
rsync -a --delete build/web/ "$dest/"
rm -rf build/web
chmod -R a+rX "$dest"
echo "https://app.hq.example.com/$secret/qa/"
