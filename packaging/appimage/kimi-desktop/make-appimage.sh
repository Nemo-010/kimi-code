#!/bin/sh
set -eu

ARCH=$(uname -m)
export ARCH
export OUTPATH=./dist
export OUTNAME=Kimi-Code-Desktop-"$ARCH".AppImage
export ICON=./kimi-desktop.png
export DESKTOP=./kimi-desktop.desktop
export ADD_HOOKS="fix-namespaces.hook"
# Node SEA binaries lose their dynamic section when stripped.
export NO_STRIP=binaries

quick-sharun ./AppDir/bin/kimi-desktop

# quick-sharun copies /etc/fonts/fonts.conf but not its conf.d rules, and it
# only bundles /usr/share/fonts when a deployed binary hardcodes that path
# (Electron does not). Without both, a host that has no working fontconfig of
# its own cannot resolve "sans" or "monospace" and Chromium draws the UI with
# no text at all. src/main/index.ts only uses these when /etc/fonts/fonts.conf
# is missing.
mkdir -p ./AppDir/etc/fonts/conf.d ./AppDir/share/fonts
cp -rL /etc/fonts/conf.d/. ./AppDir/etc/fonts/conf.d/
find /usr/share/fonts -type f \( -name 'DejaVu*.ttf' -o -name 'NotoSans*.ttf' \) \
  -exec cp -a {} ./AppDir/share/fonts/ \;
cp ./fonts.conf ./AppDir/etc/fonts/fonts.conf
cp ./10-fontconfig.hook ./AppDir/bin/

quick-sharun --make-appimage

# The runtime is only stable if the bundled rules and the bundled fonts are
# actually inside the image; a missing conf.d is the failure that shipped once.
echo "Verifying the AppImage layout..."
echo "---------------------------------------------------------------"
./dist/Kimi-Code-Desktop-*.AppImage --appimage-extract >/dev/null
test -d squashfs-root/etc/fonts/conf.d
test -n "$(ls -A squashfs-root/share/fonts)"
test -f squashfs-root/bin/10-fontconfig.hook
grep -q "kimi-browser" squashfs-root/bin/resources/app.asar 2>/dev/null ||
  grep -q "kimi-browser" squashfs-root/bin/resources/app.asar.unpacked/* 2>/dev/null ||
  echo "warning: could not confirm the preload bundle inside app.asar"
rm -rf squashfs-root
