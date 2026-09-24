#!/bin/sh
set -eu

ARCH=$(uname -m)
export ARCH
export OUTPATH=./dist
export OUTNAME=kimi-code-"$ARCH".AppImage
export ICON=./kimi-code.png
export DESKTOP=./kimi-code.desktop
# Node SEA binaries lose their dynamic section when stripped.
export NO_STRIP=binaries

quick-sharun "${KIMI_SEA:?set KIMI_SEA to the built kimi SEA binary}"

quick-sharun --make-appimage
