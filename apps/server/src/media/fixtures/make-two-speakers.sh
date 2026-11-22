#!/bin/sh
# Regenerates two-speakers.ogg, the audio for deepgram.live.test.ts: two synthetic espeak-ng voices
# (no recording of a real person, so no licensing or consent question), one turn each, ~9 s, ~22 KB.
#   Speaker A (0.4–4.4 s): "Welcome back to the show. How was your trip to Denver?"
#   Speaker B (5.1–9.0 s): "It was great, thanks. The mountains were beautiful."
# Needs espeak-ng and ffmpeg. Without them, run it in a throwaway Debian container, e.g.
#   docker run --rm -v "$PWD:/out" -w /out debian:bookworm sh -c \
#     'apt-get update && apt-get install -y espeak-ng ffmpeg && sh make-two-speakers.sh'
set -e
cd "$(dirname "$0")"
tmp=$(mktemp -d)
espeak-ng -v en-us+m3 -p 30 -s 150 -w "$tmp/a.wav" "Welcome back to the show. How was your trip to Denver?"
espeak-ng -v en-gb-x-rp+f4 -p 80 -s 160 -w "$tmp/b.wav" "It was great, thanks. The mountains were beautiful."
ffmpeg -loglevel error -y \
  -f lavfi -t 0.4 -i anullsrc=r=22050:cl=mono -i "$tmp/a.wav" \
  -f lavfi -t 0.7 -i anullsrc=r=22050:cl=mono -i "$tmp/b.wav" \
  -f lavfi -t 0.4 -i anullsrc=r=22050:cl=mono \
  -filter_complex "[0][1][2][3][4]concat=n=5:v=0:a=1,aresample=16000" \
  -ac 1 -c:a libopus -b:a 24k -map_metadata -1 two-speakers.ogg
rm -rf "$tmp"
