import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserRecordingClient, RecordingChunkAssembler, StreamingPcm16Resampler } from '../lib/browser-recording';
import { RECORDING_CHUNK_SECONDS, RECORDING_MAX_SECONDS, RECORDING_SAMPLE_RATE } from '../lib/recording-types';

function joined(parts:Int16Array[]){
  const result=new Int16Array(parts.reduce((total,part)=>total+part.length,0));
  let offset=0;for(const part of parts){result.set(part,offset);offset+=part.length;}return result;
}
function waitUntil(check:()=>boolean,timeoutMs=3_000){return new Promise<void>((resolve,reject)=>{const started=Date.now();const timer=setInterval(()=>{if(check()){clearInterval(timer);resolve();}else if(Date.now()-started>timeoutMs){clearInterval(timer);reject(new Error('Timed out'));}},5);});}

test('streaming resampler preserves fractional phase across AudioWorklet blocks',()=>{
  const source=Float32Array.from({length:48_000},(_,index)=>Math.sin(index/53)*0.5);
  const whole=new StreamingPcm16Resampler(48_000).push(source);
  const split=new StreamingPcm16Resampler(48_000);
  const pieces:Int16Array[]=[];
  for(let offset=0;offset<source.length;offset+=128)pieces.push(split.push(source.subarray(offset,offset+128)));
  assert.equal(whole.length,RECORDING_SAMPLE_RATE);
  assert.deepEqual(joined(pieces),whole);
});

test('chunk assembler emits independent 60-second chunks and preserves a final partial chunk',()=>{
  const assembler=new RecordingChunkAssembler();
  const emitted:Int16Array[]=[];
  const first=new Int16Array(RECORDING_SAMPLE_RATE*75).fill(1234);
  assembler.append(first,chunk=>emitted.push(chunk));
  assert.equal(emitted.length,1);assert.equal(emitted[0].length,RECORDING_SAMPLE_RATE*RECORDING_CHUNK_SECONDS);
  const partial=assembler.flush();assert.equal(partial?.length,RECORDING_SAMPLE_RATE*15);assert.equal(partial?.[0],1234);
  assert.equal(assembler.durationSeconds,75);
});

test('chunk assembler supports more than one hour and enforces the two-hour actual-audio cap',()=>{
  const assembler=new RecordingChunkAssembler();
  const minute=new Int16Array(RECORDING_SAMPLE_RATE*RECORDING_CHUNK_SECONDS);
  let chunks=0,final={accepted:0,limitReached:false};
  for(let index=0;index<121;index+=1)final=assembler.append(minute,()=>{chunks+=1;});
  assert.equal(chunks,RECORDING_MAX_SECONDS/RECORDING_CHUNK_SECONDS);
  assert.equal(assembler.durationSeconds,RECORDING_MAX_SECONDS);
  assert.deepEqual(final,{accepted:0,limitReached:true});
  assert.equal(assembler.flush(),null);
});

test('reload recovery counts server-saved duration toward the two-hour cap and discards unsaved page-hide audio',()=>{
  const assembler=new RecordingChunkAssembler();
  assembler.ensureMinimumDuration(7_190);
  let chunks=0;
  const result=assembler.append(new Int16Array(RECORDING_SAMPLE_RATE*20),()=>{chunks+=1;});
  assert.equal(result.accepted,RECORDING_SAMPLE_RATE*10);assert.equal(result.limitReached,true);assert.equal(chunks,0);
  assert.equal(assembler.durationSeconds,RECORDING_MAX_SECONDS);
  assert.equal(assembler.discardBuffered(),RECORDING_SAMPLE_RATE*10);
  assert.equal(assembler.durationSeconds,7_190);
});

test('lost upload acknowledgement reconciles to server count before resume and finish',async t=>{
  const keys=['navigator','window','location','isSecureContext','AudioContext','AudioWorkletNode','fetch'] as const;
  const descriptors=new Map(keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  t.after(()=>{for(const key of keys){const descriptor=descriptors.get(key);if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete (globalThis as Record<string,unknown>)[key];}});
  let serverCount=0,uploadCalls=0,finishExpected=-1,finishLease:unknown='not-called';
  const detail=(state:'recording'|'paused'|'queued',leaseToken?:string)=>({session:{id:'recording-1',caseId:'case-1',state,provider:'mock' as const,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),durationSeconds:serverCount*60,chunkCount:serverCount,transcribedChunks:0,incomplete:false,error:null},chunks:[],segments:[],provider:'mock' as const,configured:true,...(leaseToken?{leaseToken}:{}),nextIndex:serverCount});
  const track={stop(){}};const stream={getTracks:()=>[track]};const nodeConnection={connect(){},disconnect(){}};
  class FakeContext {
    sampleRate=16_000;state='running';destination={};audioWorklet={addModule:async()=>{}};
    async resume(){} async close(){this.state='closed';} createMediaStreamSource(){return nodeConnection;} createGain(){return {...nodeConnection,gain:{value:1}};} createScriptProcessor(){throw new Error('fallback not expected');}
  }
  class FakeWorklet {static instances:FakeWorklet[]=[];port:{onmessage:((event:{data:Float32Array})=>void)|null}={onmessage:null};constructor(){FakeWorklet.instances.push(this);}connect(){}disconnect(){}}
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:async()=>stream}}});
  Object.defineProperty(globalThis,'window',{configurable:true,value:{addEventListener(){},removeEventListener(){}}});
  Object.defineProperty(globalThis,'location',{configurable:true,value:{hostname:'127.0.0.1',host:'127.0.0.1'}});
  Object.defineProperty(globalThis,'isSecureContext',{configurable:true,value:true});
  Object.defineProperty(globalThis,'AudioContext',{configurable:true,value:FakeContext});
  Object.defineProperty(globalThis,'AudioWorkletNode',{configurable:true,value:FakeWorklet});
  Object.defineProperty(globalThis,'fetch',{configurable:true,value:async(_url:string|URL|Request,init?:RequestInit)=>{
    if(init?.headers&&new Headers(init.headers).get('content-type')==='audio/wav'){
      uploadCalls+=1;serverCount=1;throw new TypeError('response lost after save');
    }
    const body=JSON.parse(String(init?.body??'{}')) as {action?:string;expectedChunks?:number;leaseToken?:unknown};
    if(body.action==='start')return Response.json(detail('recording','lease-1'));
    if(body.action==='pause')return Response.json(detail('paused'));
    if(body.action==='resume')return Response.json(detail('recording','lease-2'));
    if(body.action==='finish'){finishExpected=body.expectedChunks??-1;finishLease=body.leaseToken;return Response.json(detail('queued'));}
    throw new Error(`Unexpected action ${body.action}`);
  }});
  const states:string[]=[],client=new BrowserRecordingClient({caseId:'case-1',csrf:'csrf',onState:state=>states.push(state)});
  await client.start();
  FakeWorklet.instances[0].port.onmessage?.({data:new Float32Array(RECORDING_SAMPLE_RATE*RECORDING_CHUNK_SECONDS)});
  await waitUntil(()=>client.state==='error');
  assert.equal(serverCount,1);assert.equal(uploadCalls,1);
  await client.resume();assert.equal(client.state,'recording');assert.equal(uploadCalls,1);
  await client.pause();assert.equal(client.state,'paused');
  await client.finish();assert.equal(finishExpected,1);assert.equal(finishLease,undefined,'a successful pause revokes the browser lease before finish');assert.equal(uploadCalls,1);assert.equal(client.state,'idle');
  assert.ok(states.includes('error'));await client.dispose();
});

test('a delayed page-hide pause response cannot clear a newer resumed lease',async t=>{
  const keys=['navigator','window','location','isSecureContext','AudioContext','AudioWorkletNode','fetch'] as const;
  const descriptors=new Map(keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  t.after(()=>{for(const key of keys){const descriptor=descriptors.get(key);if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete (globalThis as Record<string,unknown>)[key];}});
  let pageHide:(()=>void)|undefined,finishLease:unknown='not-called',resolvePause!:(response:Response)=>void;
  const pauseResponse=new Promise<Response>(resolve=>{resolvePause=resolve;});
  const detail=(state:'recording'|'paused'|'queued',leaseToken?:string)=>({session:{id:'recording-1',caseId:'case-1',state,provider:'mock' as const,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),durationSeconds:0,chunkCount:0,transcribedChunks:0,incomplete:state==='paused',error:null},chunks:[],segments:[],provider:'mock' as const,configured:true,...(leaseToken?{leaseToken}:{}),nextIndex:0});
  const nodeConnection={connect(){},disconnect(){}};
  class FakeContext {sampleRate=16_000;state='running';destination={};audioWorklet={addModule:async()=>{}};async resume(){}async close(){this.state='closed';}createMediaStreamSource(){return nodeConnection;}createGain(){return {...nodeConnection,gain:{value:1}};}createScriptProcessor(){throw new Error('fallback not expected');}}
  class FakeWorklet {port={onmessage:null};connect(){}disconnect(){}}
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:async()=>({getTracks:()=>[{stop(){}}]})}}});
  Object.defineProperty(globalThis,'window',{configurable:true,value:{addEventListener:(name:string,listener:()=>void)=>{if(name==='pagehide')pageHide=listener;},removeEventListener(){}}});
  Object.defineProperty(globalThis,'location',{configurable:true,value:{hostname:'127.0.0.1',host:'127.0.0.1'}});
  Object.defineProperty(globalThis,'isSecureContext',{configurable:true,value:true});
  Object.defineProperty(globalThis,'AudioContext',{configurable:true,value:FakeContext});
  Object.defineProperty(globalThis,'AudioWorkletNode',{configurable:true,value:FakeWorklet});
  Object.defineProperty(globalThis,'fetch',{configurable:true,value:async(_url:string|URL|Request,init?:RequestInit)=>{
    const body=JSON.parse(String(init?.body??'{}')) as {action?:string;leaseToken?:unknown;incomplete?:boolean};
    if(body.action==='start')return Response.json(detail('recording','lease-1'));
    if(body.action==='pause'&&body.incomplete)return pauseResponse;
    if(body.action==='resume')return Response.json(detail('recording','lease-2'));
    if(body.action==='finish'){finishLease=body.leaseToken;return Response.json(detail('queued'));}
    throw new Error(`Unexpected action ${body.action}`);
  }});
  const client=new BrowserRecordingClient({caseId:'case-1',csrf:'csrf'});await client.start();pageHide?.();await new Promise(resolve=>setImmediate(resolve));await client.resume();
  resolvePause(Response.json(detail('paused')));await new Promise(resolve=>setImmediate(resolve));
  await client.finish();assert.equal(finishLease,'lease-2','the old page-hide response must not clear the replacement lease');await client.dispose();
});
