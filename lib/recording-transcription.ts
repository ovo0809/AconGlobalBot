import { beginUsage, completeUsage, recordUsage, UsageBudgetError } from './ai-usage';
import { validateRecordingWav } from './recording-audio';

const OPENAI_TRANSCRIPTIONS_ENDPOINT='https://api.openai.com/v1/audio/transcriptions';
const OPENAI_TRANSCRIPTION_MODEL='whisper-1';
const OPENAI_TIMEOUT_MS=90_000;
const MAX_RESPONSE_BYTES=1_000_000;
const MAX_SEGMENTS=500;
const MAX_SEGMENT_TEXT=4_000;
const MAX_TRANSCRIPT_TEXT=200_000;
const WHISPER_MICROS_PER_SECOND=100;

export type RecordingTranscriptionProvider='mock'|'openai';
export interface RecordingTranscriptionSegment {startSeconds:number;endSeconds:number;text:string}
export interface RecordingTranscriptionResult {durationSeconds:number;segments:RecordingTranscriptionSegment[]}

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

function parseResponse(value:unknown,localDuration:number):RecordingTranscriptionResult{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new RecordingTranscriptionError('转写服务返回了无效数据。','RECORDING_RESPONSE_INVALID','unknown');
  const result=value as Record<string,unknown>;
  const upstreamDuration=finite(result.duration,'录音时长');
  const tolerance=Math.max(1,localDuration*0.02);
  if(Math.abs(upstreamDuration-localDuration)>tolerance)throw new RecordingTranscriptionError('转写服务返回的录音时长与上传录音不一致。','RECORDING_DURATION_MISMATCH','unknown');
  if(!Array.isArray(result.segments)||result.segments.length>MAX_SEGMENTS)throw new RecordingTranscriptionError('转写服务返回的分段无效。','RECORDING_RESPONSE_INVALID','unknown');
  let previousEnd=0,totalText=0;
  const segments=result.segments.map((raw,index)=>{
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new RecordingTranscriptionError('转写服务返回的分段无效。','RECORDING_RESPONSE_INVALID','unknown');
    const row=raw as Record<string,unknown>,start=finite(row.start,`第 ${index+1} 段开始时间`),end=finite(row.end,`第 ${index+1} 段结束时间`);
    const text=typeof row.text==='string'?row.text.trim():'';
    if(!text||text.length>MAX_SEGMENT_TEXT||end<start||start+0.25<previousEnd||end>localDuration+tolerance)throw new RecordingTranscriptionError('转写服务返回的分段内容无效。','RECORDING_RESPONSE_INVALID','unknown');
    previousEnd=Math.max(previousEnd,end);totalText+=text.length;
    if(totalText>MAX_TRANSCRIPT_TEXT)throw new RecordingTranscriptionError('转写服务返回的文字过长。','RECORDING_RESPONSE_INVALID','unknown');
    return {startSeconds:Math.min(start,localDuration),endSeconds:Math.min(end,localDuration),text};
  });
  const transcript=typeof result.text==='string'?result.text.trim():'';
  if(transcript.length>MAX_TRANSCRIPT_TEXT)throw new RecordingTranscriptionError('转写服务返回的文字过长。','RECORDING_RESPONSE_INVALID','unknown');
  if(!segments.length&&transcript){
    if(transcript.length>MAX_SEGMENT_TEXT)throw new RecordingTranscriptionError('缺少分段时间的转写文字过长。','RECORDING_RESPONSE_INVALID','unknown');
    segments.push({startSeconds:0,endSeconds:localDuration,text:transcript});
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
    requestStarted=true;
    response=await fetch(OPENAI_TRANSCRIPTIONS_ENDPOINT,{method:'POST',headers:{Authorization:`Bearer ${config.apiKey}`},body:form,signal:AbortSignal.timeout(OPENAI_TIMEOUT_MS)});
    const requestId=safeRequestId(response.headers.get('x-request-id'));
    if(requestId)eventKey=`recording:${requestId}`;
    if(!response.ok)throw new RecordingTranscriptionError('OpenAI 录音转写未完成。','RECORDING_UPSTREAM_ERROR','unknown');
    const raw=await response.text();
    if(new TextEncoder().encode(raw).byteLength>MAX_RESPONSE_BYTES)throw new RecordingTranscriptionError('转写服务返回的数据过大。','RECORDING_RESPONSE_INVALID','unknown');
    let parsed:unknown;
    try{parsed=JSON.parse(raw);}catch{throw new RecordingTranscriptionError('转写服务返回了无效数据。','RECORDING_RESPONSE_INVALID','unknown');}
    const result=parseResponse(parsed,wav.durationSeconds);
    recordUsage(reservation.id,eventKey,'transcription',{type:'duration',seconds:wav.durationSeconds},requestId);
    completeUsage(reservation.id,'settled');
    return result;
  }catch(error){
    if(requestStarted)settleAfterFailure(reservation.id,wav.durationSeconds,eventKey,safeRequestId(response?.headers.get('x-request-id')??null));
    else completeUsage(reservation.id,'released');
    if(error instanceof UsageBudgetError||error instanceof RecordingTranscriptionError)throw error;
    throw new RecordingTranscriptionError('OpenAI 录音转写未完成。','RECORDING_UPSTREAM_ERROR',requestStarted?'unknown':'released');
  }
}
