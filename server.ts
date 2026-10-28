import { createServer } from 'node:http';
import nextEnv from '@next/env';
import next from 'next';
import { attachVoiceServer, type VoiceHooks } from './lib/voice-server';
import { acquireRuntimeLock } from './lib/runtime-lock';

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const production = process.argv.includes('--production') || process.env.NODE_ENV === 'production';
const port = Number.parseInt(process.env.PORT || '3000', 10);
const hostname = process.env.HOST?.trim() || '127.0.0.1';
const loopback = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';

if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PORT must be a valid TCP port.');
if (!loopback) {
  const password = process.env.DEMO_PASSWORD || '';
  if (process.env.ALLOW_NETWORK_DEMO !== 'true') throw new Error('Network binding requires ALLOW_NETWORK_DEMO=true.');
  if (password.length < 16 || password === 'AeconnDemo!2026') throw new Error('Network binding requires a custom DEMO_PASSWORD of at least 16 characters.');
  if (!process.env.HTTPS_PROXY_ORIGIN?.startsWith('https://')) throw new Error('Network binding requires a trusted HTTPS_PROXY_ORIGIN.');
}

const app = next({ dev: !production, hostname, port });
const releaseRuntimeLock=acquireRuntimeLock(process.env.DATABASE_PATH||'./data/aeconn.sqlite');
process.once('exit',releaseRuntimeLock);
const handle = app.getRequestHandler();

await app.prepare();
const serviceModulePath = './lib/service';
const serviceModule = await import(serviceModulePath) as { voiceHooks?: VoiceHooks; startReportWorker:()=>void };
if (!serviceModule.voiceHooks) throw new Error('lib/service.ts must export voiceHooks.');
const server = createServer((request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'same-origin');
  void handle(request, response);
});
attachVoiceServer(server, serviceModule.voiceHooks);
serviceModule.startReportWorker();

server.listen(port, hostname, () => {
  console.log(`Aeconn Demo: http://${hostname}:${port} (${production ? 'production' : 'development'})`);
  if (!loopback) console.log(`Public browser origin: ${process.env.HTTPS_PROXY_ORIGIN}`);
});
