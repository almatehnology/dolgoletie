'use strict';

const { cp, mkdir, rm, access, readFile, writeFile, realpath } = require('node:fs/promises');
const { join, relative, sep, basename, resolve, isAbsolute } = require('node:path');
const { protectedResource } = require('./resource-policy.cjs');
const root = join(__dirname, '..');

const shellFiles = ['main.cjs', 'preload.cjs', 'files.cjs', 'validation.cjs', 'runtime.cjs', 'server-worker.cjs', 'server-boundary.cjs', 'lifecycle.cjs'];

async function copyResources(source, destination, excludeUserData = false) {
  const lexicalRoot = resolve(source);
  const realRoot = await realpath(source);
  const allowed = (root, path) => {
    const inside = relative(root, path);
    if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return false;
    return !protectedResource(inside, excludeUserData);
  };
  await cp(source, destination, {
    recursive: true,
    // Ship ordinary files, avoiding Windows symlink privileges and source-path links.
    dereference: true,
    filter: async (path) => {
      if (!allowed(lexicalRoot, resolve(path))) return false;
      const target = await realpath(path);
      const inside = relative(realRoot, target);
      if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
        throw new Error('Desktop resource link resolves outside its source directory');
      }
      return allowed(realRoot, target);
    },
  });
}

async function standaloneSource(projectRoot) {
  const source = join(projectRoot, '.next', 'standalone');
  try { await access(join(source, 'server.js')); return source; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Next can nest the project when tracing uses a surrounding workspace root.
  // Accept only this project's directory, never an arbitrary sibling build.
  const nested = join(source, basename(projectRoot));
  await access(join(nested, 'server.js'));
  return nested;
}

async function prepare(projectRoot = root, target = join(__dirname, 'stage')) {
  const source = await standaloneSource(projectRoot);
  const destination = join(target, 'next');
  await access(join(projectRoot, '.next', 'static'));
  const metadata = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await copyResources(source, destination, true);
  await copyResources(join(projectRoot, '.next', 'static'), join(destination, '.next', 'static'));
  for (const folder of ['public', 'assets', 'prisma/migrations']) {
    const path = join(projectRoot, folder);
    try { await access(path); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    await copyResources(path, join(destination, folder));
  }
  // Builder always collects the app package's production dependencies. The shell
  // needs only Electron/builtins; all server dependencies belong to resources/next.
  const shell = join(target, 'app');
  await rm(shell, { recursive: true, force: true });
  await mkdir(shell, { recursive: true });
  for (const file of shellFiles) await cp(join(__dirname, file), join(shell, file));
  await writeFile(join(shell, 'package.json'), JSON.stringify({
    name: 'traveldatabase-desktop', version: metadata.version, private: true,
    description: 'TravelDataBase desktop application', main: 'main.cjs', dependencies: {},
  }, null, 2) + '\n');
  return { source, destination, shell };
}

if (require.main === module) prepare().then(({ source }) => {
  console.log(`Desktop standalone prepared from ${relative(root, source)}. Native runtime and platform acceptance remain required.`);
}).catch((error) => { console.error(error.message); process.exitCode = 1; });

module.exports = { prepare, standaloneSource, shellFiles };
