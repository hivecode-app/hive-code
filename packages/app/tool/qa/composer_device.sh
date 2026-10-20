#!/usr/bin/env bash
# Runs integration_test/composer_device_test.dart on the laptop's emulator (AVD `laya`, read-only)
# and plays the steps the test asks of the host (`QA-HOST tap X Y | longpress X Y | key NAME |
# shot NAME`): touches that must reach Android's own EditText, and screenshots of the real screen
# (platform views included). Results go to ~/.local/state/agent-company/qa/device/composer/.
# Same one-heavy-job rule as device.sh.
set -euo pipefail
cd "$(dirname "$0")/../.."
host="${QA_HOST:-laptop}"
remote="/tmp/agent-company-qa"
out="$HOME/.local/state/agent-company/qa/device/composer"
mkdir -p "$out"
ssh "$host" 'pgrep -f "[R]unner.Worker" >/dev/null && { echo "a CI job is running on the laptop; try later"; exit 3; }; pgrep -f "[q]emu-system" >/dev/null && { echo "an emulator is already running; try later"; exit 3; }; true'
rsync -a --delete --exclude build --exclude .dart_tool --exclude 'android/.gradle' ./ "$host:$remote/"
ssh "$host" "cat > $remote.composer.sh" <<'EOF'
set -euo pipefail
remote="$1"
export PATH="$HOME/flutter/bin:$HOME/Android/Sdk/platform-tools:$PATH"
export ANDROID_SERIAL=emulator-5554
res="/tmp/agent-company-qa-out/composer"; rm -rf "$res"; mkdir -p "$res"
"$HOME/Android/Sdk/emulator/emulator" -avd laya -read-only -no-snapshot-save -no-window -no-audio -no-boot-anim \
  -gpu swiftshader_indirect </dev/null >/tmp/agent-company-qa-emu.log 2>&1 &
trap 'adb emu kill >/dev/null 2>&1 || true' EXIT
adb wait-for-device
until [[ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == 1 ]]; do sleep 2; done
sleep 25
adb shell wm dismiss-keyguard >/dev/null 2>&1 || true
cd "$remote"
log="$res/drive.log"; : > "$log"
QA_OUT="$res" flutter drive --debug --no-dds -d emulator-5554 --driver=test_driver/integration_test.dart \
  --target=integration_test/composer_device_test.dart >"$log" 2>&1 &
drive=$!
tail -n +1 -F "$log" 2>/dev/null | while IFS= read -r line; do
  [[ "$line" == *"QA-HOST "* ]] || { [[ "$line" == *"All tests passed"* || "$line" == *"Some tests failed"* ]] && break; continue; }
  read -ra a <<<"${line##*QA-HOST }"
  case "${a[0]}" in
    tap) adb shell input tap "${a[1]}" "${a[2]}" ;;
    longpress) adb shell input swipe "${a[1]}" "${a[2]}" "${a[1]}" "${a[2]}" 1200 ;;
    key) adb shell input keyevent "KEYCODE_${a[1]}" ;;
    shot) adb exec-out screencap -p > "$res/${a[1]}.png" ;;
  esac
  echo "host: ${a[*]}" >> "$res/host.log"
done &
status=0; wait "$drive" || status=$?
grep -v "EGL_emulation\|Davey" "$log" | tail -15
exit "$status"
EOF
status=0
ssh "$host" bash "$remote.composer.sh" "$remote" </dev/null || status=$?
rsync -a "$host:/tmp/agent-company-qa-out/composer/" "$out/"
echo "$out"
exit "$status"
