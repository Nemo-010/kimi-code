// Shared description of what a complete fork release contains.
// Used by tools/fork/validate-artifacts.mjs (before publishing) and
// tools/fork/verify-release.mjs (after publishing).

export const NATIVE_TARGETS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64', 'win32-arm64'];

export const APPIMAGE_ARCHES = ['x86_64', 'aarch64'];

export const MIN_NATIVE_ZIP = 20 * 1024 * 1024;
export const MIN_SHA = 32;
export const MIN_APPIMAGE = 10 * 1024 * 1024;
export const MIN_DESKTOP_APPIMAGE = 40 * 1024 * 1024;
export const MIN_DESKTOP_INSTALLER = 20 * 1024 * 1024;

// Every desktop artifact carries its platform, because `${arch}` alone made a
// macOS `Kimi-Code-Desktop-2.1.0-x64.zip` look like a Linux portable build.
export const DESKTOP_PLATFORMS = [
  { label: 'macOS installer', pattern: /^Kimi-Code-Desktop-.+-macos-.+\.(dmg|zip)$/ },
  { label: 'Windows installer', pattern: /^Kimi-Code-Desktop-.+-windows-.+\.exe$/ },
  { label: 'Linux portable zip', pattern: /^Kimi-Code-Desktop-.+-linux-.+\.zip$/ },
  { label: 'Linux package', pattern: /^Kimi-Code-Desktop-.+-linux-.+\.deb$/ },
];

export function expectedAssets() {
  const expected = [];
  for (const target of NATIVE_TARGETS) {
    expected.push({ name: `kimi-code-${target}.zip`, min: MIN_NATIVE_ZIP });
    expected.push({ name: `kimi-code-${target}.zip.sha256`, min: MIN_SHA });
  }
  for (const arch of APPIMAGE_ARCHES) {
    expected.push({ name: `kimi-code-${arch}.AppImage`, min: MIN_APPIMAGE });
    expected.push({ name: `Kimi-Code-Desktop-${arch}.AppImage`, min: MIN_DESKTOP_APPIMAGE });
  }
  return expected;
}

/** Asset names matching each platform, in `DESKTOP_PLATFORMS` order. */
export function desktopAssetsByPlatform(names) {
  return DESKTOP_PLATFORMS.map((platform) => ({
    ...platform,
    names: names.filter((name) => platform.pattern.test(name)),
  }));
}

/**
 * Desktop artifacts that match no platform at all — for example the old
 * `Kimi-Code-Desktop-2.1.0-x64.zip`, which was the macOS auto-update zip and
 * looked like a Linux build. These are leftovers from an earlier naming scheme
 * and must not stay on a release.
 */
export function unexpectedDesktopAssets(names) {
  return names.filter(
    (name) =>
      name.startsWith('Kimi-Code-Desktop-') &&
      !name.endsWith('.AppImage') &&
      !DESKTOP_PLATFORMS.some((platform) => platform.pattern.test(name)),
  );
}

export function hostAppImageArch(arch = process.arch) {
  return arch === 'arm64' ? 'aarch64' : 'x86_64';
}
