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

export function desktopInstallerPattern() {
  return /^Kimi-Code-Desktop-.+\.(dmg|zip|exe|deb)$/;
}

export function hostAppImageArch(arch = process.arch) {
  return arch === 'arm64' ? 'aarch64' : 'x86_64';
}
