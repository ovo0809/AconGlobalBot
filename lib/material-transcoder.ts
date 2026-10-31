import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

export const MATERIAL_TRANSCODE_SEGMENT_SECONDS=180;
export const MATERIAL_TRANSCODE_MAX_SEGMENT_BYTES=32*1024*1024;
const TRANSCODE_TIMEOUT_MS=4*60*60*1000;
const TRANSCODER_ENV_ALLOWLIST=new Set(['SYSTEMROOT','WINDIR','PATH','PATHEXT','TEMP','TMP','COMSPEC','USERPROFILE','LOCALAPPDATA','APPDATA','PROGRAMFILES','PROGRAMFILES(X86)','PROGRAMDATA']);

export interface MaterialTranscodeSegment {filename:string;startSeconds:number;endSeconds:number;bytes:number}
export interface MaterialTranscodeResult {durationSeconds:number;segments:MaterialTranscodeSegment[]}
export type MaterialTranscodeProgress={type:'probed';durationSeconds:number;segmentCount:number}|{type:'segment';index:number;segmentCount:number;startSeconds:number;endSeconds:number};
type TranscoderEvent={type:'probed';durationSeconds:number;width:number;height:number;outputWidth:number;outputHeight:number;hasAudio:boolean;segmentCount:number}|{type:'segment';index:number;filename:string;startSeconds:number;endSeconds:number;actualDurationSeconds:number;bytes:number}|{type:'complete';durationSeconds:number;segmentCount:number}|{type:'error';code:string};

export function materialTranscoderAvailable(platform=process.platform){return platform==='win32';}
export function materialTranscoderEnvironment(source:Record<string,string|undefined>=process.env){return Object.fromEntries(Object.entries(source).filter(([key,value])=>value!==undefined&&TRANSCODER_ENV_ALLOWLIST.has(key.toUpperCase()))) as Record<string,string>;}
function finite(value:unknown,label:string){if(typeof value!=='number'||!Number.isFinite(value))throw new Error(`转码器返回的${label}无效。`);return value;}
function integer(value:unknown,label:string){const result=finite(value,label);if(!Number.isInteger(result))throw new Error(`转码器返回的${label}无效。`);return result;}

export function planMaterialSegments(durationSeconds:number,segmentSeconds=MATERIAL_TRANSCODE_SEGMENT_SECONDS){
  finite(durationSeconds,'视频时长');finite(segmentSeconds,'分段时长');
  if(durationSeconds<=0||segmentSeconds<1||segmentSeconds>180)throw new Error('视频时长或分段时长无效。');
  return Array.from({length:Math.ceil(durationSeconds/segmentSeconds)},(_,index)=>({index,startSeconds:index*segmentSeconds,endSeconds:Math.min(durationSeconds,(index+1)*segmentSeconds),filename:`part-${String(index).padStart(3,'0')}.mp4`}));
}

export function parseMaterialTranscoderEvent(line:string):TranscoderEvent {
  let raw:unknown;try{raw=JSON.parse(line);}catch{throw new Error('转码器返回了无法识别的状态。');}
  if(!raw||typeof raw!=='object'||!('type'in raw)||typeof raw.type!=='string')throw new Error('转码器返回了无法识别的状态。');
  const value=raw as Record<string,unknown>;
  if(value.type==='probed')return {type:'probed',durationSeconds:finite(value.durationSeconds,'视频时长'),width:integer(value.width,'视频宽度'),height:integer(value.height,'视频高度'),outputWidth:integer(value.outputWidth,'输出宽度'),outputHeight:integer(value.outputHeight,'输出高度'),hasAudio:value.hasAudio===true,segmentCount:integer(value.segmentCount,'分段数量')};
  if(value.type==='segment')return {type:'segment',index:integer(value.index,'分段编号'),filename:String(value.filename??''),startSeconds:finite(value.startSeconds,'开始时间'),endSeconds:finite(value.endSeconds,'结束时间'),actualDurationSeconds:finite(value.actualDurationSeconds,'实际时长'),bytes:integer(value.bytes,'文件大小')};
  if(value.type==='complete')return {type:'complete',durationSeconds:finite(value.durationSeconds,'视频时长'),segmentCount:integer(value.segmentCount,'分段数量')};
  if(value.type==='error'&&typeof value.code==='string'&&/^[A-Z_]+(?::[A-Za-z]+)?$/.test(value.code))return {type:'error',code:value.code};
  throw new Error('转码器返回了无法识别的状态。');
}

function errorFor(code:string){
  if(code==='DURATION_LIMIT')return new Error('视频超过当前允许的最长时长。');
  if(code==='AUDIO_REQUIRED')return new Error('视频没有可识别的音轨。');
  if(code==='NORMALIZED_DURATION_MISMATCH')return new Error('视频标准化后的时长不一致，无法安全分段。');
  if(code==='INVALID_DIMENSIONS'||code==='INVALID_DURATION')return new Error('无法读取有效的视频画面或时长。');
  if(code.startsWith('UNSUPPORTED_MEDIA:'))return new Error('Windows 无法转码这个视频编码，请先转换为常见 MP4 格式。');
  return new Error('Windows 视频转码未完成。');
}

export async function transcodeMaterialVideo(input:{sourcePath:string;outputDirectory:string;signal?:AbortSignal;onProgress?:(progress:MaterialTranscodeProgress)=>void;maxDurationSeconds:number}):Promise<MaterialTranscodeResult>{
  if(!materialTranscoderAvailable())throw new Error('大视频自动处理目前仅支持 Windows 本机 Demo。');
  // The caller must choose a controlled extension from validated container magic;
  // Windows rejects an otherwise valid MP4 stored as an extensionless/.bin file.
  if(!isAbsolute(input.sourcePath)||!isAbsolute(input.outputDirectory)||resolve(input.sourcePath)===resolve(input.outputDirectory)||!input.sourcePath.toLowerCase().endsWith('.mp4'))throw new Error('视频转码路径无效。');
  if(!Number.isFinite(input.maxDurationSeconds)||input.maxDurationSeconds<=0||input.maxDurationSeconds>7200)throw new Error('视频最长时长配置无效。');
  if(input.signal?.aborted)throw new DOMException('视频处理已取消。','AbortError');
  const script=join(process.cwd(),'scripts','transcode-material-video.ps1');
  const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-SourcePath',input.sourcePath,'-OutputDirectory',input.outputDirectory,'-MaxDurationSeconds',String(input.maxDurationSeconds),'-SegmentSeconds',String(MATERIAL_TRANSCODE_SEGMENT_SECONDS)],{env:materialTranscoderEnvironment() as NodeJS.ProcessEnv,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
  const events:TranscoderEvent[]=[];let pending='',timedOut=false;
  const stop=()=>{if(!child.killed)child.kill();};input.signal?.addEventListener('abort',stop,{once:true});
  const timer=setTimeout(()=>{timedOut=true;stop();},TRANSCODE_TIMEOUT_MS);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data',(chunk:string)=>{pending+=chunk;const lines=pending.split(/\r?\n/);pending=lines.pop()??'';for(const line of lines){if(!line.trim())continue;try{const event=parseMaterialTranscoderEvent(line);events.push(event);const probe=events.find(item=>item.type==='probed');if(event.type==='probed')input.onProgress?.({type:'probed',durationSeconds:event.durationSeconds,segmentCount:event.segmentCount});else if(event.type==='segment')input.onProgress?.({type:'segment',index:event.index,segmentCount:probe?.type==='probed'?probe.segmentCount:0,startSeconds:event.startSeconds,endSeconds:event.endSeconds});}catch{stop();}}});
  child.stderr.resume();
  try {
    const exitCode=await new Promise<number>((accept,reject)=>{child.once('error',()=>reject(new Error('无法启动 Windows 视频转码器。')));child.once('close',code=>accept(code??-1));});
    if(input.signal?.aborted)throw new DOMException('视频处理已取消。','AbortError');if(timedOut)throw new Error('视频转码超时，请缩短视频后重试。');
    if(pending.trim())events.push(parseMaterialTranscoderEvent(pending));
    const reportedError=[...events].reverse().find(event=>event.type==='error');if(reportedError?.type==='error')throw errorFor(reportedError.code);if(exitCode!==0)throw new Error('Windows 视频转码未完成。');
    const probe=events.find(event=>event.type==='probed'),complete=events.find(event=>event.type==='complete');
    if(probe?.type!=='probed'||complete?.type!=='complete'||!probe.hasAudio||probe.durationSeconds<=0||probe.durationSeconds>input.maxDurationSeconds||complete.durationSeconds!==probe.durationSeconds||probe.width<2||probe.height<2||probe.outputWidth<2||probe.outputHeight<2||probe.outputWidth%2!==0||probe.outputHeight%2!==0||Math.max(probe.outputWidth,probe.outputHeight)>1280)throw new Error('Windows 视频转码结果不完整。');
    const expected=planMaterialSegments(probe.durationSeconds),reported=events.filter((event):event is Extract<TranscoderEvent,{type:'segment'}>=>event.type==='segment');
    if(reported.length!==expected.length||complete.segmentCount!==expected.length)throw new Error('Windows 视频转码结果不完整。');
    const root=resolve(input.outputDirectory),segments:MaterialTranscodeSegment[]=[];
    for(const [index,plan]of expected.entries()){
      const event=reported[index],path=resolve(root,event.filename);
      if(event.index!==index||event.filename!==plan.filename||path!==resolve(root,plan.filename)||event.startSeconds!==plan.startSeconds||Math.abs(event.endSeconds-plan.endSeconds)>.01||Math.abs(event.actualDurationSeconds-(plan.endSeconds-plan.startSeconds))>.5)throw new Error('Windows 视频转码分段范围无效。');
      const info=await stat(path);if(!info.isFile()||info.size<=0||info.size>MATERIAL_TRANSCODE_MAX_SEGMENT_BYTES||event.bytes!==info.size)throw new Error('转码后的视频分段超过 32 MB 或文件无效。');
      segments.push({filename:event.filename,startSeconds:event.startSeconds,endSeconds:event.endSeconds,bytes:info.size});
    }
    return {durationSeconds:probe.durationSeconds,segments};
  } finally {clearTimeout(timer);input.signal?.removeEventListener('abort',stop);stop();}
}
