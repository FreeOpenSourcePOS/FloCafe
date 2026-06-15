/**
 * kill-ports.js
 * Zero-dependency cross-platform port killer.
 * Usage: node kill-ports.js 3001 3002
 */
const { exec } = require('child_process');
const os = require('os');

const ports = process.argv.slice(2);

if (ports.length === 0) {
  console.log('[kill-ports] No ports specified. Usage: node kill-ports.js 3001 3002');
  process.exit(0);
}

const isWindows = os.platform() === 'win32';

function killPort(port) {
  return new Promise((resolve) => {
    const command = isWindows
      ? `FOR /F "tokens=5" %a IN ('netstat -aon ^| findstr ":${port} "') DO @taskkill /F /PID %a 2>nul`
      : `lsof -ti tcp:${port} | xargs kill -9 2>/dev/null`;

    exec(command, { shell: isWindows ? 'cmd.exe' : '/bin/sh' }, (err) => {
      if (err && err.code !== 1) {
        // code 1 just means nothing was using that port — not a real error
        console.log(`[kill-ports] Port ${port} was already free.`);
      } else {
        console.log(`[kill-ports] Cleared port ${port}.`);
      }
      resolve();
    });
  });
}

(async () => {
  for (const port of ports) {
    await killPort(port);
  }
})();
