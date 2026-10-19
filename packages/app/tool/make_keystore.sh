#!/usr/bin/env bash
# Creates the release signing key once, outside the repo. Never commit these files.
set -euo pipefail
dir="${HOME}/.local/state/agent-company/android"
mkdir -p "$dir"
chmod 700 "$dir"
if [[ -f "$dir/release.jks" ]]; then
  echo "exists: $dir/release.jks"
  exit 0
fi
pw="$(openssl rand -hex 24)"
keytool -genkeypair -keystore "$dir/release.jks" -alias company -keyalg RSA -keysize 4096 -validity 36500 \
  -storepass "$pw" -keypass "$pw" -dname "CN=Agent Company, O=Hive Code, C=IL" >/dev/null 2>&1
printf 'storeFile=%s\nstorePassword=%s\nkeyAlias=company\nkeyPassword=%s\n' "$dir/release.jks" "$pw" "$pw" > "$dir/key.properties"
chmod 600 "$dir/release.jks" "$dir/key.properties"
echo "created: $dir/release.jks"
