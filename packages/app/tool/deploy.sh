#!/usr/bin/env bash
# Builds and publishes the app on hq-host:
#   web  -> /var/www/hq-app/<secret>/            (https://app.hq.example.com/<secret>/)
#   apk  -> /var/www/hq-app/<secret>/agent-company.apk
# Sign-in is a passkey or a pairing code (#23); the path only keeps the app out of crawlers. It lives
# outside the repo. Also publishes .well-known/assetlinks.json (Android passkeys, deploy/caddy/app.caddy).
# Usage: tool/deploy.sh [web|apk|all]   (default all)
set -euo pipefail
cd "$(dirname "$0")/.."
what="${1:-all}"
flutter="${FLUTTER:-$HOME/flutter/bin/flutter}"
state="${HOME}/.local/state/agent-company"
mkdir -p "$state"
if [[ ! -s "$state/app-path" ]]; then openssl rand -hex 16 > "$state/app-path"; chmod 600 "$state/app-path"; fi
secret="$(cat "$state/app-path")"
dest="/var/www/hq-app/$secret"
sudo -n mkdir -p "$dest"
sudo -n chown "$(id -un)" "$dest"

if [[ "$what" == web || "$what" == all ]]; then
  "$flutter" build web --release --base-href "/$secret/" --no-web-resources-cdn
  rsync -a --delete --exclude '*.apk' build/web/ "$dest/"
  rm -rf build/web
fi
if [[ "$what" == apk || "$what" == all ]]; then
  # One APK per ABI keeps the download small; the owner's phone (OnePlus 13) is arm64.
  "$flutter" build apk --release --split-per-abi --dart-define=HQ_URL="https://app.hq.example.com/$secret/hq"
  cp build/app/outputs/flutter-apk/app-arm64-v8a-release.apk "$dest/agent-company.apk"
  rm -rf build/app/intermediates build/app/tmp
fi
sudo -n mkdir -p /var/www/hq-app/.well-known
sudo -n cp ../../deploy/caddy/assetlinks.json /var/www/hq-app/.well-known/assetlinks.json
chmod -R a+rX /var/www/hq-app 2>/dev/null || sudo -n chmod -R a+rX /var/www/hq-app
echo "web: https://app.hq.example.com/$secret/"
echo "apk: https://app.hq.example.com/$secret/agent-company.apk"
