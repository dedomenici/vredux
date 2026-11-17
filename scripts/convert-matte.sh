#!/usr/bin/env bash
# VRedux: convert a Final Cut Pro X matte export (ProRes 4444 with alpha, .mov)
# into web formats that browsers can play.
#
#   scripts/convert-matte.sh INPUT.mov [OUTPUT_BASENAME]
#
# Produces (next to OUTPUT_BASENAME, default = input name without extension):
#   NAME-stacked.mp4   H.264, colour on TOP half, alpha as grey on BOTTOM half.
#                      Plays everywhere (iOS, Android, desktop). VRedux decodes it
#                      with a shader. This is the universal default.
#   NAME.webm          VP9 with real alpha (Chrome / Android / Firefox / desktop).
#   NAME-hevc.mov      HEVC with alpha (Safari / iOS), ONLY when run on a Mac
#                      (needs Apple's VideoToolbox encoder). On Linux this is skipped:
#                      export "HEVC 8-bit with alpha" straight from FCPX/Compressor instead.
#
# Env options:
#   MAXH=1080      max height of the colour frame (stacked file is 2x this tall)
#   FPS=30         output frame rate
#   CRF=22         H.264 quality (lower = better/bigger)
#   VP9CRF=32      VP9 quality
#   TRIM_START / TRIM_DUR   optional seconds, e.g. TRIM_DUR=8
#   EQUIRECT=1     input is a full 360 equirectangular matte (uses MAXH=1024 default)
#
# Keep each output under 100 MB (GitHub limit). Check sizes at the end.
set -euo pipefail
IN="${1:?usage: convert-matte.sh INPUT.mov [OUTPUT_BASENAME]}"
BASE="${2:-${IN%.*}}"
if [[ "${EQUIRECT:-0}" == "1" ]]; then MAXH="${MAXH:-1024}"; else MAXH="${MAXH:-1080}"; fi
FPS="${FPS:-30}"; CRF="${CRF:-22}"; VP9CRF="${VP9CRF:-32}"
TRIM=()
[[ -n "${TRIM_START:-}" ]] && TRIM+=(-ss "$TRIM_START")
[[ -n "${TRIM_DUR:-}" ]] && TRIM+=(-t "$TRIM_DUR")

HAS_AUDIO=$(ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 "$IN" | head -1 || true)
PIX=$(ffprobe -v error -select_streams v:0 -show_entries stream=pix_fmt -of csv=p=0 "$IN")
case "$PIX" in *a*|*rgba*|*argb*|*bgra*) ;; *) echo "WARNING: input pix_fmt '$PIX' has no alpha channel. In FCPX export ProRes 4444 (it keeps alpha)." >&2;; esac

SCALE="scale=-2:'min(${MAXH},ih)':flags=lanczos,fps=${FPS}"

echo "== 1/3 stacked colour+mask H.264 (universal) =="
AUD=(-an); [[ -n "$HAS_AUDIO" ]] && AUD=(-map 0:a:0 -c:a aac -b:a 128k)
ffmpeg -hide_banner -v error -y "${TRIM[@]}" -i "$IN" -filter_complex \
  "[0:v]${SCALE},format=rgba,split[c][a];[a]alphaextract,format=yuv420p[m];[c]format=yuv420p[cc];[cc][m]vstack=inputs=2[out]" \
  -map "[out]" "${AUD[@]}" -c:v libx264 -preset slow -crf "$CRF" -pix_fmt yuv420p -profile:v high \
  -movflags +faststart "${BASE}-stacked.mp4"

echo "== 2/3 VP9 + alpha WebM (Chrome/Android) =="
AUDW=(-an); [[ -n "$HAS_AUDIO" ]] && AUDW=(-map 0:a:0 -c:a libopus -b:a 96k)
ffmpeg -hide_banner -v error -y "${TRIM[@]}" -i "$IN" -map 0:v:0 "${AUDW[@]}" -vf "${SCALE},format=yuva420p" \
  -c:v libvpx-vp9 -pix_fmt yuva420p -crf "$VP9CRF" -b:v 0 -row-mt 1 -auto-alt-ref 0 -deadline good -cpu-used 2 \
  "${BASE}.webm"

echo "== 3/3 HEVC + alpha (Safari/iOS) =="
if ffmpeg -hide_banner -encoders 2>/dev/null | grep -q hevc_videotoolbox; then
  AUDH=(-an); [[ -n "$HAS_AUDIO" ]] && AUDH=(-map 0:a:0 -c:a aac -b:a 128k)
  ffmpeg -hide_banner -v error -y "${TRIM[@]}" -i "$IN" -map 0:v:0 "${AUDH[@]}" -vf "${SCALE},format=bgra" \
    -c:v hevc_videotoolbox -alpha_quality 0.75 -b:v 6M -tag:v hvc1 -movflags +faststart "${BASE}-hevc.mov"
else
  echo "   skipped: no hevc_videotoolbox here (it's macOS-only). Export 'HEVC 8-bit with alpha' from FCPX/Compressor if you want it."
fi

W=$(ffprobe -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 "${BASE}-stacked.mp4")
H2=$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "${BASE}-stacked.mp4")
ASPECT=$(awk "BEGIN{printf \"%.4f\", $W/($H2/2)}")
echo
ls -lh "${BASE}"-stacked.mp4 "${BASE}".webm "${BASE}"-hevc.mov 2>/dev/null || true
NAME=$(basename "$BASE")
cat <<JSON

Paste into a scene's "layers" in videos.json (then set bearing/distance/frameHeight):
{
  "id": "${NAME}",
  "title": "${NAME}",
  "film": "Film title",
  "year": 0,
  "projection": "${EQUIRECT:+equirect}${EQUIRECT:-flat}",
  "sources": { "stacked": "layers/${NAME}-stacked.mp4", "webm": "layers/${NAME}.webm"$( [[ -f "${BASE}-hevc.mov" ]] && echo ", \"hevc\": \"layers/${NAME}-hevc.mov\"" ) },
  "aspect": ${ASPECT},
  "bearing": 0, "distance": 6, "frameHeight": 2.8, "elevation": 0,
  "start": 0, "loop": true, "enabled": true, "audio": false
}
JSON
