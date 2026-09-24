#!/bin/sh
set -eu

echo "Installing package dependencies..."
echo "---------------------------------------------------------------"
pacman -Syu --noconfirm

echo "Installing debloated packages..."
echo "---------------------------------------------------------------"
get-debloated-pkgs --add-common --prefer-nano

echo "Staging the unpacked Electron app..."
echo "---------------------------------------------------------------"
mkdir -p ./AppDir/bin
cp -a "${KIMI_DESKTOP_UNPACKED:?set KIMI_DESKTOP_UNPACKED to the electron-builder linux-unpacked dir}"/. ./AppDir/bin/

echo "Recording version..."
echo "${KIMI_VERSION:-unknown}" > ~/version
