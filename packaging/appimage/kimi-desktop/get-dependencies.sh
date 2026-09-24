#!/bin/sh
set -eu

echo "Installing package dependencies..."
echo "---------------------------------------------------------------"
pacman -Syu --noconfirm

echo "Installing debloated packages..."
echo "---------------------------------------------------------------"
get-debloated-pkgs --add-common --prefer-nano

# Fonts for the bundled fallback fontconfig. DejaVu covers Latin/Greek/Cyrillic
# and Noto covers the CJK the UI is localised into; a host whose own fontconfig
# works never reads either (see src/main/index.ts, configureFonts).
echo "Installing fonts for the bundled fontconfig..."
echo "---------------------------------------------------------------"
pacman -S --noconfirm --needed ttf-dejavu noto-fonts noto-fonts-cjk

echo "Staging the unpacked Electron app..."
echo "---------------------------------------------------------------"
mkdir -p ./AppDir/bin
cp -a "${KIMI_DESKTOP_UNPACKED:?set KIMI_DESKTOP_UNPACKED to the electron-builder linux-unpacked dir}"/. ./AppDir/bin/

echo "Recording version..."
echo "${KIMI_VERSION:-unknown}" > ~/version
