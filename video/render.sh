#!/bin/sh
# 一条命令出片：截界面 → 合成配乐和音效 → 渲染 mp4 → 截一段做 README 的 GIF
# 用法：./render.sh            （先在仓库根目录 npm run build，截图要用 dist/）
#       SKIP_CAPTURE=1 ./render.sh   只改了动画、不重截界面时用
set -e
cd "$(dirname "$0")"
OUT=out/localvps-intro.mp4
GIF=../docs/images/demo.gif
[ -d node_modules ] || npm ci
[ -f ../dist/cli.js ] || (cd .. && npm run build)
[ -n "$SKIP_CAPTURE" ] || node capture/capture.mjs
cp ../docs/images/icon.png public/shots/icon.png
python3 audio/make_music.py
mkdir -p out
npx remotion render LocalvpsIntro "$OUT" --codec=h264 --crf=18 --audio-codec=aac --audio-bitrate=256k --image-format=jpeg --jpeg-quality=95
# README 首屏：概览浮现、复制接入命令、AI 调用写进日志（10.5–25.5 秒），960 宽、12fps、调色板压缩
ffmpeg -y -loglevel error -ss 10.5 -t 15 -i "$OUT" -vf "fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" "$GIF"
ls -lh "$OUT" "$GIF"
