import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { attachVoiceServer, type VoiceHooks } from '../lib/voice-server';
import { publicRequestConfig, readSharedLiveConfig, validateSharedLiveConfig, writeSharedLiveConfig, type SharedLiveConfig, type VoiceAccessScope } from '../lib/shared-live-access';
import { startSharedLiveServer } from '../lib/shared-live-server';

async function freePort(){const server=createServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert(address&&typeof address!=='string');await new Promise<void>(resolve=>server.close(()=>resolve()));return address.port;}
function http(port:number,method='GET',headers:Record<string,string>={}){
  return new Promise<{status:number;body:string;headers:Record<string,string|string[]|undefined>}>((resolve,reject)=>{
    const request=httpRequest({host:'127.0.0.1',port,path:'/',method,headers},response=>{const chunks:Buffer[]=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve({status:response.statusCode||0,body:Buffer.concat(chunks).toString(),headers:response.headers}));});
    request.on('error',reject);request.end();
  });
}
function opened(socket:WebSocket){return new Promise<void>((resolve,reject)=>{socket.once('open',()=>resolve());socket.once('error',reject);});}
function message(socket:WebSocket,predicate:(value:Record<string,unknown>)=>boolean){return new Promise<Record<string,unknown>>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('message timeout')),2_000);socket.on('message',raw=>{const parsed=JSON.parse(raw.toString()) as Record<string,unknown>;if(predicate(parsed)){clearTimeout(timer);resolve(parsed);}});});}
function closed(socket:WebSocket){return new Promise<void>(resolve=>{if(socket.readyState===WebSocket.CLOSED)return resolve();socket.once('close',()=>resolve());});}

test('shared live config is strict, expiring and contains no credential fields',async()=>{
  const oldPath=process.env.SHARED_LIVE_CONFIG_PATH,root=mkdtempSync(join(tmpdir(),'aeconn-shared-live-'));
  process.env.SHARED_LIVE_CONFIG_PATH=join(root,'shared-live.json');
  const config:SharedLiveConfig={enabled:true,runId:'shared_run_123456789',origin:'https://voice-test.example',port:3003,testerUserIds:['public-advisor-1','public-advisor-2'],expiresAt:new Date(Date.now()+60_000).toISOString()};
  try{
    assert.deepEqual(validateSharedLiveConfig(config),config);
    assert.throws(()=>validateSharedLiveConfig({...config,origin:'http://voice-test.example'}));
    assert.throws(()=>validateSharedLiveConfig({...config,testerUserIds:[]}));
    assert.throws(()=>validateSharedLiveConfig({...config,expiresAt:new Date(Date.now()-1).toISOString()}));
    writeSharedLiveConfig(config);assert.deepEqual(readSharedLiveConfig(),config);
    assert.doesNotMatch(JSON.stringify(readSharedLiveConfig()),/api.?key|secret|password/i);
  }finally{if(oldPath===undefined)delete process.env.SHARED_LIVE_CONFIG_PATH;else process.env.SHARED_LIVE_CONFIG_PATH=oldPath;}
});

test('public listener stamps trusted scope, validates host and origin, and disables cleanly',async()=>{
  const oldPath=process.env.SHARED_LIVE_CONFIG_PATH,root=mkdtempSync(join(tmpdir(),'aeconn-shared-http-'));
  process.env.SHARED_LIVE_CONFIG_PATH=join(root,'shared-live.json');
  const port=await freePort(),origin='https://public-voice.example';let desired:SharedLiveConfig|null={enabled:true,runId:'gateway_run_123456789',origin,port,testerUserIds:['public-advisor-1'],expiresAt:new Date(Date.now()+60_000).toISOString()};
  const scopes:VoiceAccessScope[]=[];
  const hooks:VoiceHooks={consumeToken:(_token,scope)=>{if(scope)scopes.push(scope);return null;},isActive:()=>false,getContext:()=>'{}',persist:()=>undefined,status:()=>undefined};
  writeSharedLiveConfig(desired);
  const gateway=startSharedLiveServer({hooks,readConfig:()=>desired,pollIntervalMs:60_000,handle:(request,response)=>{const config=publicRequestConfig({headers:request.headers});response.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({runId:config?.runId??null}));}});
  try{
    await gateway.refresh();
    const good=await http(port,'GET',{Host:'public-voice.example','X-Aeconn-Shared-Live':'forged'});assert.equal(good.status,200);assert.equal(JSON.parse(good.body).runId,desired.runId);assert.match(String(good.headers['x-robots-tag']),/noindex/);
    assert.equal((await http(port,'GET',{Host:'wrong.example'})).status,403);
    assert.equal((await http(port,'GET',{Host:'public-voice.example',Origin:'https://wrong.example'})).status,403);
    assert.equal((await http(port,'POST',{Host:'public-voice.example'})).status,403);
    assert.equal((await http(port,'POST',{Host:'public-voice.example',Origin:origin})).status,200);

    const socket=new WebSocket(`ws://127.0.0.1:${port}/voice?token=scope-test`,{headers:{Host:'public-voice.example',Origin:origin}});socket.on('error',()=>undefined);
    await opened(socket);await closed(socket);assert.deepEqual(scopes,[{audience:'public',runId:desired.runId}]);
    const wrongOrigin=new WebSocket(`ws://127.0.0.1:${port}/voice?token=bad-origin`,{headers:{Host:'public-voice.example',Origin:'https://wrong.example'}});wrongOrigin.on('error',()=>undefined);
    await closed(wrongOrigin);assert.equal(scopes.length,1);
    const wrongHost=new WebSocket(`ws://127.0.0.1:${port}/voice?token=bad-host`,{headers:{Host:'wrong.example',Origin:origin}});wrongHost.on('error',()=>undefined);
    await closed(wrongHost);assert.equal(scopes.length,1);

    desired=null;await gateway.refresh();assert.equal(gateway.current(),null);
    await assert.rejects(()=>http(port,'GET',{Host:'public-voice.example'}));
  }finally{await gateway.close();if(oldPath===undefined)delete process.env.SHARED_LIVE_CONFIG_PATH;else process.env.SHARED_LIVE_CONFIG_PATH=oldPath;}
});

test('closing one voice relay leaves another listener voice session connected',async()=>{
  const upstreamServer=createServer(),upstreamWss=new WebSocketServer({server:upstreamServer});
  await new Promise<void>(resolve=>upstreamServer.listen(0,'127.0.0.1',resolve));const address=upstreamServer.address();assert(address&&typeof address!=='string');
  upstreamWss.on('connection',socket=>socket.on('message',raw=>{const value=JSON.parse(raw.toString()) as {setup?:unknown};if(value.setup)socket.send(JSON.stringify({setupComplete:{}}));}));
  const makeHooks=(sessionId:string):VoiceHooks=>({consumeToken:()=>({sessionId,caseId:`case-${sessionId}`}),isActive:()=>true,getContext:()=>'{}',persist:()=>undefined,status:()=>undefined});
  const serverA=createServer(),serverB=createServer();
  const relayA=attachVoiceServer(serverA,makeHooks('listener-a'),{upstreamUrl:`ws://127.0.0.1:${address.port}`,configOverride:{provider:'gemini',apiKey:'test-key',model:'test-model'}});
  const relayB=attachVoiceServer(serverB,makeHooks('listener-b'),{upstreamUrl:`ws://127.0.0.1:${address.port}`,configOverride:{provider:'gemini',apiKey:'test-key',model:'test-model'}});
  await Promise.all([new Promise<void>(resolve=>serverA.listen(0,'127.0.0.1',resolve)),new Promise<void>(resolve=>serverB.listen(0,'127.0.0.1',resolve))]);
  const a=serverA.address(),b=serverB.address();assert(a&&typeof a!=='string'&&b&&typeof b!=='string');
  const socketA=new WebSocket(`ws://127.0.0.1:${a.port}/voice?token=a`,{headers:{Origin:`http://127.0.0.1:${a.port}`}}),socketB=new WebSocket(`ws://127.0.0.1:${b.port}/voice?token=b`,{headers:{Origin:`http://127.0.0.1:${b.port}`}});
  try{
    await Promise.all([opened(socketA),opened(socketB),message(socketA,value=>value.type==='ready'),message(socketB,value=>value.type==='ready')]);
    await relayA.close();await closed(socketA);assert.equal(socketB.readyState,WebSocket.OPEN);
  }finally{
    socketB.close();await relayB.close();await Promise.all([new Promise<void>(resolve=>serverA.close(()=>resolve())),new Promise<void>(resolve=>serverB.close(()=>resolve()))]);
    upstreamWss.close();await new Promise<void>(resolve=>upstreamServer.close(()=>resolve()));
  }
});
