#!/bin/sh
# localvps 一行安装（macOS）：下载对应芯片的单文件版到 ~/.local/bin，然后启动
#   curl -fsSL https://raw.githubusercontent.com/hengfengliya/localvps/main/install.sh | sh
set -e

REPO="hengfengliya/localvps"
DIR="${LOCALVPS_INSTALL_DIR:-$HOME/.local/bin}"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "一行安装目前只支持 macOS。Windows 请到 https://github.com/$REPO/releases/latest 下载 exe；Linux 请从源码运行。"
  echo "One-line install supports macOS only for now. Windows: download the .exe from Releases. Linux: run from source."
  exit 1
fi

case "$(uname -m)" in
  arm64) ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  *) echo "不支持的芯片架构 / unsupported architecture: $(uname -m)"; exit 1 ;;
esac

URL="https://github.com/$REPO/releases/latest/download/localvps-macos-$ARCH.zip"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "下载 / Downloading $URL"
curl -fL --progress-bar "$URL" -o "$TMP/localvps.zip"
unzip -oq "$TMP/localvps.zip" -d "$TMP"
mkdir -p "$DIR"
mv -f "$TMP/localvps" "$DIR/localvps"
chmod +x "$DIR/localvps"
echo "已安装 / Installed: $DIR/localvps"

# 加进 PATH，以后新开终端输入 localvps 就能启动
case ":$PATH:" in
  *":$DIR:"*) ;;
  *)
    RC="$HOME/.zshrc"
    case "$SHELL" in */bash) RC="$HOME/.bash_profile" ;; esac
    LINE="export PATH=\"$DIR:\$PATH\""
    if ! grep -qsF "$LINE" "$RC"; then
      printf '\n# localvps\n%s\n' "$LINE" >> "$RC"
      echo "已把 $DIR 加进 PATH（$RC），新开的终端里输入 localvps 就能启动 / Added to PATH in $RC"
    fi
    ;;
esac

echo
exec "$DIR/localvps"
