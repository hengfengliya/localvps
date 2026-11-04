# localvps 产品介绍视频

横版 1920×1080、30fps、约 43 秒，Remotion 做的。成片在 `out/localvps-intro.mp4`，README 首屏的动图写到 `../docs/images/demo.gif`。

## 出片

```bash
cd .. && npm run build && cd video
./render.sh
```

一条命令依次做四件事：

1. `capture/capture.mjs`：起一个演示实例（独立 HOME、端口 38787/38788，不碰你正在用的 localvps），按分镜灌几次调用、切权限，用本机 Chrome 按 3 倍清晰度截下每个界面状态和要点的位置 → `public/shots/`。演示实例显示名是 MacBook-Pro，工作目录 `/Users/Shared/localvps-workspace`，截完自动删掉
2. `audio/make_music.py`：用 numpy 合成配乐和音效 → `public/audio/`
3. `npx remotion render`：出 mp4
4. ffmpeg 截 10.5–25.5 秒做 GIF

只改了动画不用重截界面：`SKIP_CAPTURE=1 ./render.sh`。预览：`npx remotion studio`。

## 结构

| 文件 | 内容 |
|---|---|
| `src/timeline.json` | 全片时间轴，单位是拍（120 BPM，一拍 15 帧）：段落、场景、字幕、音效。音乐和画面都读它 |
| `src/Scenes.tsx` | 八场：开场两句话、终端安装、概览、连接、AI 调用、权限、远程查看、结尾 |
| `src/ui.tsx` | 窗口、截图分块显现、光标、中英字幕 |
| `audio/make_music.py` | 配乐和音效合成器（沿用 Beayy 产品介绍片的合成器，拍数改成读时间轴） |

`public/shots/`、`public/audio/`、`out/`、`node_modules/` 都是生成的，不进 git。

## 素材来源

- 画面：localvps 自己的控制台，演示数据
- 配乐、音效：`audio/make_music.py` 原创合成，没有用任何采样或第三方音乐
- 字体：系统自带的苹方
