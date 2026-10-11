#!/usr/bin/env bash
# Build tdlib/telegram-bot-api (the local Bot API server) into $1.
# Steps follow the upstream README's Ubuntu build instructions.
set -euo pipefail
out="${1:?usage: build-tba.sh <install-dir>}"
src="$RUNNER_TEMP/telegram-bot-api"

start=$(date +%s)
sudo apt-get update -qq >/dev/null
sudo apt-get install -y -qq make git zlib1g-dev libssl-dev gperf cmake g++ >/dev/null
git clone -q --recursive --depth 1 https://github.com/tdlib/telegram-bot-api.git "$src"
cmake -S "$src" -B "$src/build" -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX:PATH="$out" >/dev/null
cmake --build "$src/build" --target install -j "$(nproc)" >/dev/null
echo "tba_build_seconds=$(( $(date +%s) - start ))" >> "$RUNNER_TEMP/timings.env"
