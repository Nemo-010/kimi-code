'use strict';

// electron-builder configuration.
//
// Signing / notarization are environment-driven so the same config produces
// either an unsigned local build or a fully signed + notarized distributable:
//
//   unsigned (default / local):
//     CSC_IDENTITY_AUTO_DISCOVERY=false  -> no signing, no notarization
//
//   signed + notarized (CI, with a Developer ID cert in the keychain):
//     KIMI_DESKTOP_NOTARIZE=true
//     APPLE_API_KEY=<path to .p8>  APPLE_API_KEY_ID=<id>  APPLE_API_ISSUER=<id>
//
// The entitlements (hardened runtime) are applied to the app AND every nested
// Mach-O — including the bundled Kimi SEA backend — via entitlementsInherit, so
// the whole bundle passes notarization.

const notarize = process.env.KIMI_DESKTOP_NOTARIZE === 'true';

module.exports = {
  appId: 'ai.moonshot.kimi.desktop',
  productName: 'Kimi Code Desktop',
  executableName: 'kimi-desktop',
  copyright: 'Copyright © Moonshot AI',

  directories: {
    output: 'dist-app',
  },

  // No native node modules in the Electron app itself; the backend is the
  // prebuilt SEA staged by before-pack.cjs.
  npmRebuild: false,
  asar: true,

  files: ['out/**', 'package.json'],

  beforePack: './scripts/before-pack.cjs',
  extraResources: [{ from: 'resources-stage/bin', to: 'bin' }],

  mac: {
    category: 'public.app-category.developer-tools',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    target: ['dmg', 'zip'],
    artifactName: 'Kimi-Code-Desktop-${version}-macos-${arch}.${ext}',
    notarize,
  },

  win: {
    target: ['nsis'],
    artifactName: 'Kimi-Code-Desktop-${version}-windows-${arch}.${ext}',
  },

  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
  },

  linux: {
    category: 'Development',
    // The truly portable AppImage is produced by quick-sharun from the
    // `--dir` output (see packaging/appimage), so electron-builder makes the
    // .deb and a no-install zip here. The zip needs the distro's GTK/NSS at
    // runtime; the AppImage is the one that carries its own libraries.
    target: ['deb', 'zip'],
    artifactName: 'Kimi-Code-Desktop-${version}-linux-${arch}.${ext}',
    maintainer: 'Moonshot AI',
  },
};
