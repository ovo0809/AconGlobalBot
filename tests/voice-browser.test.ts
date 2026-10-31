import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserVoiceClient } from '../lib/browser-voice';

function waitUntil(check:()=>boolean,timeoutMs=2_500){return new Promise<void>((resolve,reject)=>{const started=Date.now();const timer=setInterval(()=>{if(check()){clearInterval(timer);resolve();}else if(Date.now()-started>timeoutMs){clearInterval(timer);reject(new Error('Timed out'));}},5);});}

function installConnectedBrowserFakes(t:{after(fn:()=>void):void}){
  let stopped=0,closedContexts=0;
  let playbackClock=0;
  let resumePlayback:Promise<void>|null=null;
  const sources:Array<{buffer:{duration:number}|null;startedAt:number|null;stopped:boolean;onended:(()=>void)|null;end:()=>void}>=[];
  const descriptors=Object.fromEntries(['navigator','window','location','AudioContext','WebSocket','fetch'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  t.after(()=>{for(const [key,descriptor] of Object.entries(descriptors)){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete (globalThis as Record<string,unknown>)[key];}});
  const track={enabled:true,stop(){stopped+=1;}};
  const stream={active:true,getTracks:()=>[track],getAudioTracks:()=>[track]};
  const connectable={connect(target:unknown){return target;},disconnect(){}};
  class FakeAudioContext {
    sampleRate=48_000;destination={};
    get currentTime(){return playbackClock;}
    constructor(private options?:{sampleRate?:number}){}
    async resume(){if(this.options?.sampleRate&&resumePlayback)await resumePlayback;} createMediaStreamSource(){return connectable;} createGain(){return {...connectable,gain:{value:1}};} createScriptProcessor(){return {...connectable,onaudioprocess:null};}
    createBuffer(_channels:number,length:number,rate:number){return {duration:length/rate,getChannelData:()=>new Float32Array(length)};}
    createBufferSource(){
      const source={buffer:null as {duration:number}|null,startedAt:null as number|null,stopped:false,onended:null as (()=>void)|null,connect(){},disconnect(){},start(at:number){this.startedAt=at;},stop(){this.stopped=true;queueMicrotask(()=>this.onended?.());},end(){this.onended?.();}};
      sources.push(source);return source;
    }
    async close(){closedContexts+=1;}
  }
  class FakeWebSocket {
    static OPEN=1;readyState=1;sent:string[]=[];
    onmessage:((event:{data:string})=>void)|null=null;onerror:(()=>void)|null=null;onclose:((event:{code:number})=>void)|null=null;
    constructor(){instances.push(this);}
    send(value:string){this.sent.push(value);}
    close(code=1000){if(this.readyState>=2)return;this.readyState=3;queueMicrotask(()=>this.onclose?.({code}));}
    serverEvent(value:object){this.onmessage?.({data:JSON.stringify(value)});}
    serverClose(code=1011){this.readyState=3;this.onclose?.({code});}
  }
  const instances:FakeWebSocket[]=[];
  let tokens=0;
  const getUserMedia=async()=>stream;
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia}}});
  Object.defineProperty(globalThis,'window',{configurable:true,value:{addEventListener(){},removeEventListener(){}}});
  Object.defineProperty(globalThis,'location',{configurable:true,value:{protocol:'http:',host:'127.0.0.1'}});
  Object.defineProperty(globalThis,'AudioContext',{configurable:true,value:FakeAudioContext});
  Object.defineProperty(globalThis,'WebSocket',{configurable:true,value:FakeWebSocket});
  Object.defineProperty(globalThis,'fetch',{configurable:true,value:async()=>new Response(JSON.stringify({token:`token-${++tokens}`}),{status:200,headers:{'content-type':'application/json'}})});
  return {instances,sources,getUserMedia,setClock:(seconds:number)=>{playbackClock=seconds;},deferPlayback:(promise:Promise<void>)=>{resumePlayback=promise;},get stopped(){return stopped;},get closedContexts(){return closedContexts;},get tokens(){return tokens;}};
}

const pcm100ms=Buffer.alloc(4_800).toString('base64');

test('generation completion waits for every queued PCM source to finish before listening',async(t)=>{
  const fake=installConnectedBrowserFakes(t);const states:string[]=[];const client=new BrowserVoiceClient({csrf:'test',onState:state=>states.push(state)});
  await client.start();const socket=fake.instances[0];socket.serverEvent({type:'ready'});
  socket.serverEvent({type:'audio',data:pcm100ms,mimeType:'audio/pcm;rate=24000',itemId:'reply-a'});
  socket.serverEvent({type:'audio',data:pcm100ms,mimeType:'audio/pcm;rate=24000',itemId:'reply-a'});
  socket.serverEvent({type:'turnComplete'});
  assert.equal(client.state,'speaking','done streaming is not done playing');
  await waitUntil(()=>fake.sources.length===2);
  assert.deepEqual(fake.sources.map(source=>source.startedAt),[0,.1]);
  fake.setClock(.1);fake.sources[0].end();assert.equal(client.state,'speaking');
  fake.setClock(.2);fake.sources[1].end();assert.equal(client.state,'listening');
  assert(fake.sources.every(source=>!source.stopped),'normal completion must not call stop on the tail');
  assert.equal(states.slice(states.lastIndexOf('speaking')+1).filter(state=>state==='listening').length,1);
  await client.pause();
});

test('interruption during the playback tail retains the item and actual played duration',async(t)=>{
  const fake=installConnectedBrowserFakes(t);const client=new BrowserVoiceClient({csrf:'test'});
  await client.start();const socket=fake.instances[0];socket.serverEvent({type:'ready'});
  socket.serverEvent({type:'audio',data:pcm100ms,mimeType:'audio/pcm;rate=24000',itemId:'reply-tail'});
  await waitUntil(()=>fake.sources.length===1);
  socket.serverEvent({type:'turnComplete'});fake.setClock(.04);
  socket.serverEvent({type:'interrupted',itemId:'reply-tail'});
  assert.deepEqual(JSON.parse(socket.sent.at(-1)!),{truncate:{itemId:'reply-tail',audioEndMs:40}});
  assert.equal(fake.sources[0].stopped,true);assert.equal(client.state,'listening');await client.pause();
});

test('a stale item interruption cannot stop a newer reply',async(t)=>{
  const fake=installConnectedBrowserFakes(t);const client=new BrowserVoiceClient({csrf:'test'});
  await client.start();const socket=fake.instances[0];socket.serverEvent({type:'ready'});
  socket.serverEvent({type:'audio',data:pcm100ms,mimeType:'audio/pcm;rate=24000',itemId:'reply-new'});
  await waitUntil(()=>fake.sources.length===1);
  socket.serverEvent({type:'interrupted',itemId:'reply-old'});
  assert.equal(fake.sources[0].stopped,false);assert.equal(client.state,'speaking');assert.equal(socket.sent.length,0);
  await client.pause();
});

test('a delayed older response completion cannot finish a newer audio response',async(t)=>{
  const fake=installConnectedBrowserFakes(t);const client=new BrowserVoiceClient({csrf:'test'});
  await client.start();const socket=fake.instances[0];socket.serverEvent({type:'ready'});
  socket.serverEvent({type:'audio',data:pcm100ms,mimeType:'audio/pcm;rate=24000',itemId:'reply-new',responseId:'response-new'});
  socket.serverEvent({type:'turnComplete',responseId:'response-old'});
  await waitUntil(()=>fake.sources.length===1);fake.setClock(.1);fake.sources[0].end();
  assert.equal(client.state,'speaking','the new response is still generating, even if its first chunk has ended');
  socket.serverEvent({type:'turnComplete',responseId:'response-new'});assert.equal(client.state,'listening');
  await client.pause();
});

test('an incomplete model response remains a final caption with its failure status, without stopping playback',async(t)=>{
  const fake=installConnectedBrowserFakes(t);const captions:unknown[]=[];
  const client=new BrowserVoiceClient({csrf:'test',onFinal:event=>captions.push(event)});
  await client.start();const socket=fake.instances[0];socket.serverEvent({type:'ready'});
  socket.serverEvent({type:'audio',data:pcm100ms,mimeType:'audio/pcm;rate=24000',itemId:'limited',responseId:'limited-response'});
  socket.serverEvent({type:'transcript',role:'assistant',text:'尚未说完的',final:true,responseStatus:'incomplete'});
  socket.serverEvent({type:'turnComplete',responseId:'limited-response'});
  assert.deepEqual(captions,[{role:'assistant',text:'尚未说完的',interrupted:false,responseStatus:'incomplete'}]);
  await waitUntil(()=>fake.sources.length===1);assert.equal(fake.sources[0].stopped,false);fake.sources[0].end();
  assert.equal(client.state,'listening');await client.pause();
});

test('pause cancels PCM waiting for AudioContext.resume and late completion cannot resume speech',async(t)=>{
  const fake=installConnectedBrowserFakes(t);const client=new BrowserVoiceClient({csrf:'test'});
  await client.start();const socket=fake.instances[0];socket.serverEvent({type:'ready'});
  let resume!:()=>void;fake.deferPlayback(new Promise<void>(resolve=>{resume=resolve;}));
  socket.serverEvent({type:'audio',data:pcm100ms,mimeType:'audio/pcm;rate=24000',itemId:'reply-paused'});
  socket.serverEvent({type:'turnComplete'});await new Promise(resolve=>setImmediate(resolve));
  await client.pause();resume();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(client.state,'paused');assert.equal(fake.sources.length,0);assert.equal(fake.stopped,1);
});

test('explicit pause and spending errors stop queued playback immediately, even after generation completes',async(t)=>{
  const fake=installConnectedBrowserFakes(t);
  for(const reason of ['pause','spending_protection']){
    const client=new BrowserVoiceClient({csrf:'test'});await client.start();const socket=fake.instances.at(-1)!;socket.serverEvent({type:'ready'});
    const count=fake.sources.length;
    socket.serverEvent({type:'audio',data:pcm100ms,mimeType:'audio/pcm;rate=24000',itemId:`reply-${reason}`});
    socket.serverEvent({type:'turnComplete'});await waitUntil(()=>fake.sources.length>count);
    if(reason==='pause')await client.pause();else socket.serverEvent({type:'error',code:reason,message:'spending protection'});
    assert.equal(fake.sources[count].stopped,true);assert.equal(client.state,reason==='pause'?'paused':'error');
    fake.sources[count].end();assert.equal(client.state,reason==='pause'?'paused':'error','late onended cannot restart listening');
  }
});

test('invalid PCM reports a playback error instead of silently poisoning later chunks',async(t)=>{
  const fake=installConnectedBrowserFakes(t);const errors:string[]=[];const client=new BrowserVoiceClient({csrf:'test',onError:message=>errors.push(message)});
  await client.start();const socket=fake.instances[0];socket.serverEvent({type:'ready'});
  socket.serverEvent({type:'audio',data:'not valid base64!',mimeType:'audio/pcm;rate=24000',itemId:'broken-audio'});
  socket.serverEvent({type:'audio',data:pcm100ms,mimeType:'audio/pcm;rate=24000',itemId:'broken-audio'});
  await waitUntil(()=>client.state==='error');assert.match(errors[0],/播放未完成/);
  assert.equal(fake.sources.length,0);assert.equal(fake.stopped,1);
});

test('unsupported microphone capability reports a reason, releases state and allows retry',async(t)=>{
  const fake=installConnectedBrowserFakes(t);Object.defineProperty(globalThis,'navigator',{configurable:true,value:{}});
  const errors:string[]=[];const client=new BrowserVoiceClient({csrf:'test',onError:message=>errors.push(message)});
  await assert.rejects(()=>client.start(),/不支持麦克风/);assert.equal(client.state,'error');assert.match(errors.at(-1)??'',/不支持麦克风/);assert.equal(fake.instances.length,0);
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:fake.getUserMedia}}});
  await client.start();assert.equal(fake.instances.length,1);fake.instances[0].serverEvent({type:'ready'});assert.equal(client.state,'listening');await client.pause();
});

test('browser voice releases microphone and audio context when token acquisition fails', async (t) => {
  let trackStopped=false,contextClosed=false;
  const descriptors={
    navigator:Object.getOwnPropertyDescriptor(globalThis,'navigator'),
    window:Object.getOwnPropertyDescriptor(globalThis,'window'),
    AudioContext:Object.getOwnPropertyDescriptor(globalThis,'AudioContext'),
    fetch:Object.getOwnPropertyDescriptor(globalThis,'fetch'),
  };
  t.after(()=>{
    for(const [key,descriptor] of Object.entries(descriptors)){
      if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete (globalThis as Record<string,unknown>)[key];
    }
  });
  const track={enabled:true,stop(){trackStopped=true;}};
  const stream={active:true,getTracks:()=>[track],getAudioTracks:()=>[track]};
  const connectable={connect(target:unknown){return target;},disconnect(){}};
  class FakeAudioContext {
    sampleRate=48_000;destination={};
    async resume(){}
    createMediaStreamSource(){return connectable;}
    createGain(){return {...connectable,gain:{value:1}};}
    createScriptProcessor(){return {...connectable,onaudioprocess:null};}
    async close(){contextClosed=true;}
  }
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:async()=>stream}}});
  Object.defineProperty(globalThis,'window',{configurable:true,value:{addEventListener(){},removeEventListener(){}}});
  Object.defineProperty(globalThis,'AudioContext',{configurable:true,value:FakeAudioContext});
  Object.defineProperty(globalThis,'fetch',{configurable:true,value:async()=>new Response(JSON.stringify({error:'实时语音未配置'}),{status:409,headers:{'content-type':'application/json'}})});
  const errors:string[]=[];
  const client=new BrowserVoiceClient({csrf:'test',onError:message=>errors.push(message)});
  await assert.rejects(()=>client.start(),/实时语音未配置/);
  assert.equal(trackStopped,true);
  assert.equal(contextClosed,true);
  assert.equal(client.state,'error');
  assert.deepEqual(errors,['实时语音未配置']);
});

test('terminal server error closes media and socket without leaving a reconnect alive',async(t)=>{
  const fake=installConnectedBrowserFakes(t);const errors:string[]=[];
  const client=new BrowserVoiceClient({csrf:'test',onError:message=>errors.push(message)});
  await client.start();assert.equal(fake.instances.length,1);
  fake.instances[0].serverEvent({type:'ready',inputSampleRate:24_000,outputSampleRate:24_000});
  fake.instances[0].serverEvent({type:'error',message:'terminal provider error'});
  await waitUntil(()=>fake.stopped===1&&fake.instances[0].readyState===3);
  await new Promise(resolve=>setTimeout(resolve,550));
  assert.equal(fake.instances.length,1);assert.equal(client.state,'error');assert.deepEqual(errors,['terminal provider error']);assert.equal(fake.closedContexts,1);
});

test('ready timeout releases media, reports a network reason and does not reconnect',async(t)=>{
  const fake=installConnectedBrowserFakes(t);const errors:string[]=[];const client=new BrowserVoiceClient({csrf:'test',readyTimeoutMs:20,onError:message=>errors.push(message)});
  await client.start();assert.equal(fake.instances.length,1);await waitUntil(()=>client.state==='error'&&fake.stopped===1);
  await new Promise(resolve=>setTimeout(resolve,550));assert.equal(fake.instances.length,1);assert.equal(fake.tokens,1);assert.match(errors.at(-1)??'',/连接超时/);assert.equal(fake.closedContexts,1);
});

test('budget server errors show a safe case-level reason without amounts or tokens',async(t)=>{
  const fake=installConnectedBrowserFakes(t);const errors:string[]=[];const client=new BrowserVoiceClient({csrf:'test',onError:message=>errors.push(message)});
  await client.start();fake.instances[0].serverEvent({type:'error',code:'spending_limit',retryable:false,message:'Budget $99 token=secret-value'});await waitUntil(()=>client.state==='error'&&fake.stopped===1);
  assert.equal(errors.at(-1),'当前案例暂不能启动语音，请顾问核对调用限制后重试。');assert.doesNotMatch(errors.join(' '),/\$99|secret-value|token=/);await new Promise(resolve=>setTimeout(resolve,550));assert.equal(fake.instances.length,1);
});

test('voice stop reasons distinguish overlapping connections, limits, missing usage and provider account without exposing raw details',async(t)=>{
  const fake=installConnectedBrowserFakes(t);const errors:string[]=[];
  const expected:Record<string,RegExp>={session_already_active:/另一个页面/,session_closing:/保存收尾/,spending_protection:/应用保护/,voice_usage_unverified:/完整的调用记录/,voice_duration_limit:/时长限制/,provider_quota:/服务账户/};
  for(const [code,pattern] of Object.entries(expected)){
    const client=new BrowserVoiceClient({csrf:'test',onError:message=>errors.push(message)});
    await client.start();fake.instances.at(-1)!.serverEvent({type:'error',code,retryable:false,message:'$99 token=secret-value sk-sensitive'});
    await waitUntil(()=>client.state==='error'&&fake.stopped===errors.length);assert.match(errors.at(-1)!,pattern);
  }
  assert.equal(new Set(errors).size,Object.keys(expected).length);assert.doesNotMatch(errors.join(' '),/\$99|secret-value|token=|sk-sensitive/);
});

test('ready handshakes do not reset the finite reconnect budget',async(t)=>{
  const fake=installConnectedBrowserFakes(t);const client=new BrowserVoiceClient({csrf:'test'});
  await client.start();
  fake.instances[0].serverEvent({type:'ready'});fake.instances[0].serverClose(1011);
  await waitUntil(()=>fake.instances.length===2);fake.instances[1].serverEvent({type:'ready'});fake.instances[1].serverClose(1011);
  await waitUntil(()=>fake.instances.length===3);fake.instances[2].serverEvent({type:'ready'});fake.instances[2].serverClose(1011);
  await new Promise(resolve=>setTimeout(resolve,600));
  assert.equal(fake.instances.length,3);assert.equal(fake.tokens,3);assert.equal(client.state,'error');
  await client.pause();
});
