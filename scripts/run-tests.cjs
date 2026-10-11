'use strict';

const { readdirSync } = require('node:fs');
const { join, resolve, relative, sep } = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');

const root = resolve(__dirname, '..');

function testFiles(projectRoot = root) {
  const files = readdirSync(join(projectRoot, 'tests'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.ts'))
    .map((entry) => join(projectRoot, 'tests', entry.name));
  if (!files.length) throw new Error('No tests/*.test.ts files found.');
  const desktopTests = readdirSync(join(projectRoot, 'desktop'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.cjs'))
    .map((entry) => join(projectRoot, 'desktop', entry.name));
  if (!desktopTests.length) throw new Error('No desktop/*.test.cjs portability regressions found.');
  return [...files, ...desktopTests].sort();
}

function main(args = process.argv.slice(2)) {
  const files = testFiles();
  if (args.includes('--list')) {
    if (args.length !== 1) throw new Error('--list cannot be combined with test runner options.');
    for (const file of files) console.log(relative(root, file).split(sep).join('/'));
    return 0;
  }
  // Enumerate both suites directly; Windows shell wildcard expansion is not required.
  // A file URL also keeps the tsx loader valid for Windows drive letters/spaces.
  const loader = pathToFileURL(require.resolve('tsx')).href;
  const result = spawnSync(process.execPath, ['--import', loader, '--test', ...args, ...files], {
    cwd: root, env: process.env, stdio: 'inherit', shell: false,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { main, testFiles };
