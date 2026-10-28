import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { attachVoiceServer, closeVoiceSession, hasVoiceSession, type VoiceHooks } from '../lib/voice-server';

function waitForClose(socket: WebSocket) {
  return new Promise<{ code: number; reason: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket did not close')), 2_000);
    socket.on('close', (code, reason) => { clearTimeout(timer); resolve({ code, reason: reason.toString() }); });
    socket.on('error', () => undefined);
  });
}

function waitUntil(check: () => boolean, timeoutMs = 2_000) {
  return new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (check()) { clearInterval(timer); resolve(); }
      else if (Date.now() - started > timeoutMs) { clearInterval(timer); reject(new Error('Timed out waiting for condition')); }
    }, 5);
  });
}

test('voice relay consumes one-use token but fails clearly when provider is unconfigured', async () => {
  const oldKey = process.env.GEMINI_API_KEY;
  const oldModel = process.env.GEMINI_LIVE_MODEL;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_LIVE_MODEL;
  let consumed = 0;
  const hooks: VoiceHooks = {
    consumeToken: (token) => { consumed += 1; return token === 'one-use' ? { sessionId: 's1', caseId: 'c1' } : null; },
    isActive: () => true,
    persist: () => undefined,
    status: () => undefined,
  };
  const server = createServer();
  const relay = attachVoiceServer(server, hooks);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/voice?token=one-use`, { headers: { Origin: `http://127.0.0.1:${address.port}` } });
  const events: string[] = [];
  socket.on('message', (data) => events.push(data.toString()));
  const closed = await waitForClose(socket);
  assert.equal(consumed, 1);
  assert.equal(closed.code, 1013);
  assert(events.some((value) => value.includes('实时语音未配置')));
  assert.equal(hasVoiceSession('s1'), false);
  assert.deepEqual(await closeVoiceSession('s1'), { timedOut: false });
  await relay.close();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (oldKey) process.env.GEMINI_API_KEY = oldKey;
  if (oldModel) process.env.GEMINI_LIVE_MODEL = oldModel;
});

test('voice relay rejects cross-origin browser upgrades before consuming a token', async () => {
  let consumed = 0;
  const hooks: VoiceHooks = {
    consumeToken: () => { consumed += 1; return { sessionId: 's2', caseId: 'c2' }; },
    isActive: () => true,
    persist: () => undefined,
    status: () => undefined,
  };
  const server = createServer();
  const relay = attachVoiceServer(server, hooks);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/voice?token=x`, { headers: { Origin: 'https://attacker.example' } });
  await waitForClose(socket);
  assert.equal(consumed, 0);
  await relay.close();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test('voice relay locks setup, persists final turns, forwards audio, and drains before close', async () => {
  const oldKey = process.env.GEMINI_API_KEY;
  const oldModel = process.env.GEMINI_LIVE_MODEL;
  const oldProvider = process.env.VOICE_PROVIDER;
  process.env.VOICE_PROVIDER = 'gemini';
  process.env.GEMINI_API_KEY = 'test-only-key';
  process.env.GEMINI_LIVE_MODEL = 'test-live-model';

  const upstream = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => upstream.once('listening', resolve));
  const upstreamAddress = upstream.address();
  assert(upstreamAddress && typeof upstreamAddress !== 'string');
  const upstreamMessages: Record<string, unknown>[] = [];
  let respondToAudioEnd = true;
  upstream.on('connection', (socket) => {
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      upstreamMessages.push(message);
      if (message.setup) socket.send(JSON.stringify({ setupComplete: {} }));
      const realtime = message.realtimeInput as { audioStreamEnd?: boolean } | undefined;
      if (realtime?.audioStreamEnd && respondToAudioEnd) socket.send(JSON.stringify({ serverContent: { turnComplete: true } }));
    });
  });

  const persisted: Array<{ eventId: string; turnId: string; role: string; text: string }> = [];
  const statuses: string[] = [];
  const hooks: VoiceHooks = {
    consumeToken: (token) => ['live-token', 'live-token-2'].includes(token) ? { sessionId: 'live-session', caseId: 'case-1' } : null,
    isActive: () => true,
    persist: (_session, event) => { persisted.push(event); },
    status: (_session, state) => { statuses.push(state); },
  };
  const server = createServer();
  const relay = attachVoiceServer(server, hooks, { upstreamUrl: `ws://127.0.0.1:${upstreamAddress.port}`, livenessIntervalMs: 25 });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const browser = new WebSocket(`ws://127.0.0.1:${address.port}/voice?token=live-token`, { headers: { Origin: `http://127.0.0.1:${address.port}` } });
  const browserEvents: string[] = [];
  browser.on('message', (data) => browserEvents.push(data.toString()));
  await waitUntil(() => browserEvents.some((event) => event.includes('"type":"ready"')));

  browser.send(JSON.stringify({ setup: { model: 'attacker-model' } }));
  browser.send(JSON.stringify({ text: '我的收入是每年八万美元。' }));
  await waitUntil(() => upstreamMessages.some((message) => Boolean(message.realtimeInput)));
  await waitUntil(() => persisted.length === 1);
  assert.equal(persisted[0].role, 'user');
  assert.equal(upstreamMessages.filter((message) => Boolean(message.setup)).length, 1);
  assert(browserEvents.some((event) => event.includes('不允许修改实时服务配置')));

  const upstreamSocket = [...upstream.clients][0];
  upstreamSocket.send(JSON.stringify({ serverContent: {
    inputTranscription: { text: '我的收入是每年八万美元。' },
    outputTranscription: { text: '谢谢，我会记录并交由顾问复核。' },
    modelTurn: { parts: [{ inlineData: { data: 'AAA=', mimeType: 'audio/pcm;rate=24000' } }] },
    turnComplete: true,
  } }));
  await waitUntil(() => persisted.length === 2);
  assert.deepEqual(persisted.map((event) => event.role), ['user', 'assistant']);
  assert.notEqual(persisted[0].eventId, persisted[1].eventId);
  assert.match(persisted[0].eventId, /^live-session:voice:[0-9a-f-]+:1:user$/);
  assert(browserEvents.some((event) => event.includes('"type":"audio"')));

  const duplicateModulePath = '../lib/voice-server.ts?duplicate=integration';
  const duplicateModule = await import(duplicateModulePath) as typeof import('../lib/voice-server');
  const drained = await duplicateModule.closeVoiceSession('live-session', 500);
  assert.deepEqual(drained, { timedOut: false });
  assert(statuses.includes('ended'));

  respondToAudioEnd = false;
  const secondBrowser = new WebSocket(`ws://127.0.0.1:${address.port}/voice?token=live-token-2`, { headers: { Origin: `http://127.0.0.1:${address.port}` } });
  const secondEvents: string[] = [];
  secondBrowser.on('message', (data) => secondEvents.push(data.toString()));
  await waitUntil(() => secondEvents.some((event) => event.includes('"type":"ready"')));
  const timedOut = await closeVoiceSession('live-session', 20);
  assert.deepEqual(timedOut, { timedOut: true });
  assert(statuses.includes('transcript_incomplete'));
  await relay.close();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  if (oldKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = oldKey;
  if (oldModel === undefined) delete process.env.GEMINI_LIVE_MODEL; else process.env.GEMINI_LIVE_MODEL = oldModel;
  if (oldProvider === undefined) delete process.env.VOICE_PROVIDER; else process.env.VOICE_PROVIDER = oldProvider;
});

test('mock voice refuses an upstream connection even when cloud credentials exist', async (t) => {
  const keys = ['VOICE_PROVIDER', 'GEMINI_API_KEY', 'GEMINI_LIVE_MODEL'] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => { for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } });
  process.env.VOICE_PROVIDER = 'mock';
  process.env.GEMINI_API_KEY = 'synthetic-unused-key';
  process.env.GEMINI_LIVE_MODEL = 'synthetic-unused-model';
  const upstream = new WebSocketServer({host:'127.0.0.1',port:0});
  await new Promise<void>(resolve => upstream.once('listening',resolve));
  const upstreamAddress = upstream.address();
  assert(upstreamAddress && typeof upstreamAddress !== 'string');
  let connections = 0;
  upstream.on('connection', socket => { connections++; socket.close(1013, 'unexpected upstream'); });
  const hooks:VoiceHooks = {consumeToken:()=>({sessionId:'mock-voice',caseId:'mock-case'}),isActive:()=>true,persist:()=>undefined,status:()=>undefined};
  const server = createServer();
  const relay = attachVoiceServer(server,hooks,{upstreamUrl:`ws://127.0.0.1:${upstreamAddress.port}`});
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(async () => { await relay.close(); await new Promise<void>(resolve => server.close(()=>resolve())); await new Promise<void>(resolve => upstream.close(()=>resolve())); });
  const address=server.address();
  assert(address && typeof address !== 'string');
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/voice?token=synthetic`,{headers:{Origin:`http://127.0.0.1:${address.port}`}});
  const events:string[]=[];
  socket.on('message',data=>events.push(data.toString()));
  assert.equal((await waitForClose(socket)).code,1013);
  assert(events.some(event=>event.includes('实时语音未配置')));
  assert.equal(connections,0);
});
