#!/usr/bin/env bash
# Builds the TrailPin debug APK on your own machine and copies it to android/dist.
#
# Requirements: JDK 17 (or newer) and the Android SDK. Android Studio installs
# both; otherwise set ANDROID_HOME and install "platforms;android-34" plus
# "build-tools;34.0.0" through sdkmanager.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here"

if ! command -v java >/dev/null 2>&1; then
  echo "error: no 'java' on PATH — install JDK 17 (e.g. 'brew install temurin@17', 'apt install openjdk-17-jdk')." >&2
  exit 1
fi

if [ -z "${ANDROID_HOME:-}${ANDROID_SDK_ROOT:-}" ] && [ ! -f local.properties ]; then
  echo "warning: neither ANDROID_HOME nor ANDROID_SDK_ROOT is set." >&2
  echo "         Create android/local.properties with 'sdk.dir=/path/to/Android/sdk'," >&2
  echo "         or open this folder in Android Studio once." >&2
fi

./gradlew --no-daemon "$@" assembleDebug

mkdir -p dist
cp app/build/outputs/apk/debug/app-debug.apk dist/trailpin-debug.apk
echo
echo "APK: $here/dist/trailpin-debug.apk"
echo "Install with: adb install -r \"$here/dist/trailpin-debug.apk\""
