'use strict';

const { sep } = require('node:path');

// Apply to relative resource names only. Compiled app routes named data stay valid.
function protectedResource(path, excludeRootData = false) {
  const parts = path.split(sep).map((part) => part.toLowerCase());
  return (excludeRootData && ['data', 'uploads'].includes(parts[0])) ||
    parts.some((part) => /^\.env(?:\.|$)/u.test(part) || part === '.git' ||
      /\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm|journal))?$/u.test(part) ||
      /\.(?:zip|tdbsync|tdbbackup)$/u.test(part) ||
      /^(?:auth|vault|instance|credential-transition|storage-transition)\.json(?:[.-]|$)/u.test(part) ||
      part === 'pending-access' || part === 'vaults') ||
    parts.some((part, index) => part === 'prisma' && parts[index + 1] === 'data');
}

module.exports = { protectedResource };
