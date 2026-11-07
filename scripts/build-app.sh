#!/bin/sh
# 打包 Mac App：release/localvps-macos.dmg（通用版，内含 Apple 芯片和 Intel 两份服务程序）
#   签名：钥匙串里的 Developer ID Application 证书（SIGN_ID 可覆盖）
#   公证：App Store Connect API 密钥，需要 ASC_KEY_ID、ASC_ISSUER_ID，密钥文件在 ~/.appstoreconnect/private_keys/
#   不公证：NOTARIZE=0 sh scripts/build-app.sh
set -e
cd "$(dirname "$0")/.."

VERSION=$(node -p 'require("./package.json").version')
SIGN_ID=${SIGN_ID:-$(security find-identity -v -p codesigning | grep -m1 "Developer ID Application" | sed -E 's/.*"(.*)"/\1/')}
[ -n "$SIGN_ID" ] || { echo "钥匙串里没有 Developer ID Application 证书"; exit 1; }
OUT=release/app
APP=$OUT/localvps.app
rm -rf "$OUT" && mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# 服务程序：和命令行版是同一个
npm run build:bin
cp release/localvps-macos-arm64 "$APP/Contents/Resources/localvps-arm64"
cp release/localvps-macos-x64 "$APP/Contents/Resources/localvps-x64"

# 外壳：Swift 编两种芯片再合成一个
for arch in arm64 x86_64; do
  swiftc -O -target "$arch-apple-macos13" -o "$OUT/shell-$arch" app/LocalVPS.swift
done
lipo -create "$OUT/shell-arm64" "$OUT/shell-x86_64" -output "$APP/Contents/MacOS/localvps"
rm "$OUT"/shell-*
sed "s/__VERSION__/$VERSION/g" app/Info.plist > "$APP/Contents/Info.plist"

# 图标
ICONSET=$OUT/AppIcon.iconset
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s docs/images/icon.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) docs/images/icon.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
rm -rf "$ICONSET"

# 签名：先里后外
for f in "$APP/Contents/Resources/localvps-arm64" "$APP/Contents/Resources/localvps-x64"; do
  codesign --force --timestamp --options runtime --entitlements app/server.entitlements --sign "$SIGN_ID" "$f"
done
codesign --force --timestamp --options runtime --sign "$SIGN_ID" "$APP"
codesign --verify --strict --deep "$APP"

notarize() {
  xcrun notarytool submit "$1" --key "$HOME/.appstoreconnect/private_keys/AuthKey_$ASC_KEY_ID.p8" \
    --key-id "$ASC_KEY_ID" --issuer "$ASC_ISSUER_ID" --wait
}
if [ "${NOTARIZE:-1}" = 1 ]; then
  [ -n "$ASC_KEY_ID" ] && [ -n "$ASC_ISSUER_ID" ] || { echo "公证要 ASC_KEY_ID、ASC_ISSUER_ID；不公证用 NOTARIZE=0"; exit 1; }
  ditto -c -k --keepParent "$APP" "$OUT/notarize.zip"
  notarize "$OUT/notarize.zip"
  rm "$OUT/notarize.zip"
  xcrun stapler staple "$APP"
fi

# 磁盘映像：拖进「应用程序」
DMG=release/localvps-macos.dmg
STAGE=$OUT/dmg
mkdir -p "$STAGE" && cp -R "$APP" "$STAGE/" && ln -s /Applications "$STAGE/应用程序"
rm -f "$DMG"
hdiutil create -volname "localvps" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGE"
codesign --force --timestamp --sign "$SIGN_ID" "$DMG"
if [ "${NOTARIZE:-1}" = 1 ]; then
  notarize "$DMG"
  xcrun stapler staple "$DMG"
fi
echo "已生成 $DMG（$VERSION）"
