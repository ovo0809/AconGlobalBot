'use client';

import { encodeRecordingWav } from './recording-audio';
import {
  RECORDING_CHUNK_SECONDS,
  RECORDING_MAX_SECONDS,
  RECORDING_SAMPLE_RATE,
  type RecordingControlResult,
  type RecordingDetail,
} from './recording-types';

export type BrowserRecordingState='idle'|'starting'|'recording'|'uploading'|'paused'|'finishing'|'error';

export interface BrowserRecordingOptions {
  caseId:string;
  csrf:string;
  onState?:(state:BrowserRecordingState)=>void;
  onDetail?:(detail:RecordingControlResult)=>void;
  onDuration?:(seconds:number)=>void;
  onError?:(message:string)=>void;
}

const MAX_PENDING_CHUNKS=3;

function safeReason(cause:unknown,fallback='录音暂时无法继续，请检查网络后重试。'){
  const raw=cause instanceof Error?cause.message:typeof cause==='string'?cause:'';
  if(!raw.trim())return fallback;
  if(/费用|额度|上限|预算|spending|budget/i.test(raw))return '当前案例暂不能继续调用，请由顾问核对后重试。';
  return raw.trim().slice(0,240).replace(/sk[-_][A-Za-z0-9_-]+/gi,'[已隐藏]').replace(/token=[^\s&]+/gi,'token=[已隐藏]');
}

async function responseJson(response:Response){
  const data=await response.json().catch(()=>({error:`请求失败（${response.status}）`})) as RecordingControlResult&{error?:string};
  if(!response.ok)throw new Error(data.error||`请求失败（${response.status}）`);
  return data;
}

export async function loadRecording(caseId:string):Promise<RecordingDetail>{
  const response=await fetch(`/api/recording?caseId=${encodeURIComponent(caseId)}`,{cache:'no-store',credentials:'same-origin'});
  return responseJson(response);
}

export async function controlRecording(csrf:string,body:Record<string,unknown>):Promise<RecordingControlResult>{
  const response=await fetch('/api/recording',{method:'POST',cache:'no-store',credentials:'same-origin',headers:{'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify(body)});
  return responseJson(response);
}

/** Stateful resampler: preserves fractional phase between AudioWorklet blocks. */
export class StreamingPcm16Resampler {
  private previous=0;
  private inputIndex=-1;
  private nextOutputAt=0;
  constructor(readonly inputRate:number,readonly outputRate=RECORDING_SAMPLE_RATE){
    if(!Number.isFinite(inputRate)||inputRate<=0||!Number.isFinite(outputRate)||outputRate<=0)throw new Error('Invalid audio sample rate.');
  }
  push(input:Float32Array){
    if(input.length===0)return new Int16Array();
    const step=this.inputRate/this.outputRate;
    const values:number[]=[];
    for(const current of input){
      this.inputIndex+=1;
      if(this.inputIndex===0){this.previous=current;continue;}
      const left=this.inputIndex-1;
      while(this.nextOutputAt<=this.inputIndex){
        if(this.nextOutputAt>=left){
          const fraction=this.nextOutputAt-left;
          const sample=Math.max(-1,Math.min(1,this.previous+(current-this.previous)*fraction));
          values.push(sample<0?Math.round(sample*0x8000):Math.round(sample*0x7fff));
        }
        this.nextOutputAt+=step;
      }
      this.previous=current;
    }
    return Int16Array.from(values);
  }
}

/** Fixed-size chunker with a bounded 2-hour sample budget. */
export class RecordingChunkAssembler {
  readonly chunkSamples=RECORDING_SAMPLE_RATE*RECORDING_CHUNK_SECONDS;
  readonly maxSamples=RECORDING_SAMPLE_RATE*RECORDING_MAX_SECONDS;
  private buffer=new Int16Array(this.chunkSamples);
  private offset=0;
  private accepted=0;
  ensureMinimumDuration(seconds:number){
    if(!Number.isFinite(seconds)||seconds<0)return;
    this.accepted=Math.max(this.accepted,Math.min(this.maxSamples,Math.round(seconds*RECORDING_SAMPLE_RATE)));
  }
  append(samples:Int16Array,onChunk:(chunk:Int16Array)=>void){
    let cursor=0;
    const allowed=Math.min(samples.length,this.maxSamples-this.accepted);
    while(cursor<allowed){
      const size=Math.min(allowed-cursor,this.chunkSamples-this.offset);
      this.buffer.set(samples.subarray(cursor,cursor+size),this.offset);
      this.offset+=size;this.accepted+=size;cursor+=size;
      if(this.offset===this.chunkSamples){onChunk(this.buffer);this.buffer=new Int16Array(this.chunkSamples);this.offset=0;}
    }
    return {accepted:allowed,limitReached:this.accepted>=this.maxSamples};
  }
  flush(){
    if(this.offset===0)return null;
    const chunk=this.buffer.slice(0,this.offset);this.buffer=new Int16Array(this.chunkSamples);this.offset=0;return chunk;
  }
  discardBuffered(){const discarded=this.offset;this.accepted-=discarded;this.buffer=new Int16Array(this.chunkSamples);this.offset=0;return discarded;}
  get durationSeconds(){return this.accepted/RECORDING_SAMPLE_RATE;}
  get bufferedSamples(){return this.offset;}
}

export class BrowserRecordingClient {
  private stateValue:BrowserRecordingState='idle';
  private stream:MediaStream|null=null;
  private context:AudioContext|null=null;
  private captureNode:AudioNode|null=null;
  private silentGain:GainNode|null=null;
  private assembler=new RecordingChunkAssembler();
  private resampler:StreamingPcm16Resampler|null=null;
  private sessionId:string|null=null;
  private leaseToken:string|null=null;
  private nextIndex=0;
  private nextEnqueueIndex=0;
  private pending=new Map<number,Uint8Array>();
  private uploadPump:Promise<void>|null=null;
  private uploadFailure:Error|null=null;
  private disposed=false;
  private generation=0;
  private autoFinishing=false;
  private pageHide=()=>{void this.pauseForPageHide();};
  constructor(private options:BrowserRecordingOptions){}
  get state(){return this.stateValue;}
  get durationSeconds(){return this.assembler.durationSeconds;}
  get unsavedChunks(){return this.pending.size+(this.assembler.bufferedSamples?1:0);}
  private setState(state:BrowserRecordingState){this.stateValue=state;if(!this.disposed)this.options.onState?.(state);}
  private fail(cause:unknown){const message=safeReason(cause);this.setState('error');if(!this.disposed)this.options.onError?.(message);return new Error(message);}
  private current(generation:number){return !this.disposed&&generation===this.generation;}

  async start(){
    if(!['idle','paused','error'].includes(this.stateValue))return;
    this.disposed=false;const generation=++this.generation;this.setState('starting');
    try{
      const detail=await controlRecording(this.options.csrf,{action:'start',caseId:this.options.caseId,consent:true});
      this.adopt(detail);if(!this.current(generation)){await this.pauseServer(true).catch(()=>undefined);return;}await this.startCapture(generation);if(!this.current(generation))return;this.setState('recording');window.addEventListener('pagehide',this.pageHide);
    }catch(cause){await this.releaseMedia();await this.pauseServer(true).catch(()=>undefined);if(!this.current(generation))return;throw this.fail(cause);}
  }

  async resume(){
    if(!['paused','error','idle'].includes(this.stateValue))return;
    const generation=++this.generation;this.setState('starting');
    try{
      const detail=await controlRecording(this.options.csrf,{action:'resume',caseId:this.options.caseId,sessionId:this.sessionId??undefined});
      this.adopt(detail);if(!this.current(generation)){await this.pauseServer(true).catch(()=>undefined);return;}await this.retryUploads();if(!this.current(generation))return;await this.startCapture(generation);if(!this.current(generation))return;this.setState('recording');window.addEventListener('pagehide',this.pageHide);
    }catch(cause){await this.releaseMedia();await this.pauseServer(true).catch(()=>undefined);if(!this.current(generation))return;throw this.fail(cause);}
  }

  hydrate(detail:RecordingDetail){if(detail.session)this.adopt(detail);}
  private adopt(detail:RecordingDetail|RecordingControlResult){
    if(!detail.session)throw new Error('服务器没有返回录音会话。');
    this.sessionId=detail.session.id;
    if('leaseToken' in detail&&detail.leaseToken)this.leaseToken=detail.leaseToken;
    const acknowledged='nextIndex' in detail&&detail.nextIndex!==undefined?detail.nextIndex:detail.session.chunkCount;
    for(const index of this.pending.keys())if(index<acknowledged)this.pending.delete(index);
    this.nextIndex=Math.max(this.nextIndex,acknowledged);
    const highestPending=Math.max(-1,...this.pending.keys());
    this.nextEnqueueIndex=Math.max(this.nextEnqueueIndex,acknowledged,highestPending+1);
    this.assembler.ensureMinimumDuration(detail.session.durationSeconds);
    if(!this.disposed)this.options.onDuration?.(this.assembler.durationSeconds);
    if(!this.disposed)this.options.onDetail?.(detail as RecordingControlResult);
  }

  private async startCapture(generation:number){
    const hostname=typeof location==='undefined'?'localhost':location.hostname||location.host.split(':')[0];
    if(!globalThis.isSecureContext&&hostname!=='localhost'&&hostname!=='127.0.0.1')throw new Error('当前页面不是安全连接，麦克风需要通过 HTTPS 访问。');
    if(!navigator.mediaDevices?.getUserMedia)throw new Error('当前浏览器不支持麦克风访问。');
    if(typeof AudioContext==='undefined')throw new Error('当前浏览器不支持连续录音所需的音频能力。');
    const stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
    if(!this.current(generation)){for(const track of stream.getTracks())track.stop();return;}
    this.stream=stream;
    const context=new AudioContext({sampleRate:RECORDING_SAMPLE_RATE,latencyHint:'interactive'});this.context=context;
    await context.resume();if(!this.current(generation)){await this.releaseMedia();return;}
    this.resampler=new StreamingPcm16Resampler(this.context.sampleRate);
    const source=this.context.createMediaStreamSource(this.stream);
    const receive=(samples:Float32Array)=>{
      if(this.stateValue!=='recording'||!this.resampler)return;
      const pcm=this.resampler.push(samples);
      const result=this.assembler.append(pcm,chunk=>this.queueChunk(chunk));
      this.options.onDuration?.(this.assembler.durationSeconds);
      if(result.limitReached&&!this.autoFinishing){this.autoFinishing=true;void this.finish().catch(cause=>this.options.onError?.(safeReason(cause)));}
    };
    try{
      await this.context.audioWorklet.addModule('/audio/aeconn-capture.js');
      if(!this.current(generation))return;
      const node=new AudioWorkletNode(this.context,'aeconn-capture');node.port.onmessage=event=>receive(event.data as Float32Array);this.captureNode=node;source.connect(node);
    }catch{
      const node=this.context.createScriptProcessor(4096,1,1);node.onaudioprocess=event=>receive(event.inputBuffer.getChannelData(0).slice());this.captureNode=node;source.connect(node);
    }
    this.silentGain=this.context.createGain();this.silentGain.gain.value=0;this.captureNode.connect(this.silentGain);this.silentGain.connect(this.context.destination);
  }

  private queueChunk(samples:Int16Array){
    const index=this.nextEnqueueIndex++;
    this.pending.set(index,encodeRecordingWav(samples));
    if(this.pending.size>MAX_PENDING_CHUNKS){void this.handleUploadBacklog();return;}
    this.pumpUploads();
  }

  private pumpUploads(){
    if(this.uploadPump||this.pending.size===0)return;
    this.uploadPump=(async()=>{
      while(this.pending.size){
        const [index,wav]=[...this.pending.entries()].sort((a,b)=>a[0]-b[0])[0];
        await this.upload(index,wav);this.pending.delete(index);this.nextIndex=Math.max(this.nextIndex,index+1);
      }
      this.uploadFailure=null;
    })().catch(cause=>{this.uploadFailure=cause instanceof Error?cause:new Error(String(cause));void this.handleUploadBacklog();}).finally(()=>{this.uploadPump=null;});
  }

  private async upload(index:number,wav:Uint8Array){
    if(!this.sessionId||!this.leaseToken)throw new Error('录音上传凭证已失效，请暂停后恢复。');
    const query=new URLSearchParams({caseId:this.options.caseId,sessionId:this.sessionId,index:String(index)});
    const body=new Blob([wav.slice().buffer],{type:'audio/wav'});
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30_000);
    try{
      const response=await fetch(`/api/recording?${query}`,{method:'POST',cache:'no-store',credentials:'same-origin',headers:{'content-type':'audio/wav','x-csrf-token':this.options.csrf,'x-recording-lease':this.leaseToken},body,signal:controller.signal});
      const detail=await responseJson(response);this.adopt(detail);
    }finally{clearTimeout(timer);}
  }

  private async handleUploadBacklog(){
    if(this.stateValue==='recording'){
      this.setState('uploading');await this.releaseMedia();
      await this.pauseServer(true).catch(()=>undefined);
      this.options.onError?.('录音上传中断，麦克风已自动暂停。未上传的分段仍保留在本页，请检查网络后重试。');
      this.setState('error');
    }
  }

  async retryUploads(){
    if(!this.pending.size){this.uploadFailure=null;return;}
    this.uploadFailure=null;this.pumpUploads();
    while(this.uploadPump)await this.uploadPump;
    if(this.uploadFailure)throw this.uploadFailure;
  }

  private flushPartial(){const partial=this.assembler.flush();if(partial)this.queueChunk(partial);}

  async pause(){
    if(!['recording','uploading','error'].includes(this.stateValue))return;
    this.setState('uploading');this.flushPartial();await this.releaseMedia();
    try{await this.retryUploads();await this.pauseServer(false);this.setState('paused');}
    catch(cause){throw this.fail(cause);}
  }

  private async pauseServer(incomplete:boolean){
    if(!this.sessionId)return;
    const detail=await controlRecording(this.options.csrf,{action:'pause',caseId:this.options.caseId,sessionId:this.sessionId,leaseToken:this.leaseToken??undefined,expectedChunks:this.nextIndex,incomplete});
    this.adopt(detail);
  }

  async finish(){
    if(!['idle','recording','paused','error','uploading'].includes(this.stateValue))return;
    this.setState('finishing');this.flushPartial();await this.releaseMedia();
    try{
      await this.retryUploads();
      if(!this.sessionId)throw new Error('没有可结束的录音会话。');
      const detail=await controlRecording(this.options.csrf,{action:'finish',caseId:this.options.caseId,sessionId:this.sessionId,leaseToken:this.leaseToken??undefined,expectedChunks:this.nextIndex});
      this.adopt(detail);this.setState('idle');
    }catch(cause){throw this.fail(cause);}
  }

  private pauseForPageHide(){
    if(this.stateValue!=='recording')return;
    this.assembler.discardBuffered();this.options.onDuration?.(this.assembler.durationSeconds);this.setState('paused');
    void this.releaseMedia();
    if(!this.sessionId)return;
    void fetch('/api/recording',{method:'POST',cache:'no-store',credentials:'same-origin',keepalive:true,headers:{'content-type':'application/json','x-csrf-token':this.options.csrf},body:JSON.stringify({action:'pause',caseId:this.options.caseId,sessionId:this.sessionId,leaseToken:this.leaseToken,expectedChunks:this.nextIndex,incomplete:true})}).catch(()=>undefined);
  }

  private async releaseMedia(){
    window.removeEventListener('pagehide',this.pageHide);
    this.captureNode?.disconnect();this.silentGain?.disconnect();this.captureNode=null;this.silentGain=null;
    for(const track of this.stream?.getTracks()??[])track.stop();this.stream=null;
    if(this.context&&this.context.state!=='closed')await this.context.close().catch(()=>undefined);this.context=null;this.resampler=null;
  }

  async dispose(){
    if(this.disposed)return;this.disposed=true;this.generation+=1;
    if(this.stateValue==='recording')await this.pause().catch(()=>this.releaseMedia());else await this.releaseMedia();
  }
}
