/**
 * kill-ports.js
 * Cross-platform port killer — ONLY kills Flo Desktop processes.
 * Uses an allowlist approach: identifies Flo by process name/cmdline,
 * then kills only those processes that hold the target ports.
 *
 * Usage: node kill-ports.js 3001 3002 3003
 */
const { execSync, exec } = require('child_process');
const os = require('os');

// ── Validate args ───────────────────────────────────────────────────────────
const ports = process.argv.slice(2)
  .map((p) => parseInt(p, 10))
  .filter((p) => Number.isInteger(p) && p >= 1 && p <= 65535);

if (ports.length === 0 && require.main === module) {
  console.log('[kill-ports] No valid ports specified. Usage: node kill-ports.js 3001 3002 3003');
  process.exit(0);
}

const isWindows = os.platform() === 'win32';
const isMac = os.platform() === 'darwin';
const isLinux = os.platform() === 'linux';

// ── Identity: how to recognize a Flo Desktop process ────────────────────────
// These patterns match the process command line on all platforms.
// In dev: `electron .` with app.name = 'flo-desktop'
// Packaged:
//   - Linux: executableName "flocafe" (snap/AppImage/deb binary path)
//   - Mac/Windows: productName "Flo Cafe"
const FLO_PATTERNS = [
  /(?:^|[\s\\/])flocafe(?:\.exe)?(?:$|\s)/i,
  /(?:^|[\s\\/])Flo[\s_\-]*Cafe(?:\.exe)?(?:$|\s)/i,
  /(?:^|[\s\\/])Flo Cafe\.app(?:[\\/]Contents[\\/]MacOS[\\/]Flo Cafe)?(?:$|\s)/i,
  /(?:^|\s)com\.flo\.desktop(?:\.\S*)?(?:$|\s)/i,
  /(?:^|\s)flo[_\-]?pos(?:-service)?(?:\.exe)?(?:$|\s)/i,
  /(?:^|\s)electron(?:\s+\S+)*\s+--appName=flo[_\-]?desktop(?:$|\s)/i,
  /(?:^|\s)(?:node|nodejs)(?:\s+\S+)*[\\/]FloCafe[\\/](?:dev-server\.js|dist[\\/](?:main[\/])?index\.js)(?:$|\s)/i,
  /(?:^|\s)(?:node|nodejs)(?:\s+\S+)*\s+dev-server\.js(?:$|\s)/i,
];

function isFloProcess(cmdline) {
  if (!cmdline) return false;
  return FLO_PATTERNS.some((pat) => pat.test(cmdline));
}

function isValidPid(pid) {
  return typeof pid === 'string' && /^\d+$/.test(pid) && Number(pid) > 0;
}

// ── Find processes on a port (cross-platform) ───────────────────────────────
// Returns Array<{ pid: string, cmdline: string }>
function getProcessesOnPort(port) {
  const results = [];

  if (isWindows) {
    try {
      // netstat gives PIDs listening on the port
      const out = execSync(
        `netstat -aon | findstr "LISTENING" | findstr ":${port} "`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
      );
      const pids = new Set();
      for (const line of out.split('\n')) {
        const m = line.trim().match(/(\d+)\s*$/);
        if (m) pids.add(m[1]);
      }
      for (const pid of pids) {
        if (!isValidPid(pid)) continue;
        let cmdline = '';
        try {
          const cmdOut = execSync(
            `wmic process where "ProcessId=${pid}" get CommandLine / value 2>nul`,
            { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
          );
          const m = cmdOut.match(/CommandLine=(.*)/i);
          cmdline = m?.[1]?.trim() || '';
        } catch { /* WMIC is absent on newer Windows installations. */ }
        if (!cmdline) {
          try {
            cmdline = execSync(
              `powershell.exe -NoProfile -NonInteractive -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine"`,
              { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000 }
            ).trim();
          } catch { /* process metadata is unavailable; fail closed below */ }
        }
        results.push({ pid, cmdline });
      }
    } catch { /* port is free */ }
    return results;
  }

  // Unix: lsof → ss → fuser fallback
  if (hasLsof) {
    try {
      // -F pC: output pid and command name fields
      const out = execSync(
        `lsof -i :${port} -P -n -F pC 2>/dev/null`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
      );
      const pids = new Set();
      for (const line of out.split('\n')) {
        if (line.startsWith('p')) pids.add(line.slice(1));
      }
      for (const pid of pids) {
        if (!isValidPid(pid)) continue;
        const cmdline = getCmdline(pid);
        results.push({ pid, cmdline });
      }
      if (results.length > 0) return results;
    } catch { /* fall through */ }
  }

  if (hasSs) {
    try {
      const out = execSync(
        `ss -tlnp 'sport = :${port}' 2>/dev/null`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
      );
      const pidMatches = [...out.matchAll(/pid=(\d+)/g)];
      for (const m of pidMatches) {
        const pid = m[1];
        if (!isValidPid(pid)) continue;
        const cmdline = getCmdline(pid);
        results.push({ pid, cmdline });
      }
      if (results.length > 0) return results;
    } catch { /* fall through */ }
  }

  if (hasFuser) {
    try {
      const out = execSync(
        `fuser ${port}/tcp 2>/dev/null`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
      );
      for (const pid of out.trim().split(/\s+/)) {
        if (!isValidPid(pid)) continue;
        const cmdline = getCmdline(pid);
        results.push({ pid, cmdline });
      }
    } catch { /* fall through */ }
  }

  return results;
}

// ── Read /proc/<pid>/cmdline (Linux) or ps (macOS) ──────────────────────────
function getCmdline(pid) {
  if (isLinux) {
    try {
      return execSync(
        `cat /proc/${pid}/cmdline 2>/dev/null | tr '\\0' ' '`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
      ).trim();
    } catch { return ''; }
  }
  if (isMac) {
    try {
      return execSync(
        `ps -p ${pid} -o command= 2>/dev/null`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
      ).trim();
    } catch { return ''; }
  }
  return '';
}

// ── Detect available tools on Unix ──────────────────────────────────────────
function hasCommand(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

const hasLsof = !isWindows && hasCommand('lsof');
const hasSs = !isWindows && hasCommand('ss');
const hasFuser = !isWindows && hasCommand('fuser');

// ── Graceful kill: SIGTERM → wait → SIGKILL ─────────────────────────────────
function gracefulKill(pid) {
  return new Promise((resolve) => {
    if (!isValidPid(pid)) return resolve(false);
    // Try SIGTERM first
    exec(`kill ${pid} 2>/dev/null`, { shell: '/bin/sh' }, () => {
      // Wait 2 seconds for graceful shutdown
      setTimeout(() => {
        // Check if still alive
        exec(`kill -0 ${pid} 2>/dev/null`, { shell: '/bin/sh' }, (err) => {
          if (!err) {
            // Still alive — escalate to SIGKILL
            exec(`kill -9 ${pid} 2>/dev/null`, { shell: '/bin/sh' }, (killError) => {
              if (killError) return resolve(false);
              exec(`kill -0 ${pid} 2>/dev/null`, { shell: '/bin/sh' }, (stillAlive) => resolve(Boolean(stillAlive)));
            });
          } else {
            resolve(true);
          }
        });
      }, 2000);
    });
  });
}

function gracefulKillWindows(pid) {
  return new Promise((resolve) => {
    if (!isValidPid(pid)) return resolve(false);
    // taskkill without /F sends WM_CLOSE (graceful)
    exec(`taskkill /PID ${pid} 2>nul`, { shell: 'cmd.exe' }, () => {
      setTimeout(() => {
        exec(`tasklist /FI "PID eq ${pid}" /NH`, { shell: 'cmd.exe' }, (checkError, stdout) => {
          if (checkError || !new RegExp(`\\b${pid}\\b`).test(stdout)) return resolve(true);
          exec(`taskkill /F /PID ${pid} 2>nul`, { shell: 'cmd.exe' }, (killError) => {
            if (killError) return resolve(false);
            exec(`tasklist /FI "PID eq ${pid}" /NH`, { shell: 'cmd.exe' }, (afterError, afterStdout) => {
              resolve(Boolean(afterError) || !new RegExp(`\\b${pid}\\b`).test(afterStdout));
            });
          });
        });
      }, 2000);
    });
  });
}

// ── Kill a port ─────────────────────────────────────────────────────────────
async function killPort(port) {
  const procs = getProcessesOnPort(port);

  if (procs.length === 0) {
    console.log(`[kill-ports] Port ${port} is free.`);
    return;
  }

  const floProcs = procs.filter((p) => isFloProcess(p.cmdline));
  const otherProcs = procs.filter((p) => !isFloProcess(p.cmdline));

  // Report what we found but won't touch
  for (const p of otherProcs) {
    const cmd = p.cmdline || 'unknown process';
    console.log(
      `[kill-ports] Port ${port}: SKIP — PID ${p.pid} (${cmd}) is not a Flo process.`
    );
  }

  if (floProcs.length === 0) {
    console.log(
      `[kill-ports] Port ${port}: no Flo processes found. ${procs.length} other process(es) using this port.`
    );
    return;
  }

  // Kill Flo processes
  for (const p of floProcs) {
    const cmd = p.cmdline || 'electron';
    console.log(`[kill-ports] Port ${port}: killing Flo process PID ${p.pid} (${cmd})...`);
    const stopped = isWindows
      ? await gracefulKillWindows(p.pid)
      : await gracefulKill(p.pid);
    if (stopped) {
      console.log(`[kill-ports] Port ${port}: PID ${p.pid} stopped.`);
    } else {
      console.warn(`[kill-ports] Port ${port}: could not stop PID ${p.pid}.`);
    }
  }
}

// ── Main / Export ───────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    for (const port of ports) {
      await killPort(port);
    }
  })();
} else {
  module.exports = {
    isFloProcess,
    FLO_PATTERNS,
    getProcessesOnPort,
    killPort,
  };
}
