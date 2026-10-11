'use strict';

const { existsSync, lstatSync, readdirSync, rmSync } = require('node:fs');
const { resolve, join, relative, isAbsolute, sep } = require('node:path');
const { protectedResource } = require('../desktop/resource-policy.cjs');

function sanitizeStandalone(projectRoot = resolve(__dirname, '..'), dist = process.env.TDB_DIST_DIR || '.next') {
  const root = resolve(projectRoot, dist, 'standalone');
  const rel = relative(projectRoot, root);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Standalone output must be inside the project');
  if (!existsSync(root)) throw new Error('Standalone output is missing');
  if (!lstatSync(root).isDirectory() || !existsSync(join(root, 'server.js'))) throw new Error('Invalid standalone output');
  let removed = 0;
  function clean(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filename = join(directory, entry.name);
      if (protectedResource(relative(root, filename), true)) {
        rmSync(filename, { recursive: true, force: true }); removed++;
      } else if (entry.isDirectory()) clean(filename);
    }
  }
  clean(root);
  return removed;
}

if (require.main === module) {
  try { console.log(`Standalone personal-data artifacts removed: ${sanitizeStandalone()}`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { sanitizeStandalone };
