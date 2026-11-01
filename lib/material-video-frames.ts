import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { materialTranscoderEnvironment } from './material-transcoder';

const MAX_VIDEO_BYTES=32*1024*1024;
const MAX_FRAME_BYTES=8*1024*1024;
const FRAME_TIMEOUT_MS=60_000;
const extensionByMime:Record<string,string>={'video/mp4':'mp4','video/webm':'webm','video/quicktime':'mov'};

type FrameEvent={type:'complete';frames:Array<{index:number;timeSeconds:number;filename:string;bytes:number}>}|{type:'error';code:string};

function controlledChildPath(root:string,...parts:string[]){
  const target=resolve(root,...parts),rel=relative(root,target);
  if(!rel||isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep))throw new Error('视频抽帧临时路径无效。');
  return target;
}

function parseEvent(line:string):FrameEvent {
  let raw:unknown;try{raw=JSON.parse(line);}catch{throw new Error('视频抽帧器返回了无法识别的状态。');}
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('视频抽帧器返回了无法识别的状态。');
  const value=raw as Record<string,unknown>;
  if(value.type==='error'&&typeof value.code==='string'&&/^[A-Z_]+(?::[A-Za-z]+)?$/.test(value.code))return {type:'error',code:value.code};
  if(value.type!=='complete'||!Array.isArray(value.frames))throw new Error('视频抽帧器返回了无法识别的状态。');
  const frames=value.frames.map((entry,index)=>{
    if(!entry||typeof entry!=='object'||Array.isArray(entry))throw new Error('视频抽帧器返回了无效图片。');
    const frame=entry as Record<string,unknown>;
    if(frame.index!==index||typeof frame.timeSeconds!=='number'||!Number.isFinite(frame.timeSeconds)||typeof frame.filename!=='string'||frame.filename!==`frame-${String(index).padStart(3,'0')}.jpg`||typeof frame.bytes!=='number'||!Number.isSafeInteger(frame.bytes)||frame.bytes<=0||frame.bytes>MAX_FRAME_BYTES)throw new Error('视频抽帧器返回了无效图片。');
    return {index,timeSeconds:frame.timeSeconds,filename:frame.filename,bytes:frame.bytes};
  });
  return {type:'complete',frames};
}

function childError(code:string){
  if(code==='TIME_OUT_OF_RANGE')return new Error('抽帧时间超出视频范围。');
  if(code==='INVALID_MEDIA'||code==='CREATE_CLIP_FAILED'||code.startsWith('UNSUPPORTED_MEDIA:'))return new Error('Windows 无法读取这个视频编码。');
  return new Error('Windows 视频抽帧未完成。');
}

export async function extractMaterialVideoFrames(input:{video:Uint8Array;mimeType:string;times:number[]}):Promise<Array<{timeSeconds:number;image:Uint8Array;mimeType:'image/jpeg'}>>{
  if(process.platform!=='win32')throw new Error('视频自动补提取目前仅支持 Windows 本机 Demo。');
  const extension=extensionByMime[input.mimeType];
  if(!extension)throw new Error('视频抽帧格式不受支持。');
  if(!input.video.byteLength||input.video.byteLength>MAX_VIDEO_BYTES)throw new Error('视频为空或超过 32 MB。');
  if(!Array.isArray(input.times)||input.times.length<1||input.times.length>6||input.times.some(time=>typeof time!=='number'||!Number.isFinite(time)||time<0||time>600)||new Set(input.times).size!==input.times.length)throw new Error('视频抽帧时间无效。');

  const tempBase=resolve(tmpdir()),root=await mkdtemp(join(tempBase,'aeconn-material-frames-'));
  const rel=relative(tempBase,root);
  if(!rel||isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep))throw new Error('视频抽帧临时目录无效。');
  const source=controlledChildPath(root,`source.${extension}`);
  try {
    await writeFile(source,input.video,{flag:'wx'});
    const script=join(process.cwd(),'scripts','extract-material-frames.ps1');
    const extractOne=async(time:number,index:number)=>{
      // MediaComposition thumbnail extraction is single-use in Windows
      // PowerShell 5. Run each bounded timestamp in its own isolated process.
      const output=controlledChildPath(root,`frame-${index}`);
      try {
      await mkdir(output);
      const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-SourcePath',source,'-OutputDirectory',output,'-TimesJson',JSON.stringify([time])],{env:materialTranscoderEnvironment() as NodeJS.ProcessEnv,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
      let stdout='',timedOut=false;
      child.stdout.setEncoding('utf8');child.stdout.on('data',(chunk:string)=>{stdout+=chunk;if(Buffer.byteLength(stdout,'utf8')>64_000)child.kill();});child.stderr.resume();
      const timer=setTimeout(()=>{timedOut=true;child.kill();},FRAME_TIMEOUT_MS);
      const exitCode=await new Promise<number>((accept,reject)=>{child.once('error',()=>reject(new Error('无法启动 Windows 视频抽帧器。')));child.once('close',code=>accept(code??-1));}).finally(()=>clearTimeout(timer));
      if(timedOut)throw new Error('视频抽帧超时，请缩短视频后重试。');
      const lines=stdout.split(/\r?\n/).filter(line=>line.trim());
      if(lines.length!==1)throw new Error('视频抽帧器返回了无法识别的状态。');
      const event=parseEvent(lines[0]);
      if(event.type==='error')throw childError(event.code);
      if(exitCode!==0||event.frames.length!==1)throw new Error('Windows 视频抽帧未完成。');
      const frame=event.frames[0];
      if(Math.abs(frame.timeSeconds-time)>0.001)throw new Error('视频抽帧时间不一致。');
      const path=controlledChildPath(output,frame.filename),image=new Uint8Array(await readFile(path));
      if(image.byteLength!==frame.bytes||image.byteLength<4||image.byteLength>MAX_FRAME_BYTES||image[0]!==0xff||image[1]!==0xd8||image.at(-2)!==0xff||image.at(-1)!==0xd9)throw new Error('视频抽帧器返回了无效 JPEG。');
      return {timeSeconds:frame.timeSeconds,image,mimeType:'image/jpeg' as const};
      } finally {await rm(controlledChildPath(root,`frame-${index}`),{recursive:true,force:true});}
    };
    const frames:Array<{timeSeconds:number;image:Uint8Array;mimeType:'image/jpeg'}>=[];
    for(let index=0;index<input.times.length;index+=2){
      // Each process normalizes a private copy. Limit CPU/disk pressure and wait
      // for every child in a batch before removing its media on failure.
      const results=await Promise.allSettled(input.times.slice(index,index+2).map((time,offset)=>extractOne(time,index+offset)));
      const failed=results.find(result=>result.status==='rejected');if(failed?.status==='rejected')throw failed.reason;
      for(const result of results)if(result.status==='fulfilled')frames.push(result.value);
    }
    return frames;
  } finally {
    const cleanupRel=relative(tempBase,root);
    if(cleanupRel&& !isAbsolute(cleanupRel)&&cleanupRel!=='..'&&!cleanupRel.startsWith('..'+sep))await rm(root,{recursive:true,force:true});
  }
}
