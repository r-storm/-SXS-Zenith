#!/usr/bin/env sh
# Turn the raw profile screenshots for one snapshot into small WebP crops the
# site can show. Usage: tools/make-shots.sh 2026-09-15
# Needs cwebp (apt install webp). Crops the 1080x1920 capture to the card and
# scales it to 640px wide; roughly 40 to 60 KB per file.
set -e
d="$1"; [ -n "$d" ] || { echo "usage: $0 <snapshot-date>"; exit 1; }
mkdir -p "data/snapshots/$d/shots"
for f in captures/"$d"/profiles/*.png; do
  b=$(basename "$f" .png)
  cwebp -quiet -q 72 -crop 60 240 960 1360 -resize 640 0 "$f" -o "data/snapshots/$d/shots/$b.webp"
done
ls "data/snapshots/$d/shots" | wc -l
