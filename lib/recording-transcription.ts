import { beginUsage, completeUsage, recordUsage, UsageBudgetError } from './ai-usage';
import { recordUsageCompletion } from './usage-reconciliation';
import { validateRecordingWav } from './recording-audio';

const OPENAI_TRANSCRIPTIONS_ENDPOINT='https://api.openai.com/v1/audio/transcriptions';
const OPENAI_TRANSCRIPTION_MODEL='whisper-1';
const OPENAI_TIMEOUT_MS=90_000;
const MAX_RESPONSE_BYTES=1_000_000;
const MAX_SEGMENTS=500;
const MAX_SEGMENT_TEXT=4_000;
const MAX_TRANSCRIPT_TEXT=200_000;
const WHISPER_MICROS_PER_SECOND=100;
const WHISPER_PROMPT_MAX_BYTES=220;

export type RecordingTranscriptionProvider='mock'|'openai';
export interface RecordingTranscriptionSegment {startSeconds:number;endSeconds:number;text:string}
export interface RecordingTranscriptionResult {durationSeconds:number;segments:RecordingTranscriptionSegment[];timingWarning?:string}

export class RecordingTranscriptionError extends Error {
  readonly code:string;
  readonly usageOutcome:'released'|'unknown';
  constructor(message:string,code:string,usageOutcome:'released'|'unknown'='released'){
    super(message);this.name='RecordingTranscriptionError';this.code=code;this.usageOutcome=usageOutcome;
  }
}

function selectedProvider():RecordingTranscriptionProvider {
  const selected=(process.env.RECORDING_PROVIDER??process.env.LLM_PROVIDER??'mock').trim().toLowerCase();
  if(selected==='mock'||selected==='openai')return selected;
  throw new RecordingTranscriptionError('录音转写服务配置不受支持。','RECORDING_PROVIDER_UNSUPPORTED');
}

export function recordingProviderConfig():{provider:RecordingTranscriptionProvider;configured:boolean}{
  const provider=selectedProvider();
  if(provider==='mock')return {provider,configured:true};
  const model=(process.env.RECORDING_TRANSCRIPTION_MODEL?.trim()||OPENAI_TRANSCRIPTION_MODEL);
  return {provider,configured:Boolean(process.env.OPENAI_API_KEY?.trim())&&model===OPENAI_TRANSCRIPTION_MODEL};
}

function requireOpenAIConfig(){
  const apiKey=process.env.OPENAI_API_KEY?.trim();
  const model=process.env.RECORDING_TRANSCRIPTION_MODEL?.trim()||OPENAI_TRANSCRIPTION_MODEL;
  if(model!==OPENAI_TRANSCRIPTION_MODEL)throw new RecordingTranscriptionError('录音转写当前只支持已配置费率的 whisper-1。','RECORDING_MODEL_UNSUPPORTED');
  if(!apiKey)throw new RecordingTranscriptionError('OpenAI 录音转写尚未配置。','RECORDING_PROVIDER_NOT_CONFIGURED');
  return {apiKey,model:OPENAI_TRANSCRIPTION_MODEL as 'whisper-1'};
}

function reserveMicros(durationSeconds:number){
  // Reserve one rounded-up second of headroom. Settlement always uses the
  // locally validated WAV duration, so unused protection is released.
  return Math.max(1,Math.ceil(durationSeconds+1)*WHISPER_MICROS_PER_SECOND);
}

function finite(value:unknown,name:string){
  if(typeof value!=='number'||!Number.isFinite(value)||value<0)throw new RecordingTranscriptionError(`转写服务返回了无效的${name}。`,'RECORDING_RESPONSE_INVALID','unknown');
  return value;
}

function comparableTranscript(value:string){
  const chars=Array.from(value.normalize('NFKC'));
  const isAsciiToken=(char:string|undefined)=>Boolean(char&&/[A-Za-z0-9]/.test(char));
  const nextNonWhitespace=new Array<string|undefined>(chars.length);let right:string|undefined;
  for(let index=chars.length-1;index>=0;index--){nextNonWhitespace[index]=right;if(!/\s/u.test(chars[index]))right=chars[index];}
  const normalized:string[]=[];let left:string|undefined;
  for(const [index,char] of chars.entries()){
    const whitespace=/\s/u.test(char),next=nextNonWhitespace[index];
    if(whitespace){if(isAsciiToken(left)&&isAsciiToken(next)&&normalized.at(-1)!==' ')normalized.push(' ');continue;}
    normalized.push(/[,，。.!！?？;；:：、]/u.test(char)&&!(isAsciiToken(left)&&isAsciiToken(next))?'':char);left=char;
  }
  return normalized.join('');
}

function previousChunkPrompt(value:string|undefined):string|undefined {
  const text=value?.trim();if(!text)return;
  const chars=Array.from(text);let bytes=0,start=chars.length;
  while(start>0){const size=new TextEncoder().encode(chars[start-1]).byteLength;if(bytes+size>WHISPER_PROMPT_MAX_BYTES)break;bytes+=size;start--;}
  return chars.slice(start).join('');
}

function parseResponse(value:unknown,localDuration:number,allowChunkTimingFallback=false):RecordingTranscriptionResult{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new RecordingTranscriptionError('转写服务返回了无效数据。','RECORDING_RESPONSE_INVALID','unknown');
  const result=value as Record<string,unknown>;
  const upstreamDuration=finite(result.duration,'录音时长');
  const tolerance=Math.max(1,localDuration*0.02);
  if(Math.abs(upstreamDuration-localDuration)>tolerance)throw new RecordingTranscriptionError(`转写时长不一致（本地 ${localDuration.toFixed(3)}s，返回 ${upstreamDuration.toFixed(3)}s）。`,'RECORDING_DURATION_MISMATCH','unknown');
  const rawSegments=result.segments===undefined?[]:result.segments;
  if(!Array.isArray(rawSegments)||rawSegments.length>MAX_SEGMENTS)throw new RecordingTranscriptionError('转写服务返回的分段无效。','RECORDING_RESPONSE_INVALID','unknown');
  let previousEnd=0,totalText=0;
  let needsChunkTiming=false;
  const segments:RecordingTranscriptionSegment[]=[];
  for(const [index,raw] of rawSegments.entries()){
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new RecordingTranscriptionError('转写服务返回的分段无效。','RECORDING_RESPONSE_INVALID','unknown');
    const row=raw as Record<string,unknown>,start=finite(row.start,`第 ${index+1} 段开始时间`),end=finite(row.end,`第 ${index+1} 段结束时间`);
    if(typeof row.text!=='string')throw new RecordingTranscriptionError('转写服务返回的分段文字无效。','RECORDING_RESPONSE_INVALID','unknown');
    const text=row.text.trim();
    const invalid=text.length>MAX_SEGMENT_TEXT?'文字过长':end<start?'时间倒置':null;
    if(invalid)throw new RecordingTranscriptionError(`转写第 ${index+1} 段${invalid}（${start.toFixed(3)}–${end.toFixed(3)}s，前段结束 ${previousEnd.toFixed(3)}s，本地 ${localDuration.toFixed(3)}s）。`,'RECORDING_RESPONSE_INVALID','unknown');
    const timingInvalid=start+0.25<previousEnd?'时间重叠':end>localDuration+tolerance?'超出录音边界':null;
    if(timingInvalid&&!allowChunkTimingFallback)throw new RecordingTranscriptionError(`转写第 ${index+1} 段${timingInvalid}（${start.toFixed(3)}–${end.toFixed(3)}s，前段结束 ${previousEnd.toFixed(3)}s，本地 ${localDuration.toFixed(3)}s）。`,'RECORDING_RESPONSE_INVALID','unknown');
    if(timingInvalid||end>localDuration)needsChunkTiming=true;
    previousEnd=Math.max(previousEnd,end);totalText+=text.length;
    if(totalText>MAX_TRANSCRIPT_TEXT)throw new RecordingTranscriptionError('转写服务返回的文字过长。','RECORDING_RESPONSE_INVALID','unknown');
    // Whisper can include structurally valid empty segments for silence.
    if(text)segments.push({startSeconds:Math.min(start,localDuration),endSeconds:Math.min(end,localDuration),text});
  }
  const transcript=typeof result.text==='string'?result.text.trim():'';
  if(transcript.length>MAX_TRANSCRIPT_TEXT)throw new RecordingTranscriptionError('转写服务返回的文字过长。','RECORDING_RESPONSE_INVALID','unknown');
  const comparableFull=transcript&&segments.length?comparableTranscript(transcript):'';
  const comparableSegments=transcript&&segments.length?comparableTranscript(segments.map(segment=>segment.text).join(' ')):'';
  const contentDiffers=Boolean(transcript&&segments.length&&comparableFull!==comparableSegments);
  const completeTranscriptExtendsSegments=contentDiffers&&comparableSegments.length>0&&comparableFull.length>comparableSegments.length&&comparableFull.startsWith(comparableSegments);
  if(needsChunkTiming&&allowChunkTimingFallback){
    if(!transcript||transcript.length>MAX_SEGMENT_TEXT)throw new RecordingTranscriptionError('逐句时间无法核对，且整段转写为空或过长。','RECORDING_RESPONSE_INVALID','unknown');
    if(contentDiffers&&!completeTranscriptExtendsSegments)throw new RecordingTranscriptionError('逐句时间无法核对，且完整正文与逐句分段不一致。','RECORDING_RESPONSE_INVALID','unknown');
    // The validated upload is the source; do not invent or clamp word timings.
    return {durationSeconds:localDuration,segments:[{startSeconds:0,endSeconds:localDuration,text:transcript}],timingWarning:completeTranscriptExtendsSegments?'Whisper 逐句时间越界或重叠，且完整正文延伸至逐句分段之后；以下文字使用完整正文并仅定位到整段音轨，须对照原视频复核。':'Whisper 逐句时间越界或重叠；以下文字仅定位到整段音轨，须对照原视频复核。'};
  }
  if(contentDiffers){
    if(allowChunkTimingFallback&&completeTranscriptExtendsSegments){
      if(transcript.length>MAX_SEGMENT_TEXT)throw new RecordingTranscriptionError('完整正文与逐句分段不一致，且整段转写过长。','RECORDING_RESPONSE_INVALID','unknown');
      return {durationSeconds:localDuration,segments:[{startSeconds:0,endSeconds:localDuration,text:transcript}],timingWarning:'Whisper 完整正文与逐句分段不一致；以下文字使用完整正文并仅定位到整段音轨，须对照原视频复核。'};
    }
    throw new RecordingTranscriptionError('转写服务返回的完整正文与逐句分段不一致。','RECORDING_RESPONSE_INVALID','unknown');
  }
  if(!segments.length&&transcript){
    if(transcript.length>MAX_SEGMENT_TEXT)throw new RecordingTranscriptionError('缺少分段时间的转写文字过长。','RECORDING_RESPONSE_INVALID','unknown');
    segments.push({startSeconds:0,endSeconds:localDuration,text:transcript});
    if(allowChunkTimingFallback)return {durationSeconds:localDuration,segments,timingWarning:'Whisper 未返回可核对的逐句时间；以下文字仅定位到整段音轨，须对照原视频复核。'};
  }
  return {durationSeconds:localDuration,segments};
}

function safeRequestId(value:string|null){return value&&/^[A-Za-z0-9_.:-]{1,256}$/.test(value)?value:undefined;}

function settleAfterFailure(callId:string,durationSeconds:number,eventKey:string,requestId?:string){
  try{recordUsage(callId,eventKey,'transcription',{type:'duration',seconds:durationSeconds},requestId);}catch{/* Keep the full reservation held if normalized usage cannot be recorded. */}
  try{completeUsage(callId,'unknown');}catch{/* Preserve the original provider failure. */}
}

export async function transcribeRecordingChunk(input:{
  audio:Uint8Array;
  context:{caseId:string;sessionId?:string};
  provider:RecordingTranscriptionProvider;
  allowChunkTimingFallback?:boolean;
  previousText?:string;
}):Promise<RecordingTranscriptionResult>{
  const wav=validateRecordingWav(input.audio);
  if(selectedProvider()!==input.provider)throw new RecordingTranscriptionError('录音转写请求与显式服务配置不一致。','RECORDING_PROVIDER_MISMATCH');
  if(input.provider==='mock')return {durationSeconds:wav.durationSeconds,segments:[{startSeconds:0,endSeconds:wav.durationSeconds,text:'【模拟转写】此段仅用于检查录音、核对与报告流程，不代表真实客户发言。'}]};
  if(input.provider!=='openai')throw new RecordingTranscriptionError('录音转写服务配置不受支持。','RECORDING_PROVIDER_UNSUPPORTED');
  const config=requireOpenAIConfig();
  const reservation=beginUsage({context:input.context,operation:'transcription',model:config.model,transcriptionModel:config.model,reserveMicros:reserveMicros(wav.durationSeconds)});
  let requestStarted=false,response:Response|undefined,eventKey=`recording:${input.context.sessionId??'case'}:${reservation.id}`;
  try{
    const form=new FormData();
    const bytes=input.audio.slice();
    form.append('file',new Blob([bytes.buffer],{type:'audio/wav'}),'recording.wav');
    form.append('model',config.model);
    form.append('response_format','verbose_json');
    form.append('timestamp_granularities[]','segment');
    const prompt=input.allowChunkTimingFallback?previousChunkPrompt(input.previousText):undefined;
    if(prompt)form.append('prompt',prompt);
    requestStarted=true;
    response=await fetch(OPENAI_TRANSCRIPTIONS_ENDPOINT,{method:'POST',headers:{Authorization:`Bearer ${config.apiKey}`},body:form,signal:AbortSignal.timeout(OPENAI_TIMEOUT_MS)});
    const requestId=safeRequestId(response.headers.get('x-request-id'));
    if(requestId)eventKey=`recording:${requestId}`;
    if(!response.ok)throw new RecordingTranscriptionError(`OpenAI 录音转写未完成（HTTP ${response.status}）。`,'RECORDING_UPSTREAM_ERROR','unknown');
    const raw=await response.text();
    if(new TextEncoder().encode(raw).byteLength>MAX_RESPONSE_BYTES)throw new RecordingTranscriptionError('转写服务返回的数据过大。','RECORDING_RESPONSE_INVALID','unknown');
    let parsed:unknown;
    try{parsed=JSON.parse(raw);}catch{throw new RecordingTranscriptionError('转写服务返回了无效数据。','RECORDING_RESPONSE_INVALID','unknown');}
    const result=parseResponse(parsed,wav.durationSeconds,input.allowChunkTimingFallback);
    recordUsage(reservation.id,eventKey,'transcription',{type:'duration',seconds:wav.durationSeconds},requestId);
    recordUsageCompletion(reservation.id,'settled');
    completeUsage(reservation.id,'settled');
    return result;
  }catch(error){
    if(requestStarted)settleAfterFailure(reservation.id,wav.durationSeconds,eventKey,safeRequestId(response?.headers.get('x-request-id')??null));
    else {recordUsageCompletion(reservation.id,'released');completeUsage(reservation.id,'released');}
    if(error instanceof UsageBudgetError||error instanceof RecordingTranscriptionError)throw error;
    throw new RecordingTranscriptionError('OpenAI 录音转写未完成。','RECORDING_UPSTREAM_ERROR',requestStarted?'unknown':'released');
  }
}
