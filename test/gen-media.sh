#!/usr/bin/env bash
# Generates the test videos with ffmpeg: test/media/ad.webm (15 s), ad-long.webm (70 s), content.webm (30 s).
set -euo pipefail
OUT="$(cd "$(dirname "$0")" && pwd)/media"
mkdir -p "$OUT"
make() {
  local out="$1" len="$2" src="$3" hz="$4"
  [[ -s "$OUT/$out" ]] && { echo "keep $out"; return; }
  ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "${src}=size=320x180:rate=30" -f lavfi -i "sine=frequency=${hz}:sample_rate=48000" \
    -t "$len" -map 0:v -map 1:a \
    -c:v libvpx-vp9 -b:v 150k -g 30 -deadline realtime -cpu-used 8 -pix_fmt yuv420p \
    -c:a libopus -b:a 48k -ac 2 "$OUT/$out"
  echo "wrote $out"
}
make ad.webm 15 smptebars 880
make ad-long.webm 70 smptebars 660
make content.webm 30 testsrc2 440
