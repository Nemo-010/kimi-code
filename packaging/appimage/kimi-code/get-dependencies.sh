#!/bin/sh
set -eu

echo "Installing package dependencies..."
echo "---------------------------------------------------------------"
pacman -Syu --noconfirm base-devel strace

echo "Recording version..."
echo "${KIMI_VERSION:-unknown}" > ~/version
