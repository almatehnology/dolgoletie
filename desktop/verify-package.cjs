'use strict';

const { createRequire } = require('node:module');
const { realpath, readdir, access, readFile } = require('node:fs/promises');
const { join, relative, isAbsolute, resolve } = require('node:path');
const { protectedResource } = require('./resource-policy.cjs');

async function verifyPackage(resources) {
  const root = await realpath(join(resources, 'next'));
  await access(join(root, 'server.js'));
  const runtimeRequire = createRequire(join(root, 'server.js'));
  const packages = {};
  for (const name of ['next', 'better-sqlite3-multiple-ciphers', 'argon2', 'sharp', '@prisma/client', '.prisma/client/default']) {
    const path = await realpath(runtimeRequire.resolve(name));
    const inside = relative(root, path);
    if (inside.startsWith('..') || isAbsolute(inside)) throw new Error(`Packaged runtime resolves ${name} outside supplied resources`);
    packages[name] = inside;
  }
  await access(join(root, '.next', 'BUILD_ID'));
  await access(join(root, '.next', 'static'));
  const checkSecrets = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (/^\.env(?:\.|$)/iu.test(entry.name)) throw new Error('Packaged runtime contains an environment file');
      if (protectedResource(relative(root, join(dir, entry.name)), true)) {
        throw new Error('Packaged runtime contains a protected data artifact');
      }
      if (entry.isSymbolicLink()) throw new Error('Packaged runtime contains an unresolved symbolic link');
      if (entry.isDirectory()) await checkSecrets(join(dir, entry.name));
    }
  };
  await checkSecrets(root);
  for (const name of ['data', 'uploads']) {
    try { await access(join(root, name)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error(`Packaged runtime contains user ${name}`);
  }
  return { resources: resolve(resources), buildId: (await readFile(join(root, '.next', 'BUILD_ID'), 'utf8')).trim(), packages };
}

async function afterPack(context) {
  const resources = context.electronPlatformName === 'darwin'
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : join(context.appOutDir, 'resources');
  await verifyPackage(resources);
}

module.exports = afterPack;
module.exports.verifyPackage = verifyPackage;
if (require.main === module) verifyPackage(resolve(process.argv[2])).then((result) => console.log(JSON.stringify(result, null, 2)))
  .catch((error) => { console.error(error.message); process.exitCode = 1; });
