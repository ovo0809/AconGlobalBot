import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserVoiceClient } from '../lib/browser-voice';

function waitUntil(check:()=>boolean,timeoutMs=2_500){return new Promise<void>((resolve,reject)=>{const started=Date.now();const timer=setInterval(()=>{if(check()){clearInterval(timer);resolve();}else if(Date.now()-started>timeoutMs){clearInterval(timer);reject(new Error('Timed out'));}},5);});}

function installConnectedBrowserFakes(t:{after(fn:()=>void):void}){
  let stopped=0,closedContexts=0;
  const descriptors=Object.fromEntries(['navigator','window','location','AudioContext','WebSocket','fetch'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  t.after(()=>{for(const [key,descriptor] of Object.entries(descriptors)){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete (globalThis as Record<string,unknown>)[key];}});
  const track={enabled:true,stop(){stopped+=1;}};
  const stream={active:true,getTracks:()=>[track],getAudioTracks:()=>[track]};
  const connectable={connect(target:unknown){return target;},disconnect(){}};
  class FakeAudioContext {
    sampleRate=48_000;currentTime=0;destination={};
    async resume(){} createMediaStreamSource(){return connectable;} createGain(){return {...connectable,gain:{value:1}};} createScriptProcessor(){return {...connectable,onaudioprocess:null};}
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
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:async()=>stream}}});
  Object.defineProperty(globalThis,'window',{configurable:true,value:{addEventListener(){},removeEventListener(){}}});
  Object.defineProperty(globalThis,'location',{configurable:true,value:{protocol:'http:',host:'127.0.0.1'}});
  Object.defineProperty(globalThis,'AudioContext',{configurable:true,value:FakeAudioContext});
  Object.defineProperty(globalThis,'WebSocket',{configurable:true,value:FakeWebSocket});
  Object.defineProperty(globalThis,'fetch',{configurable:true,value:async()=>new Response(JSON.stringify({token:`token-${++tokens}`}),{status:200,headers:{'content-type':'application/json'}})});
  return {instances,get stopped(){return stopped;},get closedContexts(){return closedContexts;},get tokens(){return tokens;}};
}

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
