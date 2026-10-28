import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { attachVoiceServer, closeVoiceSession, forgetVoiceSession, hasVoiceSession, type VoiceHooks } from '../lib/voice-server';
import { getUsageSummary } from '../lib/ai-usage';
import { db, pack } from '../lib/db';

process.env.DATABASE_PATH=join(mkdtempSync(join(tmpdir(),'aeconn-voice-usage-')),'voice.sqlite');

function realtimeUsage(inputAudio=20,outputAudio=20){
  return {input_tokens:inputAudio,output_tokens:outputAudio,input_token_details:{text_tokens:0,audio_tokens:inputAudio,cached_tokens:0,cached_tokens_details:{text_tokens:0,audio_tokens:0}},output_token_details:{text_tokens:0,audio_tokens:outputAudio}};
}

function waitForClose(socket: WebSocket,timeoutMs=2_000) {
  return new Promise<{ code: number; reason: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket did not close')), timeoutMs);
    socket.on('close', (code, reason) => { clearTimeout(timer); resolve({ code, reason: reason.toString() }); });
    socket.on('error', () => undefined);
  });
}

function addUsageTestCase(caseId:string){
  const clientId=`client-${caseId}`;
  db().prepare('INSERT OR IGNORE INTO clients VALUES(?,?,?)').run(clientId,'advisor-1',pack({id:clientId}));
  db().prepare('INSERT OR IGNORE INTO cases VALUES(?,?,?,?,?)').run(caseId,clientId,'advisor-1',null,pack({id:caseId,clientId,ownerAgentId:'advisor-1'}));
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
    getContext: () => '{}',
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
    getContext: () => '{}',
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

  const persisted: Array<{ eventId: string; turnId: string; role: string; text: string; final?:boolean }> = [];
  const statuses: string[] = [];
  const hooks: VoiceHooks = {
    consumeToken: (token) => ['live-token', 'live-token-2'].includes(token) ? { sessionId: 'live-session', caseId: 'case-1' } : null,
    isActive: () => true,
    getContext: () => JSON.stringify({knownFacts:[{key:'income',value:80000,currency:'USD',period:'year'}],missingPriorityItems:[{key:'expenses',question:'确认支出周期'}],transcript:Array.from({length:20},(_,index)=>({id:`m-${index}`,role:'user',text:`${index===0?'oldest-marker':index===19?'latest-marker':'turn'}-${index}-`+'x'.repeat(1_900)}))}),
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
  await waitUntil(() => upstreamMessages.some((message) => Boolean(message.clientContent)));

  const setup=upstreamMessages.find((message)=>Boolean(message.setup))?.setup as Record<string,unknown>;
  assert.match(JSON.stringify(setup.systemInstruction),/80000/);
  assert.match(JSON.stringify(setup.systemInstruction),/latest-marker/);
  assert.doesNotMatch(JSON.stringify(setup.systemInstruction),/oldest-marker/);
  assert.deepEqual(setup.contextWindowCompression,{slidingWindow:{}});
  assert.deepEqual(setup.sessionResumption,{});
  assert.equal((setup.realtimeInputConfig as {activityHandling?:string}).activityHandling,'START_OF_ACTIVITY_INTERRUPTS');
  assert.match(JSON.stringify(upstreamMessages.find(message=>Boolean(message.clientContent))),/只问一个问题/);

  browser.send(JSON.stringify({ setup: { model: 'attacker-model' } }));
  browser.send(JSON.stringify({ text: '我的收入是每年八万美元。' }));
  await waitUntil(() => upstreamMessages.some((message) => Boolean(message.realtimeInput)));
  await waitUntil(() => persisted.length === 1);
  assert.equal(persisted[0].role, 'user');
  assert.equal(upstreamMessages.filter((message) => Boolean(message.setup)).length, 1);
  assert(browserEvents.some((event) => event.includes('不允许修改实时服务配置')));

  const upstreamSocket = [...upstream.clients][0];
  upstreamSocket.send(JSON.stringify({serverContent:{inputTranscription:{text:'我的收入'},outputTranscription:{text:'谢谢，'}}}));
  upstreamSocket.send(JSON.stringify({ serverContent: {
    inputTranscription: { text: '是每年八万美元。' },
    outputTranscription: { text: '我会记录并交由顾问复核。' },
    modelTurn: { parts: [{ inlineData: { data: 'AAA=', mimeType: 'audio/pcm;rate=24000' } }] },
    turnComplete: true,
  } }));
  await waitUntil(() => persisted.length === 2);
  assert.deepEqual(persisted.map((event) => event.role), ['user', 'assistant']);
  assert.notEqual(persisted[0].eventId, persisted[1].eventId);
  assert.match(persisted[0].eventId, /^live-session:voice:[0-9a-f-]+:1:user$/);
  assert.match(persisted[0].turnId, /^live-session:voice:[0-9a-f-]+:turn:1$/);
  assert(browserEvents.some((event) => event.includes('"type":"audio"')));
  assert(browserEvents.some(event=>event.includes('谢谢，我会记录并交由顾问复核。')));

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
  const secondUpstream=[...upstream.clients].find(socket=>socket.readyState===WebSocket.OPEN);
  assert(secondUpstream);
  secondUpstream.send(JSON.stringify({serverContent:{inputTranscription:{text:'尚未完成的客户回答'},outputTranscription:{text:'尚未播完的回答'}}}));
  await waitUntil(()=>secondEvents.some(event=>event.includes('尚未播完的回答')));
  const timedOut = await closeVoiceSession('live-session', 20);
  assert.deepEqual(timedOut, { timedOut: true });
  assert(statuses.includes('transcript_incomplete'));
  assert.deepEqual(persisted.slice(-2).map(event=>({role:event.role,final:event.final})),[{role:'user',final:false},{role:'assistant',final:false}]);
  await relay.close();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  if (oldKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = oldKey;
  if (oldModel === undefined) delete process.env.GEMINI_LIVE_MODEL; else process.env.GEMINI_LIVE_MODEL = oldModel;
  if (oldProvider === undefined) delete process.env.VOICE_PROVIDER; else process.env.VOICE_PROVIDER = oldProvider;
});

test('voice relay resumes an upstream session until its retained handle is explicitly forgotten', async (t) => {
  const keys=['VOICE_PROVIDER','GEMINI_API_KEY','GEMINI_LIVE_MODEL'] as const;
  const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  t.after(()=>{for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}});
  process.env.VOICE_PROVIDER='gemini';process.env.GEMINI_API_KEY='test-key';process.env.GEMINI_LIVE_MODEL='test-model';
  const upstream=new WebSocketServer({host:'127.0.0.1',port:0});
  await new Promise<void>(resolve=>upstream.once('listening',resolve));
  const upstreamAddress=upstream.address();assert(upstreamAddress&&typeof upstreamAddress!=='string');
  const setups:Record<string,unknown>[]=[];let openings=0;let connections=0;
  upstream.on('connection',socket=>{
    connections+=1;const connection=connections;
    socket.on('message',data=>{
      const message=JSON.parse(data.toString()) as Record<string,unknown>;
      if(message.setup){setups.push(message.setup as Record<string,unknown>);socket.send(JSON.stringify({setupComplete:{}}));if(connection===1){socket.send(JSON.stringify({sessionResumptionUpdate:{resumable:true,newHandle:'resume-handle-1'}}));setTimeout(()=>socket.close(1012,'rotate connection'),10);}}
      if(message.clientContent)openings+=1;
      if((message.realtimeInput as {audioStreamEnd?:boolean}|undefined)?.audioStreamEnd)socket.send(JSON.stringify({serverContent:{turnComplete:true,interactionStatus:'IDLE'}}));
    });
  });
  const hooks:VoiceHooks={consumeToken:()=>({sessionId:'resume-session',caseId:'case-r'}),isActive:()=>true,getContext:()=>'{"goal":"保护家庭"}',persist:()=>undefined,status:()=>undefined};
  const server=createServer();const relay=attachVoiceServer(server,hooks,{upstreamUrl:`ws://127.0.0.1:${upstreamAddress.port}`,transcriptionGraceMs:5});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await relay.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await new Promise<void>(resolve=>upstream.close(()=>resolve()));});
  const address=server.address();assert(address&&typeof address!=='string');
  const browser=new WebSocket(`ws://127.0.0.1:${address.port}/voice?token=resume-token`,{headers:{Origin:`http://127.0.0.1:${address.port}`}});
  const events:string[]=[];browser.on('message',data=>events.push(data.toString()));
  await waitUntil(()=>setups.length===2&&events.filter(event=>event.includes('"type":"ready"')).length===2,3_000);
  assert.deepEqual(setups[0].sessionResumption,{});
  assert.deepEqual(setups[1].sessionResumption,{handle:'resume-handle-1'});
  assert.equal(openings,1);
  assert(events.some(event=>event.includes('"type":"reconnecting"')));
  forgetVoiceSession('resume-session');
  assert.equal(hasVoiceSession('resume-session'),true,'forgetting retained state does not seize active connection ownership');
  const reconnectEvents=events.filter(event=>event.includes('"type":"reconnecting"')).length;
  const activeUpstream=[...upstream.clients].find(socket=>socket.readyState===WebSocket.OPEN);assert(activeUpstream);
  activeUpstream.send(JSON.stringify({sessionResumptionUpdate:{resumable:true,newHandle:'late-handle-after-forget'}}));
  activeUpstream.send(JSON.stringify({goAway:{timeLeft:'1s'}}));
  await waitUntil(()=>events.filter(event=>event.includes('"type":"reconnecting"')).length>reconnectEvents);
  assert.deepEqual(await closeVoiceSession('resume-session',500),{timedOut:false});

  const replacement=new WebSocket(`ws://127.0.0.1:${address.port}/voice?token=replacement-token`,{headers:{Origin:`http://127.0.0.1:${address.port}`}});
  const replacementEvents:string[]=[];replacement.on('message',data=>replacementEvents.push(data.toString()));
  await waitUntil(()=>setups.length===3&&replacementEvents.some(event=>event.includes('"type":"ready"')),3_000);
  assert.deepEqual(setups[2].sessionResumption,{},'forgotten handles are not sent to a later upstream connection');
  assert.equal(openings,2,'a fresh connection sends its opening after retained state is forgotten');
  assert.deepEqual(await closeVoiceSession('resume-session',500),{timedOut:false});
  assert.doesNotThrow(()=>forgetVoiceSession('already-purged-session'));
});

test('OpenAI realtime relay uses 24k audio, source item IDs, VAD interruption, and bounded truncation',async(t)=>{
  const upstream=new WebSocketServer({host:'127.0.0.1',port:0});
  await new Promise<void>(resolve=>upstream.once('listening',resolve));
  const upstreamAddress=upstream.address();assert(upstreamAddress&&typeof upstreamAddress!=='string');
  const received:Record<string,unknown>[]=[];let authorization='',requestUrl='';
  upstream.on('connection',(socket,request)=>{
    authorization=String(request.headers.authorization||'');requestUrl=request.url||'';
    socket.send(JSON.stringify({type:'session.created',session:{model:'gpt-realtime-2.1'}}));
    socket.on('message',data=>{
      const event=JSON.parse(data.toString()) as Record<string,unknown>;received.push(event);
      if(event.type==='session.update')socket.send(JSON.stringify({type:'session.updated'}));
      if(event.type==='response.create'){
        const audio=Buffer.alloc(4_800).toString('base64');
        socket.send(JSON.stringify({type:'response.created',response:{id:'response-1'}}));
        socket.send(JSON.stringify({type:'response.output_item.added',item:{id:'assistant-item-1'}}));
        socket.send(JSON.stringify({type:'response.output_audio.delta',item_id:'assistant-item-1',delta:audio}));
        socket.send(JSON.stringify({type:'response.output_audio_transcript.delta',item_id:'assistant-item-1',delta:'请问您的'}));
        socket.send(JSON.stringify({type:'response.output_audio_transcript.delta',item_id:'assistant-item-1',delta:'家庭保障目标是'}));
      }
      if(event.type==='input_audio_buffer.append'){
        socket.send(JSON.stringify({type:'input_audio_buffer.speech_started',item_id:'user-item-1'}));
        socket.send(JSON.stringify({type:'input_audio_buffer.speech_stopped',item_id:'user-item-1'}));
        socket.send(JSON.stringify({type:'input_audio_buffer.committed',item_id:'user-item-1'}));
        socket.send(JSON.stringify({type:'conversation.item.input_audio_transcription.delta',item_id:'user-item-1',delta:'我想'}));
        socket.send(JSON.stringify({type:'conversation.item.input_audio_transcription.delta',item_id:'user-item-1',delta:'保障家人。'}));
        socket.send(JSON.stringify({type:'response.output_audio_transcript.done',item_id:'assistant-item-1',transcript:'请问您的家庭保障目标是什么？'}));
        socket.send(JSON.stringify({type:'response.done',response:{id:'response-1',status:'cancelled',usage:realtimeUsage()}}));
        socket.send(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',item_id:'user-item-1',transcript:'我想保障家人。',usage:{type:'duration',seconds:.05}}));
      }
    });
  });
  const persisted:Array<{role:string;text:string;final?:boolean;interrupted?:boolean;sourceItemId?:string;turnId:string}>=[];
  const hooks:VoiceHooks={consumeToken:()=>({sessionId:'openai-session',caseId:'case-1'}),isActive:()=>true,getContext:()=>JSON.stringify({facts:[],questionPriority:['goal']}),persist:(_session,event)=>{persisted.push(event);},status:()=>undefined};
  const server=createServer();const relay=attachVoiceServer(server,hooks,{upstreamUrl:`ws://127.0.0.1:${upstreamAddress.port}`,configOverride:{provider:'openai',apiKey:'openai-test-key',model:'gpt-realtime-2.1'}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await relay.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await new Promise<void>(resolve=>upstream.close(()=>resolve()));});
  const address=server.address();assert(address&&typeof address!=='string');
  const browser=new WebSocket(`ws://127.0.0.1:${address.port}/voice?token=openai-token`,{headers:{Origin:`http://127.0.0.1:${address.port}`}});
  const events:Record<string,unknown>[]=[];
  browser.on('message',data=>{
    const event=JSON.parse(data.toString()) as Record<string,unknown>;events.push(event);
    if(event.type==='interrupted')browser.send(JSON.stringify({truncate:{itemId:event.itemId,audioEndMs:10}}));
  });
  await waitUntil(()=>events.some(event=>event.type==='ready'));
  const ready=events.find(event=>event.type==='ready');assert.equal(ready?.inputSampleRate,24_000);assert.equal(ready?.outputSampleRate,24_000);
  browser.send(JSON.stringify({audio:Buffer.alloc(2_400).toString('base64')}));
  await waitUntil(()=>persisted.length===2&&received.some(event=>event.type==='conversation.item.truncate'));
  assert.equal(authorization,'Bearer openai-test-key');assert.match(requestUrl,/model=gpt-realtime-2.1/);
  const update=received.find(event=>event.type==='session.update')?.session as {audio?:{input?:{format?:unknown;turn_detection?:unknown};output?:{format?:unknown}};instructions?:string;max_output_tokens?:number};
  assert.deepEqual(update.audio?.input?.format,{type:'audio/pcm',rate:24_000});assert.deepEqual(update.audio?.output?.format,{type:'audio/pcm',rate:24_000});assert.match(update.instructions||'',/questionPriority/);
  assert.equal(update.max_output_tokens,512);
  assert(received.some(event=>event.type==='conversation.item.create'));assert(received.some(event=>event.type==='response.create'));
  assert.deepEqual(persisted.map(event=>({role:event.role,source:event.sourceItemId,interrupted:Boolean(event.interrupted)})),[
    {role:'user',source:'user-item-1',interrupted:false},{role:'assistant',source:'assistant-item-1',interrupted:true},
  ]);
  const userFinalIndex=events.findIndex(event=>event.type==='transcript'&&event.role==='user'&&event.final===true);
  const turnCompleteIndex=events.findIndex(event=>event.type==='turnComplete');
  assert(userFinalIndex>=0&&turnCompleteIndex>userFinalIndex);
  assert.notEqual(persisted[0].turnId,persisted[1].turnId); // The user interrupted the proactive opening; it is not the answer turn.
  assert(events.some(event=>event.type==='transcript'&&event.role==='assistant'&&event.text==='请问您的家庭保障目标是'));
  assert(events.some(event=>event.type==='transcript'&&event.role==='user'&&event.text==='我想保障家人。'));
  const truncate=received.find(event=>event.type==='conversation.item.truncate');assert.equal(truncate?.item_id,'assistant-item-1');assert.equal(truncate?.audio_end_ms,10);
  assert.deepEqual(await closeVoiceSession('openai-session',500),{timedOut:false});
});

test('a rejected persist does not poison the upstream queue or leave a live session',async(t)=>{
  const upstream=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise<void>(resolve=>upstream.once('listening',resolve));
  const upstreamAddress=upstream.address();assert(upstreamAddress&&typeof upstreamAddress!=='string');
  upstream.on('connection',socket=>socket.on('message',data=>{const message=JSON.parse(data.toString()) as Record<string,unknown>;if(message.setup){socket.send(JSON.stringify({setupComplete:{}}));socket.send(JSON.stringify({serverContent:{inputTranscription:{text:'会失败的持久化'},outputTranscription:{text:'不会留下活连接'},turnComplete:true}}));}}));
  let writes=0;const statuses:string[]=[];
  const hooks:VoiceHooks={consumeToken:()=>({sessionId:'reject-session',caseId:'reject-case'}),isActive:()=>true,getContext:()=>'{}',persist:()=>{writes+=1;if(writes===1)throw new Error('synthetic persist failure');},status:(_session,state)=>{statuses.push(state);}};
  const server=createServer();const relay=attachVoiceServer(server,hooks,{upstreamUrl:`ws://127.0.0.1:${upstreamAddress.port}`,transcriptionGraceMs:5,configOverride:{provider:'gemini',apiKey:'test-key',model:'test-model'}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await relay.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await new Promise<void>(resolve=>upstream.close(()=>resolve()));});
  const address=server.address();assert(address&&typeof address!=='string');
  const browser=new WebSocket(`ws://127.0.0.1:${address.port}/voice?token=x`,{headers:{Origin:`http://127.0.0.1:${address.port}`}});
  const events:string[]=[];browser.on('message',data=>events.push(data.toString()));
  const closed=await waitForClose(browser);assert.equal(closed.code,1011);
  await waitUntil(()=>!hasVoiceSession('reject-session'));
  assert(events.some(event=>event.includes('实时语音处理失败')));assert(statuses.includes('transcript_incomplete'));assert(statuses.includes('error'));assert.equal(writes,2);
});

test('two OpenAI outputs retain distinct triggering turn IDs while ASR finals are delayed',async(t)=>{
  const upstream=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise<void>(resolve=>upstream.once('listening',resolve));
  const upstreamAddress=upstream.address();assert(upstreamAddress&&typeof upstreamAddress!=='string');let providerSocket:WebSocket|null=null;
  upstream.on('connection',socket=>{providerSocket=socket;socket.send(JSON.stringify({type:'session.created',session:{model:'gpt-realtime-2.1'}}));socket.on('message',data=>{const event=JSON.parse(data.toString()) as Record<string,unknown>;if(event.type==='session.update')socket.send(JSON.stringify({type:'session.updated'}));if(event.type==='response.create'){socket.send(JSON.stringify({type:'response.created',response:{id:'proactive-response'}}));socket.send(JSON.stringify({type:'response.output_item.added',item:{id:'proactive-output'}}));socket.send(JSON.stringify({type:'response.output_audio_transcript.done',item_id:'proactive-output',transcript:'先问一个问题'}));socket.send(JSON.stringify({type:'response.done',response:{id:'proactive-response',usage:realtimeUsage()}}));}});});
  const persisted:Array<{role:string;sourceItemId?:string;turnId:string}>=[];
  const hooks:VoiceHooks={consumeToken:()=>({sessionId:'two-turn-session',caseId:'case-1'}),isActive:()=>true,getContext:()=>'{}',persist:(_session,event)=>{persisted.push(event);},status:()=>undefined};
  const server=createServer();const relay=attachVoiceServer(server,hooks,{upstreamUrl:`ws://127.0.0.1:${upstreamAddress.port}`,configOverride:{provider:'openai',apiKey:'key',model:'gpt-realtime-2.1'}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await relay.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await new Promise<void>(resolve=>upstream.close(()=>resolve()));});
  const address=server.address();assert(address&&typeof address!=='string');const browser=new WebSocket(`ws://127.0.0.1:${address.port}/voice?token=x`,{headers:{Origin:`http://127.0.0.1:${address.port}`}});
  const events:string[]=[];browser.on('message',data=>events.push(data.toString()));await waitUntil(()=>events.some(event=>event.includes('"type":"ready"'))&&persisted.some(event=>event.sourceItemId==='proactive-output'));
  persisted.length=0;assert(providerSocket);
  const emit=(value:object)=>providerSocket!.send(JSON.stringify(value));
  emit({type:'input_audio_buffer.speech_started',item_id:'user-1'});emit({type:'input_audio_buffer.speech_stopped',item_id:'user-1'});emit({type:'input_audio_buffer.committed',item_id:'user-1'});
  emit({type:'response.created',response:{id:'response-1'}});emit({type:'response.output_item.added',item:{id:'assistant-1'}});emit({type:'response.output_audio_transcript.done',item_id:'assistant-1',transcript:'回答一'});emit({type:'response.done',response:{id:'response-1',usage:realtimeUsage()}});
  emit({type:'input_audio_buffer.speech_started',item_id:'user-2'});emit({type:'input_audio_buffer.speech_stopped',item_id:'user-2'});emit({type:'input_audio_buffer.committed',item_id:'user-2'});
  emit({type:'response.created',response:{id:'response-2'}});emit({type:'response.output_item.added',item:{id:'assistant-2'}});emit({type:'response.output_audio_transcript.done',item_id:'assistant-2',transcript:'回答二'});emit({type:'response.done',response:{id:'response-2',usage:realtimeUsage()}});
  emit({type:'conversation.item.input_audio_transcription.completed',item_id:'user-2',transcript:'用户二',usage:{type:'duration',seconds:.05}});emit({type:'conversation.item.input_audio_transcription.completed',item_id:'user-1',transcript:'用户一',usage:{type:'duration',seconds:.05}});
  await waitUntil(()=>persisted.length===4);
  const bySource=new Map(persisted.map(event=>[event.sourceItemId,event]));
  assert.match(bySource.get('assistant-1')?.turnId??'',new RegExp(`^${bySource.get('user-1')?.turnId}:assistant:`));assert.match(bySource.get('assistant-2')?.turnId??'',new RegExp(`^${bySource.get('user-2')?.turnId}:assistant:`));assert.notEqual(bySource.get('assistant-1')?.turnId,bySource.get('assistant-2')?.turnId);
  assert.deepEqual(await closeVoiceSession('two-turn-session',500),{timedOut:false});
});

test('one OpenAI response persists every assistant item with a unique input-linked turn ID',async(t)=>{
  const upstream=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise<void>(resolve=>upstream.once('listening',resolve));
  const upstreamAddress=upstream.address();assert(upstreamAddress&&typeof upstreamAddress!=='string');let providerSocket:WebSocket|null=null;
  upstream.on('connection',socket=>{providerSocket=socket;socket.send(JSON.stringify({type:'session.created',session:{model:'gpt-realtime-2.1'}}));socket.on('message',data=>{const event=JSON.parse(data.toString()) as Record<string,unknown>;if(event.type==='session.update')socket.send(JSON.stringify({type:'session.updated'}));if(event.type==='response.create'){socket.send(JSON.stringify({type:'response.created',response:{id:'multi-opening'}}));socket.send(JSON.stringify({type:'response.done',response:{id:'multi-opening',usage:realtimeUsage()}}));}});});
  const persisted:Array<{role:string;text:string;sourceItemId?:string;turnId:string}>=[];const hooks:VoiceHooks={consumeToken:()=>({sessionId:'multi-item-session',caseId:'case-5'}),isActive:()=>true,getContext:()=>'{}',persist:(_session,event)=>{persisted.push(event);},status:()=>undefined};
  const server=createServer();const relay=attachVoiceServer(server,hooks,{upstreamUrl:`ws://127.0.0.1:${upstreamAddress.port}`,configOverride:{provider:'openai',apiKey:'key',model:'gpt-realtime-2.1'}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await relay.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await new Promise<void>(resolve=>upstream.close(()=>resolve()));});
  const address=server.address();assert(address&&typeof address!=='string');const browser=new WebSocket(`ws://127.0.0.1:${address.port}/voice?token=x`,{headers:{Origin:`http://127.0.0.1:${address.port}`}});
  const events:string[]=[];browser.on('message',data=>events.push(data.toString()));await waitUntil(()=>events.some(event=>event.includes('"type":"ready"'))&&providerSocket!==null);assert(providerSocket);
  const emit=(value:object)=>providerSocket!.send(JSON.stringify(value));
  emit({type:'input_audio_buffer.speech_started',item_id:'multi-user'});emit({type:'input_audio_buffer.speech_stopped',item_id:'multi-user'});emit({type:'input_audio_buffer.committed',item_id:'multi-user'});
  emit({type:'response.created',response:{id:'multi-response'}});
  emit({type:'response.output_item.added',response_id:'multi-response',item:{id:'planning-item'}});emit({type:'response.output_audio_transcript.done',item_id:'planning-item',transcript:'先确认时间范围。'});
  emit({type:'response.output_item.added',response_id:'multi-response',item:{id:'horizon-question'}});emit({type:'response.output_audio_transcript.done',item_id:'horizon-question',transcript:'您希望在多久内完成？'});
  emit({type:'response.done',response:{id:'multi-response',usage:realtimeUsage()}});
  await new Promise(resolve=>setTimeout(resolve,20));assert.equal(persisted.length,0,'assistant items wait for the delayed final ASR source');
  emit({type:'conversation.item.input_audio_transcription.completed',item_id:'multi-user',transcript:'大约五年。',usage:{type:'duration',seconds:.2}});await waitUntil(()=>persisted.length===3);
  const user=persisted.find(event=>event.sourceItemId==='multi-user');const assistants=persisted.filter(event=>event.role==='assistant');assert(user);assert.deepEqual(assistants.map(event=>event.sourceItemId),['planning-item','horizon-question']);assert.notEqual(assistants[0].turnId,assistants[1].turnId);assert(assistants.every(event=>event.turnId.startsWith(`${user.turnId}:assistant:`)));
  assert.deepEqual(await closeVoiceSession('multi-item-session',500),{timedOut:false});
});

test('duplicate OpenAI response.done cannot double count or poison the next turn',async(t)=>{
  const upstream=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise<void>(resolve=>upstream.once('listening',resolve));
  const upstreamAddress=upstream.address();assert(upstreamAddress&&typeof upstreamAddress!=='string');let responseCreates=0;const clientItemIds:string[]=[];
  upstream.on('connection',socket=>{socket.send(JSON.stringify({type:'session.created',session:{model:'gpt-realtime-2.1'}}));socket.on('message',data=>{
    const event=JSON.parse(data.toString()) as Record<string,unknown>;
    if(event.type==='conversation.item.create'){const item=event.item as {id?:unknown}|undefined;if(typeof item?.id==='string')clientItemIds.push(item.id);}
    if(event.type==='session.update')socket.send(JSON.stringify({type:'session.updated'}));
    if(event.type==='response.create'){
      responseCreates+=1;const responseId=`dedupe-response-${responseCreates}`;
      socket.send(JSON.stringify({type:'response.created',response:{id:responseId}}));
      socket.send(JSON.stringify({type:'response.done',response:{id:responseId,usage:realtimeUsage()}}));
      if(responseCreates===1)socket.send(JSON.stringify({type:'response.done',response:{id:responseId}}));
    }
  });});
  const hooks:VoiceHooks={consumeToken:()=>({sessionId:'dedupe-session',caseId:'case-5'}),isActive:()=>true,getContext:()=>'{}',persist:()=>undefined,status:()=>undefined};
  const server=createServer();const relay=attachVoiceServer(server,hooks,{upstreamUrl:`ws://127.0.0.1:${upstreamAddress.port}`,configOverride:{provider:'openai',apiKey:'key',model:'gpt-realtime-2.1'}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await relay.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await new Promise<void>(resolve=>upstream.close(()=>resolve()));});
  const address=server.address();assert(address&&typeof address!=='string');const browser=new WebSocket(`ws://127.0.0.1:${address.port}/voice?token=x`,{headers:{Origin:`http://127.0.0.1:${address.port}`}});
  const events:string[]=[];browser.on('message',data=>events.push(data.toString()));await waitUntil(()=>events.some(event=>event.includes('"type":"ready"'))&&responseCreates===1);
  browser.send(JSON.stringify({text:'这是第二轮，不应被重复完成事件污染。'}));await waitUntil(()=>responseCreates===2);
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(browser.readyState,WebSocket.OPEN);assert.equal(events.some(event=>event.includes('未返回可核对的用量')),false);
  assert.equal(clientItemIds.length,2);assert(clientItemIds.every(itemId=>itemId.length<=32&&/^[A-Za-z0-9_-]+$/.test(itemId)));
  assert.deepEqual(await closeVoiceSession('dedupe-session',500),{timedOut:false});
  const latest=getUsageSummary('org-demo','case-5',true).records[0];assert.equal(latest.status,'settled');assert.equal(latest.costMicros,3_840);
});

test('OpenAI spending stop clears pending audio without committing another response',async(t)=>{
  const prior=process.env.AI_CASE_BUDGET_USD;process.env.AI_CASE_BUDGET_USD='0.1';
  t.after(()=>{if(prior===undefined)delete process.env.AI_CASE_BUDGET_USD;else process.env.AI_CASE_BUDGET_USD=prior;});
  const upstream=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise<void>(resolve=>upstream.once('listening',resolve));
  const upstreamAddress=upstream.address();assert(upstreamAddress&&typeof upstreamAddress!=='string');const received:Record<string,unknown>[]=[];
  upstream.on('connection',socket=>{socket.send(JSON.stringify({type:'session.created',session:{model:'gpt-realtime-2.1'}}));socket.on('message',data=>{const event=JSON.parse(data.toString()) as Record<string,unknown>;received.push(event);if(event.type==='session.update')socket.send(JSON.stringify({type:'session.updated'}));});});
  const diagnostics:unknown[]=[];const hooks:VoiceHooks={consumeToken:()=>({sessionId:'pending-audio-budget-session',caseId:'case-6'}),isActive:()=>true,getContext:()=>'{}',persist:()=>undefined,status:()=>undefined,diagnostic:(_session,event)=>{diagnostics.push(event);}};
  const server=createServer();const relay=attachVoiceServer(server,hooks,{upstreamUrl:`ws://127.0.0.1:${upstreamAddress.port}`,configOverride:{provider:'openai',apiKey:'key',model:'gpt-realtime-2.1'}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await relay.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await new Promise<void>(resolve=>upstream.close(()=>resolve()));});
  const address=server.address();assert(address&&typeof address!=='string');const browser=new WebSocket(`ws://127.0.0.1:${address.port}/voice?token=x`,{headers:{Origin:`http://127.0.0.1:${address.port}`}});
  const events:string[]=[];browser.on('message',data=>events.push(data.toString()));await waitUntil(()=>events.some(event=>event.includes('"type":"ready"')));
  const audio=Buffer.alloc(192_000).toString('base64');
  for(let index=0;index<30&&browser.readyState===WebSocket.OPEN;index+=1){browser.send(JSON.stringify({audio}));await new Promise(resolve=>setTimeout(resolve,2));}
  await waitForClose(browser);await waitUntil(()=>received.some(event=>event.type==='input_audio_buffer.clear'));
  assert(received.some(event=>event.type==='input_audio_buffer.append'));assert.equal(received.some(event=>event.type==='input_audio_buffer.commit'),false);
  assert.equal(received.filter(event=>event.type==='response.create').length,1);assert(events.some(event=>event.includes('费用保护阈值')));
  assert.deepEqual(diagnostics,[{code:'spending_protection',stage:'runtime'}]);
});

test('OpenAI end clears trailing silence after VAD auto-commit without creating another response',async(t)=>{
  const upstream=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise<void>(resolve=>upstream.once('listening',resolve));
  const upstreamAddress=upstream.address();assert(upstreamAddress&&typeof upstreamAddress!=='string');const received:Record<string,unknown>[]=[];let handledSpeech=false;
  upstream.on('connection',socket=>{socket.send(JSON.stringify({type:'session.created',session:{model:'gpt-realtime-2.1'}}));socket.on('message',data=>{
    const event=JSON.parse(data.toString()) as Record<string,unknown>;received.push(event);
    if(event.type==='session.update')socket.send(JSON.stringify({type:'session.updated'}));
    if(event.type==='response.create'){socket.send(JSON.stringify({type:'response.created',response:{id:'tail-opening'}}));socket.send(JSON.stringify({type:'response.done',response:{id:'tail-opening',usage:realtimeUsage()}}));}
    if(event.type==='input_audio_buffer.append'&&!handledSpeech){handledSpeech=true;
      socket.send(JSON.stringify({type:'input_audio_buffer.speech_started',item_id:'tail-user'}));socket.send(JSON.stringify({type:'input_audio_buffer.speech_stopped',item_id:'tail-user'}));socket.send(JSON.stringify({type:'input_audio_buffer.committed',item_id:'tail-user'}));
      socket.send(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',item_id:'tail-user',transcript:'这是已由 VAD 提交的回答。',usage:{type:'duration',seconds:.2}}));
      socket.send(JSON.stringify({type:'response.created',response:{id:'tail-vad-response'}}));socket.send(JSON.stringify({type:'response.done',response:{id:'tail-vad-response',usage:realtimeUsage()}}));
    }
  });});
  const persisted:string[]=[];const hooks:VoiceHooks={consumeToken:()=>({sessionId:'tail-silence-session',caseId:'case-11'}),isActive:()=>true,getContext:()=>'{}',persist:(_session,event)=>{persisted.push(event.text);},status:()=>undefined};
  const server=createServer();const relay=attachVoiceServer(server,hooks,{upstreamUrl:`ws://127.0.0.1:${upstreamAddress.port}`,configOverride:{provider:'openai',apiKey:'key',model:'gpt-realtime-2.1',transcriptionModel:'whisper-1'}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await relay.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await new Promise<void>(resolve=>upstream.close(()=>resolve()));});
  const address=server.address();assert(address&&typeof address!=='string');const browser=new WebSocket(`ws://127.0.0.1:${address.port}/voice?token=x`,{headers:{Origin:`http://127.0.0.1:${address.port}`}});
  const events:string[]=[];browser.on('message',data=>events.push(data.toString()));await waitUntil(()=>events.some(event=>event.includes('"type":"ready"')));
  const audio=Buffer.alloc(4_800).toString('base64');browser.send(JSON.stringify({audio}));await waitUntil(()=>persisted.includes('这是已由 VAD 提交的回答。'));
  browser.send(JSON.stringify({audio}));await waitUntil(()=>received.filter(event=>event.type==='input_audio_buffer.append').length===2);
  assert.deepEqual(await closeVoiceSession('tail-silence-session',500),{timedOut:false});
  assert.equal(received.some(event=>event.type==='input_audio_buffer.commit'),false);assert.equal(received.filter(event=>event.type==='input_audio_buffer.clear').length,1);assert.equal(received.filter(event=>event.type==='response.create').length,1);
});

test('OpenAI end tolerates an empty manual commit that loses a race with server VAD',async(t)=>{
  const upstream=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise<void>(resolve=>upstream.once('listening',resolve));
  const upstreamAddress=upstream.address();assert(upstreamAddress&&typeof upstreamAddress!=='string');const received:Record<string,unknown>[]=[];
  upstream.on('connection',socket=>{socket.send(JSON.stringify({type:'session.created',session:{model:'gpt-realtime-2.1'}}));socket.on('message',data=>{
    const event=JSON.parse(data.toString()) as Record<string,unknown>;received.push(event);
    if(event.type==='session.update')socket.send(JSON.stringify({type:'session.updated'}));
    if(event.type==='response.create'){socket.send(JSON.stringify({type:'response.created',response:{id:'race-opening'}}));socket.send(JSON.stringify({type:'response.done',response:{id:'race-opening',usage:realtimeUsage()}}));}
    if(event.type==='input_audio_buffer.append')socket.send(JSON.stringify({type:'input_audio_buffer.speech_started',item_id:'race-user'}));
    if(event.type==='input_audio_buffer.commit'){
      socket.send(JSON.stringify({type:'input_audio_buffer.speech_stopped',item_id:'race-user'}));socket.send(JSON.stringify({type:'input_audio_buffer.committed',item_id:'race-user'}));
      socket.send(JSON.stringify({type:'error',error:{type:'invalid_request_error',code:'input_audio_buffer_commit_empty',param:null,message:'raw message must not reach client'}}));
      socket.send(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',item_id:'race-user',transcript:'竞争情况下仍保留的回答。',usage:{type:'duration',seconds:.2}}));
      socket.send(JSON.stringify({type:'response.created',response:{id:'race-vad-response'}}));socket.send(JSON.stringify({type:'response.done',response:{id:'race-vad-response',usage:realtimeUsage()}}));
    }
  });});
  const persisted:string[]=[];const hooks:VoiceHooks={consumeToken:()=>({sessionId:'vad-race-session',caseId:'case-3'}),isActive:()=>true,getContext:()=>'{}',persist:(_session,event)=>{persisted.push(event.text);},status:()=>undefined};
  const server=createServer();const relay=attachVoiceServer(server,hooks,{upstreamUrl:`ws://127.0.0.1:${upstreamAddress.port}`,configOverride:{provider:'openai',apiKey:'key',model:'gpt-realtime-2.1',transcriptionModel:'whisper-1'}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await relay.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await new Promise<void>(resolve=>upstream.close(()=>resolve()));});
  const address=server.address();assert(address&&typeof address!=='string');const browser=new WebSocket(`ws://127.0.0.1:${address.port}/voice?token=x`,{headers:{Origin:`http://127.0.0.1:${address.port}`}});
  const events:string[]=[];browser.on('message',data=>events.push(data.toString()));await waitUntil(()=>events.some(event=>event.includes('"type":"ready"')));
  browser.send(JSON.stringify({audio:Buffer.alloc(4_800).toString('base64')}));await waitUntil(()=>received.some(event=>event.type==='input_audio_buffer.append'));await new Promise(resolve=>setTimeout(resolve,20));
  assert.deepEqual(await closeVoiceSession('vad-race-session',500),{timedOut:false});
  assert.equal(received.filter(event=>event.type==='input_audio_buffer.commit').length,1);assert(persisted.includes('竞争情况下仍保留的回答。'));assert.equal(events.some(event=>event.includes('provider_configuration')||event.includes('raw message')),false);
  const latest=getUsageSummary('org-demo','case-3',true).records[0];assert.equal(latest.status,'settled');
});

test('late completion of an older OpenAI response keeps the newer response active and unaccounted',async(t)=>{
  const prior=process.env.AI_CASE_BUDGET_USD;process.env.AI_CASE_BUDGET_USD='0.1';
  t.after(()=>{if(prior===undefined)delete process.env.AI_CASE_BUDGET_USD;else process.env.AI_CASE_BUDGET_USD=prior;});
  const upstream=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise<void>(resolve=>upstream.once('listening',resolve));
  const upstreamAddress=upstream.address();assert(upstreamAddress&&typeof upstreamAddress!=='string');const received:Record<string,unknown>[]=[];let providerSocket:WebSocket|null=null;
  upstream.on('connection',socket=>{providerSocket=socket;socket.send(JSON.stringify({type:'session.created',session:{model:'gpt-realtime-2.1'}}));socket.on('message',data=>{
    const event=JSON.parse(data.toString()) as Record<string,unknown>;received.push(event);
    if(event.type==='session.update')socket.send(JSON.stringify({type:'session.updated'}));
    if(event.type==='response.create')socket.send(JSON.stringify({type:'response.created',response:{id:'older-response'}}));
  });});
  const hooks:VoiceHooks={consumeToken:()=>({sessionId:'overlap-response-session',caseId:'case-9'}),isActive:()=>true,getContext:()=>'{}',persist:()=>undefined,status:()=>undefined};
  const server=createServer();const relay=attachVoiceServer(server,hooks,{upstreamUrl:`ws://127.0.0.1:${upstreamAddress.port}`,configOverride:{provider:'openai',apiKey:'key',model:'gpt-realtime-2.1'}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await relay.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await new Promise<void>(resolve=>upstream.close(()=>resolve()));});
  const address=server.address();assert(address&&typeof address!=='string');const browser=new WebSocket(`ws://127.0.0.1:${address.port}/voice?token=x`,{headers:{Origin:`http://127.0.0.1:${address.port}`}});
  const events:string[]=[];browser.on('message',data=>events.push(data.toString()));await waitUntil(()=>events.some(event=>event.includes('"type":"ready"'))&&providerSocket!==null);
  const emit=(value:object)=>providerSocket!.send(JSON.stringify(value));const firstAudio=Buffer.alloc(48_000).toString('base64');
  emit({type:'response.created',response:{id:'newer-response'}});
  emit({type:'response.output_item.added',response_id:'newer-response',item:{id:'newer-output'}});
  emit({type:'response.output_audio.delta',response_id:'newer-response',item_id:'newer-output',delta:firstAudio});
  await waitUntil(()=>events.some(event=>event.includes('"type":"audio"')));
  emit({type:'response.done',response:{id:'older-response',usage:realtimeUsage()}});
  const moreAudio=Buffer.alloc(192_000).toString('base64');
  for(let index=0;index<20&&!received.some(event=>event.type==='response.cancel');index+=1){emit({type:'response.output_audio.delta',response_id:'newer-response',item_id:'newer-output',delta:moreAudio});await new Promise(resolve=>setTimeout(resolve,2));}
  await waitForClose(browser);await waitUntil(()=>received.some(event=>event.type==='response.cancel'));
  assert(events.some(event=>event.includes('费用保护阈值')));
  const latest=getUsageSummary('org-demo','case-9',true).records[0];assert.equal(latest.status,'unknown');assert.equal(latest.costMicros,1_920);
});

test('OpenAI voice applies schema before input and stops at the configured duration limit',async(t)=>{
  const prior=process.env.OPENAI_VOICE_MAX_SECONDS;process.env.OPENAI_VOICE_MAX_SECONDS='1';
  t.after(()=>{if(prior===undefined)delete process.env.OPENAI_VOICE_MAX_SECONDS;else process.env.OPENAI_VOICE_MAX_SECONDS=prior;});
  const upstream=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise<void>(resolve=>upstream.once('listening',resolve));
  const upstreamAddress=upstream.address();assert(upstreamAddress&&typeof upstreamAddress!=='string');const received:Record<string,unknown>[]=[];let inputBeforeSchema=false,schemaApplied=false;
  upstream.on('connection',socket=>{socket.send(JSON.stringify({type:'session.created',session:{model:'gpt-realtime-2.1'}}));socket.on('message',data=>{
    const event=JSON.parse(data.toString()) as Record<string,unknown>;received.push(event);
    if(!schemaApplied&&(event.type==='conversation.item.create'||event.type==='response.create'))inputBeforeSchema=true;
    if(event.type==='session.update')setTimeout(()=>{schemaApplied=true;socket.send(JSON.stringify({type:'session.updated'}));},25);
    if(event.type==='response.create'){socket.send(JSON.stringify({type:'response.created',response:{id:'duration-response'}}));socket.send(JSON.stringify({type:'response.done',response:{id:'duration-response',usage:realtimeUsage()}}));}
  });});
  const diagnostics:unknown[]=[];const hooks:VoiceHooks={consumeToken:()=>({sessionId:'duration-session',caseId:'case-7'}),isActive:()=>true,getContext:()=>'{}',persist:()=>undefined,status:()=>undefined,diagnostic:(_session,event)=>{diagnostics.push(event);}};
  const server=createServer();const relay=attachVoiceServer(server,hooks,{upstreamUrl:`ws://127.0.0.1:${upstreamAddress.port}`,configOverride:{provider:'openai',apiKey:'key',model:'gpt-realtime-2.1'}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await relay.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await new Promise<void>(resolve=>upstream.close(()=>resolve()));});
  const address=server.address();assert(address&&typeof address!=='string');const browser=new WebSocket(`ws://127.0.0.1:${address.port}/voice?token=x`,{headers:{Origin:`http://127.0.0.1:${address.port}`}});
  const events:string[]=[];browser.on('message',data=>events.push(data.toString()));await waitForClose(browser);
  const update=received.find(event=>event.type==='session.update')?.session as {max_output_tokens?:number}|undefined;
  assert.equal(inputBeforeSchema,false);assert.equal(update?.max_output_tokens,512);assert(events.some(event=>event.includes('连续语音时长上限')));
  assert.deepEqual(diagnostics,[{code:'voice_duration_limit',stage:'runtime'}]);
});

test('OpenAI closes the chargeable transport before waiting for a stuck persist',async(t)=>{
  const upstream=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise<void>(resolve=>upstream.once('listening',resolve));
  const upstreamAddress=upstream.address();assert(upstreamAddress&&typeof upstreamAddress!=='string');let responseCreates=0,releasePersist!:()=>void,persistStarted=false;
  const persistGate=new Promise<void>(resolve=>{releasePersist=resolve;});let upstreamClosed!:()=>void;const upstreamClosedPromise=new Promise<void>(resolve=>{upstreamClosed=resolve;});
  upstream.on('connection',socket=>{socket.on('close',()=>upstreamClosed());socket.send(JSON.stringify({type:'session.created',session:{model:'gpt-realtime-2.1'}}));socket.on('message',data=>{
    const event=JSON.parse(data.toString()) as Record<string,unknown>;
    if(event.type==='session.update')socket.send(JSON.stringify({type:'session.updated'}));
    if(event.type==='response.create'){responseCreates+=1;const responseId=`persist-response-${responseCreates}`;socket.send(JSON.stringify({type:'response.created',response:{id:responseId}}));socket.send(JSON.stringify({type:'response.done',response:{id:responseId,usage:realtimeUsage()}}));}
  });});
  const hooks:VoiceHooks={consumeToken:()=>({sessionId:'stuck-persist-session',caseId:'case-8'}),isActive:()=>true,getContext:()=>'{}',persist:()=>{persistStarted=true;return persistGate;},status:()=>undefined};
  const server=createServer();const relay=attachVoiceServer(server,hooks,{upstreamUrl:`ws://127.0.0.1:${upstreamAddress.port}`,configOverride:{provider:'openai',apiKey:'key',model:'gpt-realtime-2.1'}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{releasePersist();await relay.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await new Promise<void>(resolve=>upstream.close(()=>resolve()));});
  const address=server.address();assert(address&&typeof address!=='string');const browser=new WebSocket(`ws://127.0.0.1:${address.port}/voice?token=x`,{headers:{Origin:`http://127.0.0.1:${address.port}`}});
  const events:string[]=[];browser.on('message',data=>events.push(data.toString()));await waitUntil(()=>events.some(event=>event.includes('"type":"ready"'))&&responseCreates===1);
  browser.send(JSON.stringify({text:'这条消息的本地持久化会暂时卡住。'}));await waitUntil(()=>persistStarted&&responseCreates===2);
  const closing=closeVoiceSession('stuck-persist-session',500);await Promise.race([upstreamClosedPromise,new Promise((_,reject)=>setTimeout(()=>reject(new Error('upstream stayed open behind persist')),1_000))]);
  assert.equal(await Promise.race([closing.then(()=>true),new Promise<boolean>(resolve=>setTimeout(()=>resolve(false),20))]),false);
  releasePersist();assert.deepEqual(await closing,{timedOut:false});
});

test('OpenAI voice refuses upstream before spend when the application budget is exhausted',async(t)=>{
  const prior=process.env.AI_CASE_BUDGET_USD;process.env.AI_CASE_BUDGET_USD='0';
  t.after(()=>{if(prior===undefined)delete process.env.AI_CASE_BUDGET_USD;else process.env.AI_CASE_BUDGET_USD=prior;});
  const upstream=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise<void>(resolve=>upstream.once('listening',resolve));
  const upstreamAddress=upstream.address();assert(upstreamAddress&&typeof upstreamAddress!=='string');let connections=0;upstream.on('connection',()=>{connections+=1;});
  const diagnostics:unknown[]=[];const hooks:VoiceHooks={consumeToken:()=>({sessionId:'budget-session',caseId:'case-3'}),isActive:()=>true,getContext:()=>'{}',persist:()=>undefined,status:()=>undefined,diagnostic:(_session,event)=>{diagnostics.push(event);}};
  const server=createServer();const relay=attachVoiceServer(server,hooks,{upstreamUrl:`ws://127.0.0.1:${upstreamAddress.port}`,configOverride:{provider:'openai',apiKey:'key',model:'gpt-realtime-2.1'}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await relay.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await new Promise<void>(resolve=>upstream.close(()=>resolve()));});
  const address=server.address();assert(address&&typeof address!=='string');const browser=new WebSocket(`ws://127.0.0.1:${address.port}/voice?token=x`,{headers:{Origin:`http://127.0.0.1:${address.port}`}});
  const events:string[]=[];browser.on('message',data=>events.push(data.toString()));const closed=await waitForClose(browser);
  assert.equal(closed.code,1013);assert.equal(connections,0);assert(events.some(event=>event.includes('费用保护')));assert.deepEqual(diagnostics,[{code:'spending_limit',stage:'preflight'}]);
});

test('OpenAI context setup times out without opening upstream and releases the setup lock',async(t)=>{
  addUsageTestCase('case-context-timeout');
  const upstream=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise<void>(resolve=>upstream.once('listening',resolve));
  const upstreamAddress=upstream.address();assert(upstreamAddress&&typeof upstreamAddress!=='string');let connections=0,contextCalls=0;
  upstream.on('connection',socket=>{connections+=1;socket.send(JSON.stringify({type:'session.created',session:{model:'gpt-realtime-2.1'}}));socket.on('message',data=>{const event=JSON.parse(data.toString()) as Record<string,unknown>;if(event.type==='session.update')socket.send(JSON.stringify({type:'session.updated'}));if(event.type==='response.create'){socket.send(JSON.stringify({type:'response.created',response:{id:'context-retry-response'}}));socket.send(JSON.stringify({type:'response.done',response:{id:'context-retry-response',usage:realtimeUsage()}}));}});});
  const diagnostics:unknown[]=[];const hooks:VoiceHooks={consumeToken:()=>({sessionId:'context-timeout-session',caseId:'case-context-timeout'}),isActive:()=>true,getContext:()=>{contextCalls+=1;return contextCalls===1?new Promise<string>(()=>undefined):'{}';},persist:()=>undefined,status:()=>undefined,diagnostic:(_session,event)=>{diagnostics.push(event);return new Promise<void>(()=>undefined);}};
  const server=createServer();const relay=attachVoiceServer(server,hooks,{upstreamUrl:`ws://127.0.0.1:${upstreamAddress.port}`,configOverride:{provider:'openai',apiKey:'key',model:'gpt-realtime-2.1'}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await relay.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await new Promise<void>(resolve=>upstream.close(()=>resolve()));});
  const address=server.address();assert(address&&typeof address!=='string');const url=`ws://127.0.0.1:${address.port}/voice?token=x`;const origin={headers:{Origin:`http://127.0.0.1:${address.port}`}};
  const first=new WebSocket(url,origin);first.on('error',()=>undefined);const firstEvents:string[]=[];first.on('message',data=>firstEvents.push(data.toString()));await waitForClose(first,3_000);
  assert.equal(connections,0);assert.deepEqual(diagnostics,[{code:'context_unavailable',stage:'context'}]);
  assert.equal(getUsageSummary('org-demo','case-context-timeout',true).records[0]?.status,'released');
  const retry=new WebSocket(url,origin);retry.on('error',()=>undefined);const retryEvents:string[]=[];retry.on('message',data=>retryEvents.push(data.toString()));await waitUntil(()=>retryEvents.some(event=>event.includes('"type":"ready"')));
  assert.equal(connections,1);assert.equal(contextCalls,2);assert.deepEqual(await closeVoiceSession('context-timeout-session',500),{timedOut:false});
});

test('OpenAI setup and active duplicates use dedicated codes without a second reservation',async(t)=>{
  addUsageTestCase('case-duplicate');
  const upstream=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise<void>(resolve=>upstream.once('listening',resolve));
  const upstreamAddress=upstream.address();assert(upstreamAddress&&typeof upstreamAddress!=='string');let connections=0,releaseContext!:()=>void;
  const contextReady=new Promise<void>(resolve=>{releaseContext=resolve;});let markContextStarted!:()=>void;const contextStarted=new Promise<void>(resolve=>{markContextStarted=resolve;});
  upstream.on('connection',socket=>{connections+=1;socket.send(JSON.stringify({type:'session.created',session:{model:'gpt-realtime-2.1'}}));socket.on('message',data=>{const event=JSON.parse(data.toString()) as Record<string,unknown>;if(event.type==='session.update')socket.send(JSON.stringify({type:'session.updated'}));if(event.type==='response.create'){socket.send(JSON.stringify({type:'response.created',response:{id:'duplicate-response'}}));socket.send(JSON.stringify({type:'response.done',response:{id:'duplicate-response',usage:realtimeUsage()}}));}});});
  const diagnostics:unknown[]=[];const hooks:VoiceHooks={consumeToken:()=>({sessionId:'duplicate-session',caseId:'case-duplicate'}),isActive:()=>true,getContext:async()=>{markContextStarted();await contextReady;return '{}';},persist:()=>undefined,status:()=>undefined,diagnostic:(_session,event)=>{diagnostics.push(event);}};
  const before=getUsageSummary('org-demo','case-duplicate',true).records.length;const server=createServer();const relay=attachVoiceServer(server,hooks,{upstreamUrl:`ws://127.0.0.1:${upstreamAddress.port}`,configOverride:{provider:'openai',apiKey:'key',model:'gpt-realtime-2.1'}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await relay.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await new Promise<void>(resolve=>upstream.close(()=>resolve()));});
  const address=server.address();assert(address&&typeof address!=='string');const url=`ws://127.0.0.1:${address.port}/voice?token=x`;const origin={headers:{Origin:`http://127.0.0.1:${address.port}`}};
  const first=new WebSocket(url,origin);first.on('error',()=>undefined);const firstEvents:string[]=[];first.on('message',data=>firstEvents.push(data.toString()));await contextStarted;
  const duringSetup=new WebSocket(url,origin);duringSetup.on('error',()=>undefined);const setupEvents:string[]=[];duringSetup.on('message',data=>setupEvents.push(data.toString()));await waitForClose(duringSetup);
  assert(setupEvents.some(event=>event.includes('session_closing')));assert.equal(connections,0);assert.equal(getUsageSummary('org-demo','case-duplicate',true).records.length,before+1);
  releaseContext();await waitUntil(()=>firstEvents.some(event=>event.includes('"type":"ready"')));
  const whileActive=new WebSocket(url,origin);whileActive.on('error',()=>undefined);const activeEvents:string[]=[];whileActive.on('message',data=>activeEvents.push(data.toString()));await waitForClose(whileActive);
  assert(activeEvents.some(event=>event.includes('session_already_active')));assert.equal(connections,1);assert.equal(getUsageSummary('org-demo','case-duplicate',true).records.length,before+1);
  assert.deepEqual(diagnostics,[{code:'session_closing',stage:'preflight'},{code:'session_already_active',stage:'preflight'}]);assert.deepEqual(await closeVoiceSession('duplicate-session',500),{timedOut:false});
});

test('OpenAI releases a reservation when the interview pauses while context is loading',async(t)=>{
  addUsageTestCase('case-paused-context');
  const upstream=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise<void>(resolve=>upstream.once('listening',resolve));
  const upstreamAddress=upstream.address();assert(upstreamAddress&&typeof upstreamAddress!=='string');let connections=0,active=true,resolveContext!:()=>void,markStarted!:()=>void;
  const contextStarted=new Promise<void>(resolve=>{markStarted=resolve;});const pendingContext=new Promise<void>(resolve=>{resolveContext=resolve;});upstream.on('connection',()=>{connections+=1;});
  const hooks:VoiceHooks={consumeToken:()=>({sessionId:'paused-context-session',caseId:'case-paused-context'}),isActive:()=>active,getContext:async()=>{markStarted();await pendingContext;return '{}';},persist:()=>undefined,status:()=>undefined};
  const server=createServer();const relay=attachVoiceServer(server,hooks,{upstreamUrl:`ws://127.0.0.1:${upstreamAddress.port}`,configOverride:{provider:'openai',apiKey:'key',model:'gpt-realtime-2.1'}});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await relay.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await new Promise<void>(resolve=>upstream.close(()=>resolve()));});const address=server.address();assert(address&&typeof address!=='string');
  const browser=new WebSocket(`ws://127.0.0.1:${address.port}/voice?token=x`,{headers:{Origin:`http://127.0.0.1:${address.port}`}});browser.on('error',()=>undefined);await contextStarted;active=false;resolveContext();await waitForClose(browser);
  assert.equal(connections,0);assert.equal(getUsageSummary('org-demo','case-paused-context',true).records[0]?.status,'released');
});

test('OpenAI reconnect waits for the prior drain before reserving the same session again',async(t)=>{
  const upstream=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise<void>(resolve=>upstream.once('listening',resolve));
  const upstreamAddress=upstream.address();assert(upstreamAddress&&typeof upstreamAddress!=='string');let connections=0,responseCreates=0,markFirstCreated!:()=>void;
  const firstCreated=new Promise<void>(resolve=>{markFirstCreated=resolve;});
  upstream.on('connection',socket=>{connections+=1;socket.send(JSON.stringify({type:'session.created',session:{model:'gpt-realtime-2.1'}}));socket.on('message',data=>{
    const event=JSON.parse(data.toString()) as Record<string,unknown>;
    if(event.type==='session.update')socket.send(JSON.stringify({type:'session.updated'}));
    if(event.type==='response.create'){
      responseCreates+=1;const responseId=`reconnect-response-${responseCreates}`;socket.send(JSON.stringify({type:'response.created',response:{id:responseId}}));
      if(responseCreates===1){markFirstCreated();setTimeout(()=>socket.send(JSON.stringify({type:'response.done',response:{id:responseId,usage:realtimeUsage()}})),300);}
      else socket.send(JSON.stringify({type:'response.done',response:{id:responseId,usage:realtimeUsage()}}));
    }
  });});
  const diagnostics:unknown[]=[];const hooks:VoiceHooks={consumeToken:()=>({sessionId:'reconnect-drain-session',caseId:'case-9'}),isActive:()=>true,getContext:()=>'{}',persist:()=>undefined,status:()=>undefined,diagnostic:(_session,event)=>{diagnostics.push(event);}};
  const recordsBefore=getUsageSummary('org-demo','case-9',true).records.length;
  const server=createServer();const relay=attachVoiceServer(server,hooks,{upstreamUrl:`ws://127.0.0.1:${upstreamAddress.port}`,configOverride:{provider:'openai',apiKey:'key',model:'gpt-realtime-2.1'}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await relay.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await new Promise<void>(resolve=>upstream.close(()=>resolve()));});
  const address=server.address();assert(address&&typeof address!=='string');
  const first=new WebSocket(`ws://127.0.0.1:${address.port}/voice?token=first`,{headers:{Origin:`http://127.0.0.1:${address.port}`}});first.on('error',()=>undefined);
  await firstCreated;const draining=closeVoiceSession('reconnect-drain-session',1_500);
  await new Promise(resolve=>setTimeout(resolve,50));
  const second=new WebSocket(`ws://127.0.0.1:${address.port}/voice?token=second`,{headers:{Origin:`http://127.0.0.1:${address.port}`}});const secondEvents:string[]=[];second.on('message',data=>secondEvents.push(data.toString()));second.on('error',()=>undefined);
  await waitUntil(()=>secondEvents.some(event=>event.includes('"type":"ready"')),2_000);await draining;
  assert.equal(connections,2);assert.equal(secondEvents.some(event=>event.includes('spending_limit')),false);assert.equal(diagnostics.length,0);
  assert.deepEqual(await closeVoiceSession('reconnect-drain-session',500),{timedOut:false});
  const newRecords=getUsageSummary('org-demo','case-9',true).records.slice(0,2);assert.equal(getUsageSummary('org-demo','case-9',true).records.length,recordsBefore+2);assert(newRecords.every(record=>record.status==='settled'));
});

test('OpenAI voice keeps its reservation unknown when provider usage is missing',async(t)=>{
  const upstream=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise<void>(resolve=>upstream.once('listening',resolve));
  const upstreamAddress=upstream.address();assert(upstreamAddress&&typeof upstreamAddress!=='string');
  upstream.on('connection',socket=>{socket.send(JSON.stringify({type:'session.created',session:{model:'gpt-realtime-2.1'}}));socket.on('message',data=>{const event=JSON.parse(data.toString()) as Record<string,unknown>;if(event.type==='session.update')socket.send(JSON.stringify({type:'session.updated'}));if(event.type==='response.create'){socket.send(JSON.stringify({type:'response.created',response:{id:'missing-usage-response'}}));socket.send(JSON.stringify({type:'response.done',response:{id:'missing-usage-response'}}));}});});
  const diagnostics:unknown[]=[];const hooks:VoiceHooks={consumeToken:()=>({sessionId:'missing-usage-session',caseId:'case-2'}),isActive:()=>true,getContext:()=>'{}',persist:()=>undefined,status:()=>undefined,diagnostic:(_session,event)=>{diagnostics.push(event);}};
  const server=createServer();const relay=attachVoiceServer(server,hooks,{upstreamUrl:`ws://127.0.0.1:${upstreamAddress.port}`,configOverride:{provider:'openai',apiKey:'key',model:'gpt-realtime-2.1'}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await relay.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await new Promise<void>(resolve=>upstream.close(()=>resolve()));});
  const address=server.address();assert(address&&typeof address!=='string');const browser=new WebSocket(`ws://127.0.0.1:${address.port}/voice?token=x`,{headers:{Origin:`http://127.0.0.1:${address.port}`}});
  const events:string[]=[];browser.on('message',data=>events.push(data.toString()));await waitForClose(browser);await waitUntil(()=>!hasVoiceSession('missing-usage-session'));
  assert(events.some(event=>event.includes('未返回可核对的用量')));assert.deepEqual(diagnostics,[{code:'voice_usage_unverified',stage:'runtime'}]);
  const latest=getUsageSummary('org-demo','case-2',true).records[0];assert.equal(latest.status,'unknown');assert.equal(latest.reservedMicros,2_000_000);
});

test('OpenAI upstream errors log only safe diagnostics and expose a classified client error',async(t)=>{
  const logged:unknown[][]=[];t.mock.method(console,'error',(...args:unknown[])=>{logged.push(args);});
  const upstream=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise<void>(resolve=>upstream.once('listening',resolve));
  const upstreamAddress=upstream.address();assert(upstreamAddress&&typeof upstreamAddress!=='string');
  upstream.on('connection',socket=>{
    socket.send(JSON.stringify({type:'session.created',session:{model:'gpt-realtime-2.1'}}));
    socket.send(JSON.stringify({type:'error',api_key:'raw-key-must-not-log',case_context:'private-case-context',error:{type:'invalid_request_error',code:'insufficient_quota',param:'session.audio.input.transcription.model',message:'SECRET provider message with customer and credential data'}}));
  });
  const diagnostics:unknown[]=[];const hooks:VoiceHooks={consumeToken:()=>({sessionId:'safe-error-session',caseId:'case-12'}),isActive:()=>true,getContext:()=>'private context must not log',persist:()=>undefined,status:()=>undefined,diagnostic:(_session,event)=>{diagnostics.push(event);}};
  const server=createServer();const relay=attachVoiceServer(server,hooks,{upstreamUrl:`ws://127.0.0.1:${upstreamAddress.port}`,configOverride:{provider:'openai',apiKey:'raw-key-must-not-log',model:'gpt-realtime-2.1',transcriptionModel:'whisper-1'}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await relay.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await new Promise<void>(resolve=>upstream.close(()=>resolve()));});
  const address=server.address();assert(address&&typeof address!=='string');const browser=new WebSocket(`ws://127.0.0.1:${address.port}/voice?token=x`,{headers:{Origin:`http://127.0.0.1:${address.port}`}});
  const events:Record<string,unknown>[]=[];browser.on('message',data=>events.push(JSON.parse(data.toString()) as Record<string,unknown>));await waitForClose(browser);
  const clientError=events.find(event=>event.type==='error');assert.equal(clientError?.code,'provider_quota');assert.equal(clientError?.retryable,false);assert.match(String(clientError?.message),/额度|余额/);
  assert.deepEqual(diagnostics,[{code:'provider_quota',stage:'upstream'}]);
  const safeLog=JSON.stringify(logged);assert.match(safeLog,/insufficient_quota/);assert.match(safeLog,/invalid_request_error/);assert.match(safeLog,/session\.audio\.input\.transcription\.model/);
  assert.doesNotMatch(safeLog,/SECRET|raw-key-must-not-log|private-case-context|private context must not log|provider message/);
  const latest=getUsageSummary('org-demo','case-12',true).records[0];assert.equal(latest.status,'unknown');assert(latest.reservedMicros>0);
});

test('OpenAI voice fixes Whisper for the session and meters duration usage at its configured rate',async(t)=>{
  const upstream=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise<void>(resolve=>upstream.once('listening',resolve));
  const upstreamAddress=upstream.address();assert(upstreamAddress&&typeof upstreamAddress!=='string');const received:Record<string,unknown>[]=[];
  upstream.on('connection',socket=>{socket.send(JSON.stringify({type:'session.created',session:{model:'gpt-realtime-2.1'}}));socket.on('message',data=>{
    const event=JSON.parse(data.toString()) as Record<string,unknown>;received.push(event);
    if(event.type==='session.update')socket.send(JSON.stringify({type:'session.updated'}));
    if(event.type==='response.create'){
      socket.send(JSON.stringify({type:'response.created',response:{id:'whisper-response'}}));
      socket.send(JSON.stringify({type:'response.done',response:{id:'whisper-response',usage:realtimeUsage(0,0)}}));
      socket.send(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',item_id:'whisper-input',transcript:'Whisper 测试转写。',usage:{type:'duration',seconds:60}}));
    }
  });});
  const hooks:VoiceHooks={consumeToken:()=>({sessionId:'whisper-session',caseId:'case-10'}),isActive:()=>true,getContext:()=>'{}',persist:()=>undefined,status:()=>undefined};
  const server=createServer();const relay=attachVoiceServer(server,hooks,{upstreamUrl:`ws://127.0.0.1:${upstreamAddress.port}`,configOverride:{provider:'openai',apiKey:'key',model:'gpt-realtime-2.1',transcriptionModel:'whisper-1'}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await relay.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await new Promise<void>(resolve=>upstream.close(()=>resolve()));});
  const address=server.address();assert(address&&typeof address!=='string');const browser=new WebSocket(`ws://127.0.0.1:${address.port}/voice?token=x`,{headers:{Origin:`http://127.0.0.1:${address.port}`}});
  const events:string[]=[];browser.on('message',data=>events.push(data.toString()));await waitUntil(()=>events.some(event=>event.includes('Whisper 测试转写')));
  const session=received.find(event=>event.type==='session.update')?.session as {audio?:{input?:{transcription?:{model?:string}}}}|undefined;
  assert.equal(session?.audio?.input?.transcription?.model,'whisper-1');assert.deepEqual(await closeVoiceSession('whisper-session',500),{timedOut:false});
  const latest=getUsageSummary('org-demo','case-10',true).records[0];assert.equal(latest.status,'settled');assert.equal(latest.costMicros,6_000);assert.equal(latest.transcriptionSeconds,60);
});

test('unknown OpenAI transcription model is rejected before opening an upstream connection',async(t)=>{
  const keys=['VOICE_PROVIDER','OPENAI_API_KEY','OPENAI_REALTIME_MODEL','OPENAI_TRANSCRIPTION_MODEL'] as const;const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  t.after(()=>{for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}});
  process.env.VOICE_PROVIDER='openai';process.env.OPENAI_API_KEY='synthetic-unused';process.env.OPENAI_REALTIME_MODEL='gpt-realtime-2.1';process.env.OPENAI_TRANSCRIPTION_MODEL='unknown-transcriber';
  const recordsBefore=getUsageSummary('org-demo','case-11',true).records.length;
  const upstream=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise<void>(resolve=>upstream.once('listening',resolve));
  const upstreamAddress=upstream.address();assert(upstreamAddress&&typeof upstreamAddress!=='string');let connections=0;upstream.on('connection',()=>{connections+=1;});
  const hooks:VoiceHooks={consumeToken:()=>({sessionId:'invalid-transcriber-session',caseId:'case-11'}),isActive:()=>true,getContext:()=>'{}',persist:()=>undefined,status:()=>undefined};
  const server=createServer();const relay=attachVoiceServer(server,hooks,{upstreamUrl:`ws://127.0.0.1:${upstreamAddress.port}`});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await relay.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await new Promise<void>(resolve=>upstream.close(()=>resolve()));});
  const address=server.address();assert(address&&typeof address!=='string');const browser=new WebSocket(`ws://127.0.0.1:${address.port}/voice?token=x`,{headers:{Origin:`http://127.0.0.1:${address.port}`}});
  const events:string[]=[];browser.on('message',data=>events.push(data.toString()));assert.equal((await waitForClose(browser)).code,1013);
  assert.equal(connections,0);assert(events.some(event=>event.includes('转写模型配置无效')));assert.equal(getUsageSummary('org-demo','case-11',true).records.length,recordsBefore);
});

test('OpenAI voice stops after settled usage reaches the application protection threshold',async(t)=>{
  const upstream=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise<void>(resolve=>upstream.once('listening',resolve));
  const upstreamAddress=upstream.address();assert(upstreamAddress&&typeof upstreamAddress!=='string');
  upstream.on('connection',socket=>{socket.send(JSON.stringify({type:'session.created',session:{model:'gpt-realtime-2.1'}}));socket.on('message',data=>{const event=JSON.parse(data.toString()) as Record<string,unknown>;if(event.type==='session.update')socket.send(JSON.stringify({type:'session.updated'}));if(event.type==='response.create'){socket.send(JSON.stringify({type:'response.created',response:{id:'costly-response'}}));socket.send(JSON.stringify({type:'response.done',response:{id:'costly-response',usage:realtimeUsage(0,27_700)}}));}});});
  const hooks:VoiceHooks={consumeToken:()=>({sessionId:'cost-limit-session',caseId:'case-4'}),isActive:()=>true,getContext:()=>'{}',persist:()=>undefined,status:()=>undefined};
  const server=createServer();const relay=attachVoiceServer(server,hooks,{upstreamUrl:`ws://127.0.0.1:${upstreamAddress.port}`,configOverride:{provider:'openai',apiKey:'key',model:'gpt-realtime-2.1'}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await relay.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await new Promise<void>(resolve=>upstream.close(()=>resolve()));});
  const address=server.address();assert(address&&typeof address!=='string');const browser=new WebSocket(`ws://127.0.0.1:${address.port}/voice?token=x`,{headers:{Origin:`http://127.0.0.1:${address.port}`}});
  const events:string[]=[];browser.on('message',data=>events.push(data.toString()));await waitForClose(browser);await waitUntil(()=>!hasVoiceSession('cost-limit-session'));
  assert(events.some(event=>event.includes('费用保护阈值')));
  const latest=getUsageSummary('org-demo','case-4',true).records[0];assert.equal(latest.status,'settled');assert(latest.costMicros>=1_770_000);
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
  const hooks:VoiceHooks = {consumeToken:()=>({sessionId:'mock-voice',caseId:'mock-case'}),isActive:()=>true,getContext:()=>'{"mock":true}',persist:()=>undefined,status:()=>undefined};
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
