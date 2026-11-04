#!/usr/bin/env bash
# Publishes the working tree's web build as a QA copy next to the owner's app, at /qa-app/ (same origin,
# so it reaches hq through /qa-app/hq, deploy/caddy/agent-company.caddy). The owner's build is not touched.
# Sign in with a pairing code (`node packages/hq/src/main.ts pair`); drive it with
# tool/qa/pw.mjs --url=<printed url>.
# Usage: tool/qa/publish_qa.sh [remove]
set -euo pipefail
cd "$(dirname "$0")/../.."
flutter="${FLUTTER:-$HOME/flutter/bin/flutter}"
dest="/var/www/hq-app/qa-app"
if [[ "${1:-}" == remove ]]; then sudo -n rm -rf "$dest"; echo "removed $dest"; exit 0; fi
"$flutter" build web --release --base-href "/qa-app/" --no-web-resources-cdn >/dev/null
sudo -n install -d -o "$(id -un)" "$dest"
rsync -a --delete build/web/ "$dest/"
rm -rf build/web
chmod -R a+rX "$dest"
echo "https://app.hq.example.com/qa-app/"
