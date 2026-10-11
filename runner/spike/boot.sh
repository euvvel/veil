#!/usr/bin/env bash
# Spike stage A: measure slskd boot on a GitHub runner without logging in.
# Public repo: print nothing but timings. Container logs are never echoed.
set -euo pipefail
: "${SLSKD_IMAGE:?}" "${TBA_BIN:?}"
out="$RUNNER_TEMP/spike-out"; mkdir -p "$out"
timings="$RUNNER_TEMP/timings.env"; touch "$timings"
key=$(head -c 24 /dev/urandom | base64 | tr -dc A-Za-z0-9)

t0=$(date +%s)
docker pull -q "$SLSKD_IMAGE" >/dev/null
echo "slskd_pull_seconds=$(( $(date +%s) - t0 ))" >> "$timings"

t0=$(date +%s)
docker run -d --name slskd -p 127.0.0.1:5030:5030 \
  -e SLSKD_SWAGGER=true -e SLSKD_NO_HTTPS=true -e SLSKD_NO_VERSION_CHECK=true \
  -e SLSKD_API_KEY="$key" "$SLSKD_IMAGE" >/dev/null
for _ in $(seq 1 120); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "X-API-Key: $key" http://127.0.0.1:5030/api/v0/application || true)
  [ "$code" = 200 ] && break
  sleep 1
done
echo "slskd_api_ready_seconds=$(( $(date +%s) - t0 ))" >> "$timings"
curl -s http://127.0.0.1:5030/swagger/v0/swagger.json -o "$out/slskd-openapi.json"
docker rm -f slskd >/dev/null

"$TBA_BIN" --version >/dev/null 2>&1 && echo "tba_binary_ok=true" >> "$timings" || echo "tba_binary_ok=false" >> "$timings"
echo "tba_binary_mb=$(( $(stat -c %s "$TBA_BIN") / 1048576 ))" >> "$timings"
echo "nproc=$(nproc)" >> "$timings"
echo "mem_gb=$(( $(awk '/MemTotal/{print $2}' /proc/meminfo) / 1048576 ))" >> "$timings"

cp "$timings" "$out/timings.env"
cat "$timings"
