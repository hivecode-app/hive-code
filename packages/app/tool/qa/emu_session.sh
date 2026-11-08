#!/usr/bin/env bash
# Hands-on QA of the real app on the laptop's emulator (AVD `laya`, read-only): installs a profile
# build of the working tree and plays a steps file, saving screenshots back to
# ~/.local/state/agent-company/qa/emu/<name>/. Only one heavy job at a time on the laptop: refuses
# while an Android CI job or another emulator runs. Every adb call targets this run's emulator only
# (its own port), never a phone that happens to be plugged in.
#
# Steps (one per line; blank lines and # comments are skipped):
#   tap X Y | swipe X1 Y1 X2 Y2 MS | text WORDS (letters, digits, spaces, -) | key BACK|ENTER|...
#   sleep MS | shot NAME | rotate 0|1 | dark on|off | start | stop | record NAME SECONDS | pull NAME
#   logcat NAME (the device log so far, saved as NAME.txt)
# Coordinates are device pixels (1080x2400).
# Usage: tool/qa/emu_session.sh <name> <steps file> [--no-build]
set -euo pipefail
name="$1"; steps="$(realpath "$2")"; build="${3:-}"
[[ "$name" =~ ^[A-Za-z0-9._-]+$ && "$name" != *..* ]] || { echo "name: letters, digits, . _ - only" >&2; exit 2; }
cd "$(dirname "$0")/../.."
host="${QA_HOST:-laptop}"
port=5584 # this run's emulator: adb serial emulator-5584
out="$HOME/.local/state/agent-company/qa/emu/$name"
mkdir -p "$out"
apk=build/app/outputs/flutter-apk/app-profile.apk
if [[ "$build" != --no-build ]]; then
  # No server built in: the steps type it on the sign-in screen, or open a pairing link
  # (adb shell am start -d 'agentcompany://pair?url=…').
  "${FLUTTER:-$HOME/flutter/bin/flutter}" build apk --profile --target-platform android-x64 >/dev/null
fi
run="/tmp/agent-company-qa-run-$name-$$" # this run's own folder on the laptop
cleanup() { ssh "$host" "rm -rf $run" || true; }
trap cleanup EXIT
ssh "$host" "mkdir -m 700 -p $run"
scp -q "$apk" "$host:$run/app.apk"
scp -q "$steps" "$host:$run/steps"
ssh "$host" "cat > $run/session.sh" <<'EOF'
set -euo pipefail
set -f
name="$1"; port="$2"; run="$3"
# The busy check and the start happen here, together.
pgrep -f "[R]unner.Worker" >/dev/null && { echo "a CI job is running on the laptop; try later"; exit 3; }
pgrep -f "[q]emu-system" >/dev/null && { echo "an emulator is already running; try later"; exit 3; }
out="$run/out"; mkdir -p "$out"
export PATH="$HOME/Android/Sdk/platform-tools:$PATH"
export ANDROID_SERIAL="emulator-$port"
"$HOME/Android/Sdk/emulator/emulator" -avd laya -port "$port" -read-only -no-snapshot-save -no-window -no-audio -no-boot-anim \
  -gpu swiftshader_indirect </dev/null >"$run/emulator.log" 2>&1 &
emu_pid=$!
trap 'adb emu kill >/dev/null 2>&1 || true; sleep 2; kill "$emu_pid" 2>/dev/null || true' EXIT
timeout 180 adb wait-for-device </dev/null
for _ in $(seq 90); do
  [[ "$(adb shell getprop sys.boot_completed </dev/null 2>/dev/null | tr -d '\r')" == 1 ]] && break
  sleep 2
done
[[ "$(adb shell getprop sys.boot_completed </dev/null 2>/dev/null | tr -d '\r')" == 1 ]] || { echo "emulator did not boot"; exit 4; }
sleep 25 # System UI restarts apps while it applies its theme right after boot
adb shell wm dismiss-keyguard </dev/null >/dev/null 2>&1 || true
adb install -r -g "$run/app.apk" </dev/null >/dev/null
pkg=app.hivecode
while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line%$'\r'}"
  [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
  read -ra a <<<"$line"
  cmd="${a[0]}"
  case "$cmd" in
    start) adb shell am start -W -n "$pkg/.MainActivity" </dev/null | grep -E "TotalTime|WaitTime" >> "$out/start.txt" || true ;;
    stop) adb shell am force-stop "$pkg" </dev/null ;;
    tap) adb shell input tap "${a[1]}" "${a[2]}" </dev/null ;;
    swipe) adb shell input swipe "${a[1]}" "${a[2]}" "${a[3]}" "${a[4]}" "${a[5]:-300}" </dev/null ;;
    text)
      words="${line#*text }"
      [[ "$words" =~ ^[A-Za-z0-9\ -]+$ ]] || { echo "text: letters, digits, spaces and - only"; continue; }
      adb shell input text "${words// /%s}" </dev/null ;;
    key) if [[ "${a[1]:-}" =~ ^[A-Z_0-9]+$ ]]; then adb shell input keyevent "KEYCODE_${a[1]}" </dev/null; else echo "bad step: $line"; fi ;;
    sleep) if [[ "${a[1]:-}" =~ ^[0-9]+$ ]]; then sleep "$(awk -v ms="${a[1]}" 'BEGIN{print ms/1000}')"; else echo "bad step: $line"; fi ;;
    shot) if [[ "${a[1]:-}" =~ ^[A-Za-z0-9._-]+$ ]]; then adb exec-out screencap -p </dev/null > "$out/${a[1]}.png"; else echo "bad step: $line"; fi ;;
    rotate) if [[ "${a[1]:-}" =~ ^[0-3]$ ]]; then adb shell settings put system accelerometer_rotation 0 </dev/null; adb shell settings put system user_rotation "${a[1]}" </dev/null; else echo "bad step: $line"; fi ;;
    dark) if [[ "${a[1]:-}" =~ ^(on|off)$ ]]; then adb shell cmd uimode night "$([[ "${a[1]}" == on ]] && echo yes || echo no)" </dev/null; else echo "bad step: $line"; fi ;;
    record) if [[ "${a[1]:-}" =~ ^[A-Za-z0-9._-]+$ && "${a[2]:-}" =~ ^[0-9]+$ ]]; then adb shell screenrecord --time-limit "${a[2]}" "/sdcard/${a[1]}.mp4" </dev/null & sleep 0.5; else echo "bad step: $line"; fi ;;
    pull) if [[ "${a[1]:-}" =~ ^[A-Za-z0-9._-]+$ ]]; then sleep 1; adb pull "/sdcard/${a[1]}.mp4" "$out/${a[1]}.mp4" </dev/null >/dev/null; else echo "bad step: $line"; fi ;;
    logcat) if [[ "${a[1]:-}" =~ ^[A-Za-z0-9._-]+$ ]]; then adb logcat -d </dev/null > "$out/${a[1]}.txt" 2>&1 || true; else echo "bad step: $line"; fi ;;
    *) echo "unknown step: $cmd" ;;
  esac
done < "$run/steps"
EOF
status=0
ssh "$host" bash "$run/session.sh" "$name" "$port" "$run" </dev/null || status=$?
rsync -a "$host:$run/out/" "$out/" || true
echo "$out"
exit "$status"
