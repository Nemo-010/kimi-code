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

quick-sharun --make-appimage
