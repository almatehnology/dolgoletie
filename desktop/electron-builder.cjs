'use strict';

module.exports = {
  appId: 'com.traveldatabase.desktop',
  productName: 'TravelDataBase',
  extraMetadata: { main: 'main.cjs' },
  asar: true,
  npmRebuild: false,
  afterPack: './desktop/verify-package.cjs',
  directories: { app: 'desktop/stage/app', output: 'desktop/dist' },
  files: ['*.cjs', 'package.json', '!node_modules/**'],
  extraResources: [
    { from: 'desktop/stage/next', to: 'next', filter: ['**/*', '!**/.env', '!**/.env.*'] },
    // Builder's file filter prunes a root node_modules directory even for extraResources.
    // Give it its own source root so traced native/transitive files actually ship.
    { from: 'desktop/stage/next/node_modules', to: 'next/node_modules', filter: ['**/*', '!**/.env', '!**/.env.*'] },
  ],
  mac: { target: ['dmg'], hardenedRuntime: true, category: 'public.app-category.productivity' },
  win: { target: ['nsis'] },
  nsis: { oneClick: false, allowToChangeInstallationDirectory: false, deleteAppDataOnUninstall: false, include: 'desktop/installer.nsh' },
};
