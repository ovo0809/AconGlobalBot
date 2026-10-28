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

test('voice relay resumes an upstream session without repeating its proactive opening', async (t) => {
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
  assert.deepEqual(await closeVoiceSession('resume-session',500),{timedOut:false});
});

test('OpenAI realtime relay uses 24k audio, source item IDs, VAD interruption, and bounded truncation',async(t)=>{
  const upstream=new WebSocketServer({host:'127.0.0.1',port:0});
  await new Promise<void>(resolve=>upstream.once('listening',resolve));
  const upstreamAddress=upstream.address();assert(upstreamAddress&&typeof upstreamAddress!=='string');
  const received:Record<string,unknown>[]=[];let authorization='',requestUrl='';
  upstream.on('connection',(socket,request)=>{
    authorization=String(request.headers.authorization||'');requestUrl=request.url||'';
    socket.send(JSON.stringify({type:'session.created',session:{model:'test-openai-realtime'}}));
    socket.on('message',data=>{
      const event=JSON.parse(data.toString()) as Record<string,unknown>;received.push(event);
      if(event.type==='session.update')socket.send(JSON.stringify({type:'session.updated'}));
      if(event.type==='response.create'){
        const audio=Buffer.alloc(4_800).toString('base64');
        socket.send(JSON.stringify({type:'response.created'}));
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
        socket.send(JSON.stringify({type:'response.done',response:{status:'cancelled'}}));
        socket.send(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',item_id:'user-item-1',transcript:'我想保障家人。'}));
      }
    });
  });
  const persisted:Array<{role:string;text:string;final?:boolean;interrupted?:boolean;sourceItemId?:string;turnId:string}>=[];
  const hooks:VoiceHooks={consumeToken:()=>({sessionId:'openai-session',caseId:'openai-case'}),isActive:()=>true,getContext:()=>JSON.stringify({facts:[],questionPriority:['goal']}),persist:(_session,event)=>{persisted.push(event);},status:()=>undefined};
  const server=createServer();const relay=attachVoiceServer(server,hooks,{upstreamUrl:`ws://127.0.0.1:${upstreamAddress.port}`,configOverride:{provider:'openai',apiKey:'openai-test-key',model:'test-openai-realtime'}});
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
  assert.equal(authorization,'Bearer openai-test-key');assert.match(requestUrl,/model=test-openai-realtime/);
  const update=received.find(event=>event.type==='session.update')?.session as {audio?:{input?:{format?:unknown;turn_detection?:unknown};output?:{format?:unknown}};instructions?:string};
  assert.deepEqual(update.audio?.input?.format,{type:'audio/pcm',rate:24_000});assert.deepEqual(update.audio?.output?.format,{type:'audio/pcm',rate:24_000});assert.match(update.instructions||'',/questionPriority/);
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
  upstream.on('connection',socket=>{providerSocket=socket;socket.send(JSON.stringify({type:'session.created',session:{model:'test'}}));socket.on('message',data=>{const event=JSON.parse(data.toString()) as Record<string,unknown>;if(event.type==='session.update')socket.send(JSON.stringify({type:'session.updated'}));if(event.type==='response.create'){socket.send(JSON.stringify({type:'response.created',response:{id:'proactive-response'}}));socket.send(JSON.stringify({type:'response.output_item.added',item:{id:'proactive-output'}}));socket.send(JSON.stringify({type:'response.output_audio_transcript.done',item_id:'proactive-output',transcript:'先问一个问题'}));socket.send(JSON.stringify({type:'response.done'}));}});});
  const persisted:Array<{role:string;sourceItemId?:string;turnId:string}>=[];
  const hooks:VoiceHooks={consumeToken:()=>({sessionId:'two-turn-session',caseId:'case'}),isActive:()=>true,getContext:()=>'{}',persist:(_session,event)=>{persisted.push(event);},status:()=>undefined};
  const server=createServer();const relay=attachVoiceServer(server,hooks,{upstreamUrl:`ws://127.0.0.1:${upstreamAddress.port}`,configOverride:{provider:'openai',apiKey:'key',model:'model'}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await relay.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await new Promise<void>(resolve=>upstream.close(()=>resolve()));});
  const address=server.address();assert(address&&typeof address!=='string');const browser=new WebSocket(`ws://127.0.0.1:${address.port}/voice?token=x`,{headers:{Origin:`http://127.0.0.1:${address.port}`}});
  const events:string[]=[];browser.on('message',data=>events.push(data.toString()));await waitUntil(()=>events.some(event=>event.includes('"type":"ready"'))&&persisted.some(event=>event.sourceItemId==='proactive-output'));
  persisted.length=0;assert(providerSocket);
  const emit=(value:object)=>providerSocket!.send(JSON.stringify(value));
  emit({type:'input_audio_buffer.speech_started',item_id:'user-1'});emit({type:'input_audio_buffer.speech_stopped',item_id:'user-1'});emit({type:'input_audio_buffer.committed',item_id:'user-1'});
  emit({type:'response.created',response:{id:'response-1'}});emit({type:'response.output_item.added',item:{id:'assistant-1'}});emit({type:'response.output_audio_transcript.done',item_id:'assistant-1',transcript:'回答一'});emit({type:'response.done'});
  emit({type:'input_audio_buffer.speech_started',item_id:'user-2'});emit({type:'input_audio_buffer.speech_stopped',item_id:'user-2'});emit({type:'input_audio_buffer.committed',item_id:'user-2'});
  emit({type:'response.created',response:{id:'response-2'}});emit({type:'response.output_item.added',item:{id:'assistant-2'}});emit({type:'response.output_audio_transcript.done',item_id:'assistant-2',transcript:'回答二'});emit({type:'response.done'});
  emit({type:'conversation.item.input_audio_transcription.completed',item_id:'user-2',transcript:'用户二'});emit({type:'conversation.item.input_audio_transcription.completed',item_id:'user-1',transcript:'用户一'});
  await waitUntil(()=>persisted.length===4);
  const bySource=new Map(persisted.map(event=>[event.sourceItemId,event]));
  assert.equal(bySource.get('assistant-1')?.turnId,bySource.get('user-1')?.turnId);assert.equal(bySource.get('assistant-2')?.turnId,bySource.get('user-2')?.turnId);assert.notEqual(bySource.get('assistant-1')?.turnId,bySource.get('assistant-2')?.turnId);
  assert.deepEqual(await closeVoiceSession('two-turn-session',500),{timedOut:false});
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
