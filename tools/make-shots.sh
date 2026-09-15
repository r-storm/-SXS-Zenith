#!/usr/bin/env sh
# Turn the raw profile screenshots for one snapshot into small WebP crops the
# site can show: a card thumbnail and a round avatar per member. Usage: tools/make-shots.sh 2026-09-15
# Needs cwebp (apt install webp). Crops the 1080x1920 capture to the card and
# scales it to 640px wide; roughly 40 to 60 KB per file.
set -e
d="$1"; [ -n "$d" ] || { echo "usage: $0 <snapshot-date>"; exit 1; }
mkdir -p "data/snapshots/$d/shots"
mkdir -p "data/snapshots/$d/avatars"
for f in captures/"$d"/profiles/*.png; do
  b=$(basename "$f" .png)
  cwebp -quiet -q 72 -crop 60 240 960 1360 -resize 640 0 "$f" -o "data/snapshots/$d/shots/$b.webp"
  # head and shoulders of the character chibi, used as the member's avatar
  cwebp -quiet -q 80 -crop 110 520 250 250 -resize 128 128 "$f" -o "data/snapshots/$d/avatars/$b.webp"
done
ls "data/snapshots/$d/shots" | wc -l; ls "data/snapshots/$d/avatars" | wc -l
