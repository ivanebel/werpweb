'use strict';

const net = require('node:net');
const { Client } = require('ssh2');

/**
 * Opens an SSH connection and starts a local TCP server that forwards every
 * incoming connection to the MySQL host as seen from the SSH server.
 *
 * This is done (instead of using a single forwardOut stream) because mysql2
 * needs a real TCP socket per pooled connection.
 *
 * @returns {Promise<{host:string, port:number, close:()=>Promise<void>}>}
 */
async function createSshTunnel(options) {
  const {
    host,
    port = 22,
    user,
    password,
    privateKey,
    passphrase,
    remoteHost,
    remotePort = 3306,
    keepaliveInterval = 10000,
  } = options;

  const client = new Client();

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.end();
      reject(new Error(`SSH connection to ${host}:${port} timed out`));
    }, 20000);

    client.once('ready', () => {
      clearTimeout(timer);
      resolve();
    });
    client.once('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`SSH connection failed: ${err.message}`));
    });

    client.connect({
      host,
      port,
      username: user,
      password: password || undefined,
      privateKey: privateKey || undefined,
      passphrase: passphrase || undefined,
      keepaliveInterval,
      readyTimeout: 20000,
    });
  });

  const server = net.createServer((socket) => {
    const src = `${socket.remoteAddress || '127.0.0.1'}:${socket.remotePort || 0}`;
    client.forwardOut(src, remotePort, remoteHost, remotePort, (err, stream) => {
      if (err) {
        console.error('[ssh] forwardOut failed:', err.message);
        socket.destroy();
        return;
      }
      socket.pipe(stream).pipe(socket);
      socket.on('error', () => stream.destroy());
      stream.on('error', () => socket.destroy());
      socket.on('close', () => stream.destroy());
      stream.on('close', () => socket.destroy());
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  console.log(`[ssh] tunnel ready: 127.0.0.1:${address.port} -> ${remoteHost}:${remotePort} via ${user}@${host}`);

  const close = () =>
    new Promise((resolve) => {
      server.close(() => {
        client.end();
        resolve();
      });
      // Do not wait forever for sockets that never drain.
      setTimeout(() => {
        client.end();
        resolve();
      }, 1500).unref();
    });

  return { host: '127.0.0.1', port: address.port, close };
}

module.exports = { createSshTunnel };
