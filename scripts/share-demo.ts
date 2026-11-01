import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  SHARED_DEMO_PORT,
  assertCredentialFileIsAdvisorOnly,
  createSharedDemoEnvironment,
  createSharedDemoPassword,
  createSharedDemoSnapshot,
  rotateSharedDemoAccounts,
  writePrivateJson,
  writeSharedDemoInvitations,
} from './shared-demo-runtime';

interface SharedDemoStatus {
  state: 'starting' | 'running' | 'stopped' | 'failed';
  runId: string;
  runRoot: string;
  publicUrl?: string;
  appPid?: number;
  tunnelPid?: number;
  launcherPid?: number;
  credentialsPath: string;
  updatedAt: string;
  error?: string;
}

const sourceRoot = resolve(process.cwd());
const sharedRoot = resolve(sourceRoot, 'output', 'shared-demo');
const currentStatusPath = join(sharedRoot, 'current.json');
const cloudflaredPath = process.env.CLOUDFLARED_PATH?.trim() || 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe';

function readStatus(): SharedDemoStatus | null {
  if (!existsSync(currentStatusPath)) return null;
  return JSON.parse(readFileSync(currentStatusPath, 'utf8')) as SharedDemoStatus;
}

function saveStatus(status: SharedDemoStatus): void {
  mkdirSync(sharedRoot, { recursive: true });
  writeFileSync(currentStatusPath, `${JSON.stringify({ ...status, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
  writeFileSync(join(status.runRoot, 'status.json'), `${JSON.stringify({ ...status, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
}

function treeKill(pid: number | undefined): Promise<void> {
  if (!pid || pid === process.pid) return Promise.resolve();
  return new Promise((done) => {
    if (process.platform === 'win32') {
      const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer.once('close', () => done());
      killer.once('error', () => done());
      return;
    }
    try { process.kill(pid, 'SIGTERM'); } catch { /* already stopped */ }
    done();
  });
}

async function stopExisting(): Promise<void> {
  const status = readStatus();
  if (!status) {
    console.log('没有找到 Shared Demo 运行记录。');
    return;
  }
  writeFileSync(join(status.runRoot, 'stop-requested'), `${new Date().toISOString()}\n`, 'utf8');
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const current = readStatus();
    if (current?.state === 'stopped') {
      console.log(`Shared Demo 已停止。保留目录：${status.runRoot}`);
      return;
    }
    await delay(250);
  }
  throw new Error('Shared Demo launcher did not acknowledge the stop request within 20 seconds.');
}

function printStatus(): void {
  const status = readStatus();
  if (!status) {
    console.log('Shared Demo 尚未启动。');
    return;
  }
  console.log(JSON.stringify({
    state: status.state,
    publicUrl: status.publicUrl,
    runRoot: status.runRoot,
    credentialsPath: status.credentialsPath,
    updatedAt: status.updatedAt,
  }, null, 2));
}

function run(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
  onChild?: (child: ChildProcess | undefined) => void,
): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { ...options, stdio: 'inherit', windowsHide: true });
    onChild?.(child);
    child.once('error', reject);
    child.once('exit', (code) => {
      onChild?.(undefined);
      if (code === 0) resolveRun();
      else reject(new Error(`${command} exited with code ${code}.`));
    });
  });
}

function reserveSharedDemoPort(): Promise<Server> {
  return new Promise((resolveReservation, reject) => {
    const reservation = createServer((socket) => socket.destroy());
    reservation.once('error', reject);
    reservation.listen(SHARED_DEMO_PORT, '127.0.0.1', () => {
      reservation.removeListener('error', reject);
      resolveReservation(reservation);
    });
  });
}

function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return Promise.resolve();
  return new Promise((done) => server.close(() => done()));
}

function startTunnel(): Promise<{ child: ChildProcess; publicUrl: string }> {
  if (!existsSync(cloudflaredPath)) throw new Error(`cloudflared not found: ${cloudflaredPath}`);
  const child = spawn(cloudflaredPath, [
    'tunnel', '--no-autoupdate', '--loglevel', 'info', '--url', `http://127.0.0.1:${SHARED_DEMO_PORT}`,
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: createSharedDemoEnvironment({ databasePath: join(sharedRoot, 'unused.sqlite'), bootstrapPassword: createSharedDemoPassword() }) });
  return new Promise((resolveTunnel, reject) => {
    let output = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Timed out waiting for the Cloudflare Quick Tunnel URL.'));
    }, 30_000);
    const inspect = (chunk: Buffer) => {
      output = `${output}${chunk.toString('utf8')}`.slice(-16_384);
      const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (!match) return;
      clearTimeout(timeout);
      resolveTunnel({ child, publicUrl: match[0] });
    };
    child.stdout?.on('data', inspect);
    child.stderr?.on('data', inspect);
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`cloudflared exited before publishing a URL (${code}).`)); });
  });
}

async function waitForLocalApp(child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Shared Demo app exited with code ${child.exitCode}.`);
    let response: Response | undefined;
    try {
      response = await fetch(`http://127.0.0.1:${SHARED_DEMO_PORT}/api/bootstrap`, { redirect: 'manual' });
    } catch { /* application is still starting */ }
    if (response) {
      if (!response.ok) throw new Error(`Shared Demo health check failed with HTTP ${response.status}.`);
      const bootstrap = await response.json() as { sharedDemo?: boolean; capabilities?: { voiceConfigured?: boolean } };
      if (bootstrap.sharedDemo === true && bootstrap.capabilities?.voiceConfigured === false) return;
      throw new Error('Shared Demo health check returned an unsafe runtime mode.');
    }
    await delay(500);
  }
  throw new Error('Shared Demo did not become ready within 30 seconds.');
}

async function start(): Promise<void> {
  const previous = readStatus();
  if (previous?.state === 'running' || previous?.state === 'starting') throw new Error(`Shared Demo is already starting or running: ${previous.publicUrl ?? previous.runRoot}`);
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const runRoot = join(sharedRoot, runId);
  const snapshotRoot = join(runRoot, 'app');
  const databasePath = join(runRoot, 'data', 'shared-demo.sqlite');
  const credentialsPath = join(runRoot, 'tester-credentials.json');
  mkdirSync(join(runRoot, 'data'), { recursive: true });
  const status: SharedDemoStatus = {
    state: 'starting', runId, runRoot, credentialsPath, launcherPid: process.pid, updatedAt: new Date().toISOString(),
  };
  saveStatus(status);
  let app: ChildProcess | undefined;
  let tunnel: ChildProcess | undefined;
  let preparation: ChildProcess | undefined;
  let reservation: Server | undefined;
  let stopping = false;
  const cleanup = async (state: 'stopped' | 'failed', error?: unknown) => {
    if (stopping) return;
    stopping = true;
    clearInterval(stopMonitor);
    await closeServer(reservation);
    await Promise.all([treeKill(preparation?.pid), treeKill(app?.pid), treeKill(tunnel?.pid)]);
    saveStatus({ ...status, state, error: error instanceof Error ? error.message : undefined });
  };
  const stopMonitor = setInterval(() => {
    if (!existsSync(join(runRoot, 'stop-requested'))) return;
    void cleanup('stopped').then(() => process.exit(0));
  }, 250);
  process.once('SIGINT', () => { void cleanup('stopped').then(() => process.exit(0)); });
  process.once('SIGTERM', () => { void cleanup('stopped').then(() => process.exit(0)); });
  try {
    reservation = await reserveSharedDemoPort();
    createSharedDemoSnapshot(sourceRoot, snapshotRoot);
    const bootstrapPassword = createSharedDemoPassword();
    const baseEnv = createSharedDemoEnvironment({ databasePath, bootstrapPassword });
    const nextBin = join(snapshotRoot, 'node_modules', 'next', 'dist', 'bin', 'next');
    await run(process.execPath, [nextBin, 'build', '--webpack'], { cwd: snapshotRoot, env: baseEnv }, (child) => { preparation = child; });
    await run(process.execPath, ['--import', 'tsx', '--eval', "import('./lib/db.ts').then(({db})=>db().close())"], { cwd: snapshotRoot, env: baseEnv }, (child) => { preparation = child; });
    const { testerCredentials } = rotateSharedDemoAccounts(databasePath);
    writePrivateJson(credentialsPath, testerCredentials);
    assertCredentialFileIsAdvisorOnly(credentialsPath);
    const published = await startTunnel();
    tunnel = published.child;
    status.publicUrl = published.publicUrl;
    status.tunnelPid = tunnel.pid;
    const appEnv = createSharedDemoEnvironment({ databasePath, publicOrigin: published.publicUrl, bootstrapPassword });
    const tsxBin = join(snapshotRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    await closeServer(reservation);
    reservation = undefined;
    app = spawn(process.execPath, [tsxBin, 'server.ts', '--production'], {
      cwd: snapshotRoot, env: appEnv, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true,
    });
    status.appPid = app.pid;
    app.once('error', (error) => void cleanup('failed', error));
    await waitForLocalApp(app);
    status.state = 'running';
    saveStatus(status);
    writeSharedDemoInvitations(sharedRoot,published.publicUrl,testerCredentials);
    console.log(`\nShared Demo 已启动：${published.publicUrl}`);
    console.log(`测试账号保存在：${credentialsPath}`);
    console.log('当前为独立合成数据 + mock 模式，不会调用付费 API。');
    console.log('停止命令：npm run share:demo -- --stop');
    await new Promise<void>((resolveWait, reject) => {
      app?.once('exit', (code) => code === 0 ? resolveWait() : reject(new Error(`Shared Demo app exited with code ${code}.`)));
      tunnel?.once('exit', (code) => reject(new Error(`cloudflared exited with code ${code}.`)));
    });
    await cleanup('stopped');
  } catch (error) {
    const stopRequested = existsSync(join(runRoot, 'stop-requested'));
    await cleanup(stopRequested ? 'stopped' : 'failed', stopRequested ? undefined : error);
    if (!stopRequested) throw error;
  }
}

const option = process.argv[2];
if (option === '--stop') await stopExisting();
else if (option === '--status') printStatus();
else await start();
