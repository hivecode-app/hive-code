#!/usr/bin/env bash
# Runs an integration test on the laptop's Android emulator (AVD `laya`, read-only, never
# modified) and copies the screenshots and timelines back to
# ~/.local/state/agent-company/qa/device/<name>/.
# Usage: tool/qa/device.sh <name> [--debug|--profile]     e.g. tool/qa/device.sh bidi
#        BASE=origin/main tool/qa/device.sh perf --profile   same test against <base>'s lib/, from a
#        temporary copy (the working tree is never touched); results go to <name>@<base>/.
# Refuses to start while an Android CI job or another emulator is running (one heavy job at a time).
set -euo pipefail
cd "$(dirname "$0")/../.."
name="$1"; mode="${2:---debug}"
host="${QA_HOST:-laptop}"
remote="/tmp/agent-company-qa"
out="$HOME/.local/state/agent-company/qa/device/$name"
src="."
if [[ -n "${BASE:-}" ]]; then
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  rsync -a --exclude build --exclude .dart_tool ./ "$tmp/"
  rm -rf "$tmp/lib" && mkdir -p "$tmp/lib"
  prefix="$(git rev-parse --show-prefix)"
  (cd "$(git rev-parse --show-toplevel)" && git archive "$BASE:${prefix}lib") | tar -x -C "$tmp/lib"
  src="$tmp"; out="$out@${BASE//\//_}"
fi
mkdir -p "$out"


ssh "$host" 'pgrep -f "[R]unner.Worker" >/dev/null && { echo "a CI job is running on the laptop; try later"; exit 3; }; pgrep -f "[q]emu-system" >/dev/null && { echo "an emulator is already running; try later"; exit 3; }; true'
rsync -a --delete --exclude build --exclude .dart_tool --exclude 'android/.gradle' "$src/" "$host:$remote/"
ssh "$host" "cat > $remote.run.sh" <<'EOF'
set -euo pipefail
remote="$1"; name="$2"; mode="$3"
export PATH="$HOME/flutter/bin:$HOME/Android/Sdk/platform-tools:$PATH"
"$HOME/Android/Sdk/emulator/emulator" -avd laya -read-only -no-snapshot-save -no-window -no-audio -no-boot-anim \
  -gpu swiftshader_indirect </dev/null >/tmp/agent-company-qa-emu.log 2>&1 &
trap 'adb -s emulator-5554 emu kill >/dev/null 2>&1 || true' EXIT
adb wait-for-device
until [[ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == 1 ]]; do sleep 2; done
# Right after boot, System UI applies its theme overlays and restarts running apps, which kills the
# isolate the driver just found. Let it settle, then unlock.
sleep 25
adb shell wm dismiss-keyguard >/dev/null 2>&1 || true
cd "$remote"
rm -rf "/tmp/agent-company-qa-out/$name"; mkdir -p "/tmp/agent-company-qa-out/$name"
set +e
# --no-dds: the timeline API (watchPerformance) talks to the VM service on the device directly.
QA_OUT="/tmp/agent-company-qa-out/$name" flutter drive "$mode" --no-dds -d emulator-5554 \
  --driver=test_driver/integration_test.dart --target="integration_test/${name}_device_test.dart" 2>&1 | grep -v "EGL_emulation\|Davey" | tee "/tmp/agent-company-qa-out/$name/drive.log" | tail -15
exit "${PIPESTATUS[0]}"
EOF
status=0
ssh "$host" bash "$remote.run.sh" "$remote" "$name" "$mode" </dev/null || status=$?
rsync -a "$host:/tmp/agent-company-qa-out/$name/" "$out/"
ssh "$host" "rm -rf /tmp/agent-company-qa-out/$name"
echo "$out"
exit "$status"
