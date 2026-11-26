// Shared harness for the pizza headless-kit suites: free ports, a throwaway HOME and data
// folder, the standalone server under plain Node, and the kit's scripts.
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

export const repoRoot = path.resolve(__dirname, '..', '..');
export const kitDir = path.join(repoRoot, 'scripts', 'pizza', 'headless');

const children = new Set<ChildProcess>();
const scratchDirs: string[] = [];
process.on('exit', () => {
  for (const child of children) child.kill('SIGKILL');
  for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true });
});

export function scratchDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

// Stands in for systemctl so the kit never sees this machine's real user services. It reports
// the units named in FAKE_SYSTEMCTL_ACTIVE as active and every other unit as inactive.
const FAKE_SYSTEMCTL = `#!/bin/sh
status=3
for arg in "$@"; do
  case "$arg" in --*|is-active) continue ;; esac
  case " $FAKE_SYSTEMCTL_ACTIVE " in
    *" $arg "*) echo active; status=0 ;;
    *) echo inactive ;;
  esac
done
exit $status
`;

export async function freePorts(count: number): Promise<number[]> {
  const servers = await Promise.all(
    Array.from(
      { length: count },
      () =>
        new Promise<net.Server>((resolve, reject) => {
          const server = net.createServer();
          server.once('error', reject);
          server.listen(0, '0.0.0.0', () => resolve(server));
        }),
    ),
  );
  const ports = servers.map((server) => (server.address() as net.AddressInfo).port);
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  return ports;
}

/** Holds a port the way a stranger would, so the server has to move off it. */
export function occupyPort(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.destroy());
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => resolve(server));
  });
}

export type HeadlessEnv = NodeJS.ProcessEnv & {
  PORT: string;
  KDS_PORT: string;
  SERVER_APP_PORT: string;
  FLO_DEV_USER_DATA: string;
};

export async function headlessEnv(extra: Record<string, string> = {}): Promise<HeadlessEnv> {
  const [api, kds, serverApp] = await freePorts(3);
  const scratch = scratchDir('flo-pizza-headless-');
  const home = path.join(scratch, 'home');
  const data = path.join(scratch, 'data');
  const bin = path.join(scratch, 'bin');
  fs.mkdirSync(home);
  fs.mkdirSync(data);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'systemctl'), FAKE_SYSTEMCTL, { mode: 0o755 });
  return {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    FAKE_SYSTEMCTL_ACTIVE: '',
    HOME: home,
    PORT: String(api),
    KDS_PORT: String(kds),
    SERVER_APP_PORT: String(serverApp),
    FLO_DEV_USER_DATA: data,
    ...extra,
  };
}

export function liveDbPath(env: HeadlessEnv): string {
  return path.join(env.FLO_DEV_USER_DATA, 'flo.db');
}

export function backupDir(env: HeadlessEnv): string {
  return path.join(env.FLO_DEV_USER_DATA, 'headless-backups');
}

/** The app's own database module, loaded without Electron, for its health predicate. */
export function appDb(): typeof import('../../main/db') {
  const Module = require('node:module');
  const originalLoad = Module._load;
  const scratch = scratchDir('flo-pizza-headless-appdb-');
  Module._load = function (request: string, ...rest: unknown[]) {
    if (request === 'electron')
      return { app: { isPackaged: true, getPath: () => scratch, getVersion: () => 'test' } };
    return originalLoad.call(this, request, ...rest);
  };
  return require('../../main/db');
}

export type HeadlessServer = { output: () => string; stop: () => Promise<void> };

/** Starts the server the way the unit does: through the kit's launcher, which holds the lock. */
export async function startHeadless(env: HeadlessEnv, kit = kitDir): Promise<HeadlessServer> {
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(process.execPath, [path.join(kit, 'serve.cjs')], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let output = '';
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
      await exited;
      clearTimeout(timer);
    }
    children.delete(child);
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 30_000);
      const collect = (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes('Server App running')) {
          clearTimeout(timer);
          resolve();
        }
      };
      child.stdout!.on('data', collect);
      child.stderr!.on('data', collect);
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`server exited before ready (${code ?? signal}):\n${output}`));
      });
    });
  } catch (error) {
    await stop();
    throw error;
  }
  return { output: () => output, stop };
}

/** A process that holds the data folder's lock as the service (shared) or a restore (exclusive) does. */
export function holdLock(
  env: HeadlessEnv,
  mode: 'shared' | 'exclusive',
): Promise<{ kill: (signal?: NodeJS.Signals) => Promise<void> }> {
  const script = `require(${JSON.stringify(path.join(kitDir, 'common.cjs'))}).dataLock(process.env.FLO_DEV_USER_DATA, ${JSON.stringify(mode)}); console.log('held'); setInterval(() => {}, 1000);`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(child);
    const exited = new Promise<void>((done) => child.once('exit', () => done()));
    let output = '';
    const collect = (chunk: Buffer) => {
      output += chunk;
      if (output.includes('held'))
        resolve({
          kill: async (signal = 'SIGTERM') => {
            child.kill(signal);
            await exited;
            children.delete(child);
          },
        });
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('exit', () => reject(new Error(`the lock holder exited: ${output}`)));
  });
}

export type KitResult = { status: number | null; stdout: string; stderr: string; output: string };

/** Runs a kit script with plain Node, asynchronously so the caller can keep writing meanwhile. */
export function runKit(script: string, args: string[], env: HeadlessEnv): Promise<KitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(kitDir, script), ...args], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.once('error', reject);
    child.once('close', (status) => {
      clearTimeout(timer);
      children.delete(child);
      resolve({ status, stdout, stderr, output: stdout + stderr });
    });
  });
}

/** Runs each case, reports every failure, and exits non-zero if any failed. */
export async function runCases(title: string, cases: Array<[string, () => Promise<void>]>) {
  console.log(title);
  console.log('='.repeat(60));
  const failed: string[] = [];
  for (const [name, run] of cases) {
    console.log(`\n--- ${name} ---`);
    try {
      await run();
    } catch (error: any) {
      failed.push(name);
      console.error(`  case failed: ${error?.stack ?? error}`);
    }
  }
  console.log(`\n${cases.length - failed.length}/${cases.length} cases passed`);
  if (failed.length > 0) {
    console.error(`Failed: ${failed.join('; ')}`);
    process.exit(1);
  }
  process.exit(0);
}
