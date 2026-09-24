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
# (Electron does not). Without both, fontconfig cannot resolve "sans" or
# "monospace" on a host that has no working fontconfig of its own, and Chromium
# draws the UI with no text at all.
mkdir -p ./AppDir/etc/fonts/conf.d ./AppDir/share/fonts
cp -rL /etc/fonts/conf.d/. ./AppDir/etc/fonts/conf.d/
find /usr/share/fonts -type f -name 'DejaVu*' -exec cp -a {} ./AppDir/share/fonts/ \;
cp ./fonts.conf ./AppDir/etc/fonts/fonts.conf
cp ./10-fontconfig.hook ./AppDir/bin/

quick-sharun --make-appimage
