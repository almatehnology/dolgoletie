'use strict';

const http = require('node:http');
const { timingSafeEqual } = require('node:crypto');
const { validOrigin } = require('./validation.cjs');
const TOKEN_HEADER = 'x-tdb-desktop-token';

function trustedRequest(request, origin, token) {
  if (!validOrigin(origin) || !/^[a-f0-9]{64}$/u.test(token || '')) return false;
  const headers = request.headers;
  const supplied = headers[TOKEN_HEADER];
  if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/u.test(supplied) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) return false;
  if (headers.host !== new URL(origin).host || (headers.origin && headers.origin !== origin)) return false;
  if (request.socket.remoteAddress !== '127.0.0.1') return false;
  if (typeof request.url !== 'string' || !request.url.startsWith('/') || request.url.startsWith('//') || request.url.length > 8192) return false;
  const counts = new Map();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index].toLowerCase();
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [TOKEN_HEADER, 'host', 'origin'].every((name) => (counts.get(name) || 0) <= 1);
}

/** Installed only in the dedicated standalone worker, before server.js is required. */
function installServerBoundary(token, onListening) {
  if (!/^[a-f0-9]{64}$/u.test(token || '')) throw new Error('Desktop launch token is missing');
  const originalEmit = http.Server.prototype.emit;
  const originalListen = http.Server.prototype.listen;
  const servers = new Set();
  let origin;

  http.Server.prototype.listen = function () {
    if (servers.size) throw new Error('Desktop supports exactly one HTTP server');
    servers.add(this);
    // Next 15 reads the actual bound port from server.address() before creating handlers.
    // Binding port 0 here removes the reserve/close/rebind race completely.
    return originalListen.call(this, { port: 0, host: '127.0.0.1', exclusive: true });
  };
  http.Server.prototype.emit = function (event, ...args) {
    if (event === 'listening' && servers.has(this)) {
      const address = this.address();
      if (!address || typeof address === 'string' || address.address !== '127.0.0.1') throw new Error('Non-loopback server refused');
      origin = `http://127.0.0.1:${address.port}`;
      process.env.DESKTOP_ORIGIN = origin;
      onListening(origin);
    }
    if (event === 'upgrade') {
      args[1].destroy(); // Production standalone has no reason to accept WebSocket upgrades.
      return false;
    }
    if (event === 'request' && !trustedRequest(args[0], origin, token)) {
      args[1].writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'close' });
      args[1].end('Forbidden');
      return false;
    }
    return originalEmit.call(this, event, ...args);
  };

  return {
    async close() {
      await Promise.all(Array.from(servers, (server) => new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      })));
    },
    restore() {
      http.Server.prototype.emit = originalEmit;
      http.Server.prototype.listen = originalListen;
    },
  };
}

module.exports = { TOKEN_HEADER, trustedRequest, installServerBoundary };
