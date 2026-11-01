'use client';

export const MATERIAL_IMAGE_TYPES=['image/png','image/jpeg','image/webp'] as const;
export const MATERIAL_IMAGE_MAX_BYTES=8*1024*1024;
export const MATERIAL_VIDEO_MAX_BYTES=32*1024*1024;
export const MATERIAL_VIDEO_MAX_SECONDS=10*60;
export type MaterialPreparationStage='reading'|'inspecting'|'frames'|'audio'|'ready';
export interface PreparedMaterial {manifest:{durationSeconds:number;audioDurationSeconds:number;frames:Array<{field:string;startSeconds:number}>;audio:Array<{field:string;startSeconds:number}>};frames:Array<{field:string;blob:Blob}>;audio:Array<{field:string;blob:Blob}>}

export function materialVideoAudioRanges(duration:number){
  if(!Number.isFinite(duration)||duration<=0||duration>MATERIAL_VIDEO_MAX_SECONDS)throw new Error('视频时长无效。');
  return Array.from({length:Math.ceil(duration/15)},(_,index)=>({startSeconds:index*15,endSeconds:Math.min((index+1)*15,duration)}));
}

export function materialVideoFrameTimes(duration:number):number[]{
  if(!Number.isFinite(duration)||duration<=0||duration>MATERIAL_VIDEO_MAX_SECONDS)throw new Error('视频时长无效。');
  const tail=Math.max(0,duration-.05);
  const starts=Array.from({length:Math.min(20,Math.max(1,Math.ceil(duration/30)))},(_,i)=>Math.min(i*30,tail));
  // Include the ending without exceeding the existing 20-frame request bound.
  if(tail-starts[starts.length-1]>1){if(starts.length===20)starts.pop();starts.push(tail);}
  return starts;
}

const MEDIA_EVENT_TIMEOUT_MS=12_000;
const aborted=()=>new DOMException('资料处理已取消。','AbortError');
function check(signal?:AbortSignal){if(signal?.aborted)throw aborted();}
function waitFor(target:EventTarget,event:string,signal?:AbortSignal){return new Promise<void>((resolve,reject)=>{
  check(signal);
  const timer=window.setTimeout(()=>{clean();reject(new Error('媒体文件读取超时，请检查文件是否损坏。'));},MEDIA_EVENT_TIMEOUT_MS);
  const clean=()=>{window.clearTimeout(timer);target.removeEventListener(event,ok);target.removeEventListener('error',bad);signal?.removeEventListener('abort',cancel);};
  const ok=()=>{clean();resolve();},bad=()=>{clean();reject(new Error('无法读取媒体文件，请换用浏览器支持的格式。'));},cancel=()=>{clean();reject(aborted());};
  target.addEventListener(event,ok,{once:true});target.addEventListener('error',bad,{once:true});signal?.addEventListener('abort',cancel,{once:true});
});}
function canvasBlob(canvas:HTMLCanvasElement,signal?:AbortSignal){return new Promise<Blob>((resolve,reject)=>{check(signal);canvas.toBlob(blob=>{try{check(signal);if(blob)resolve(blob);else reject(new Error('无法生成资料画面。'));}catch(error){reject(error);}},'image/jpeg',.84);});}
function ascii(view:DataView,offset:number,value:string){for(let i=0;i<value.length;i+=1)view.setUint8(offset+i,value.charCodeAt(i));}
function wav(samples:Float32Array,rate=16_000){const data=new ArrayBuffer(44+samples.length*2),view=new DataView(data);ascii(view,0,'RIFF');view.setUint32(4,36+samples.length*2,true);ascii(view,8,'WAVE');ascii(view,12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,rate,true);view.setUint32(28,rate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);ascii(view,36,'data');view.setUint32(40,samples.length*2,true);for(let i=0;i<samples.length;i+=1){const n=Math.max(-1,Math.min(1,samples[i]));view.setInt16(44+i*2,n<0?n*0x8000:n*0x7fff,true);}return new Blob([data],{type:'audio/wav'});}
export function renderMaterialAudioChunk(source:Pick<AudioBuffer,'getChannelData'|'length'|'numberOfChannels'|'sampleRate'>,start:number,end:number){const rate=16_000,out=new Float32Array(Math.max(1,Math.ceil((end-start)*rate)));for(let i=0;i<out.length;i+=1){const index=Math.floor((start+i/rate)*source.sampleRate);if(index>=source.length){out[i]=0;continue;}let total=0;for(let c=0;c<source.numberOfChannels;c+=1)total+=source.getChannelData(c)[index]||0;out[i]=total/source.numberOfChannels;}return wav(out,rate);}

export function validateMaterialFile(file:File):'image'|'video'{
  if((MATERIAL_IMAGE_TYPES as readonly string[]).includes(file.type)){if(file.size<=0||file.size>MATERIAL_IMAGE_MAX_BYTES)throw new Error('图片须为 PNG、JPEG 或 WebP，且不超过 8 MB。');return'image';}
  if(file.type.startsWith('video/')){if(file.size<=0||file.size>MATERIAL_VIDEO_MAX_BYTES)throw new Error('视频文件不能超过 32 MB。');return'video';}
  throw new Error('目前支持 PNG、JPEG、WebP 图片，以及浏览器可读取的视频文件。');
}

export async function prepareMaterialImage(file:File,signal?:AbortSignal):Promise<PreparedMaterial>{
  if(validateMaterialFile(file)!=='image')throw new Error('请选择图片文件。');check(signal);let image:ImageBitmap;
  try{image=await createImageBitmap(file);}catch{throw new Error('无法读取图片，请换用有效的 PNG、JPEG 或 WebP 文件。');}
  try{check(signal);if(!image.width||!image.height||image.width*image.height>40_000_000)throw new Error('图片尺寸无效或超过 4000 万像素。');const scale=Math.min(1,2048/Math.max(image.width,image.height)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.width*scale));canvas.height=Math.max(1,Math.round(image.height*scale));const context=canvas.getContext('2d');if(!context)throw new Error('浏览器无法读取图片。');context.drawImage(image,0,0,canvas.width,canvas.height);return{manifest:{durationSeconds:0,audioDurationSeconds:0,frames:[{field:'frame0',startSeconds:0}],audio:[]},frames:[{field:'frame0',blob:await canvasBlob(canvas,signal)}],audio:[]};}finally{image.close();}
}

export async function prepareMaterialVideo(file:File,options:{signal?:AbortSignal;onStage?:(stage:MaterialPreparationStage)=>void}={}):Promise<PreparedMaterial>{
  if(validateMaterialFile(file)!=='video')throw new Error('请选择视频文件。');const {signal,onStage}=options;onStage?.('reading');check(signal);const url=URL.createObjectURL(file),video=document.createElement('video');video.muted=true;video.preload='auto';video.playsInline=true;let context:AudioContext|undefined;
  try{
    video.src=url;onStage?.('inspecting');if(video.readyState<1)await waitFor(video,'loadedmetadata',signal);
    let duration=video.duration;
    if(!Number.isFinite(duration)){
      const durationSeek=waitFor(video,'seeked',signal);video.currentTime=Number.MAX_SAFE_INTEGER;await durationSeek;duration=video.duration;
      if(Number.isFinite(duration)){const resetSeek=waitFor(video,'seeked',signal);video.currentTime=0;await resetSeek;}
    }
    if(!Number.isFinite(duration)||duration<=0)throw new Error('无法确认视频时长。');if(duration>MATERIAL_VIDEO_MAX_SECONDS)throw new Error('单个视频最长支持 10 分钟。');if(video.readyState<2)await waitFor(video,'loadeddata',signal);
    const starts=materialVideoFrameTimes(duration),frames:Array<{field:string;blob:Blob}>=[];onStage?.('frames');
    for(const [i,start]of starts.entries()){
      check(signal);
      if(Math.abs(video.currentTime-start)>.04){const seeked=waitFor(video,'seeked',signal);video.currentTime=start;await seeked;}
      const scale=Math.min(1,1280/Math.max(video.videoWidth,video.videoHeight)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(video.videoWidth*scale));canvas.height=Math.max(1,Math.round(video.videoHeight*scale));const drawing=canvas.getContext('2d');if(!drawing)throw new Error('浏览器无法读取视频画面。');drawing.drawImage(video,0,0,canvas.width,canvas.height);frames.push({field:`frame${i}`,blob:await canvasBlob(canvas,signal)});
    }
    onStage?.('audio');const bytes=await file.arrayBuffer();check(signal);const Audio=window.AudioContext||window.webkitAudioContext;if(!Audio)throw new Error('当前浏览器不支持视频音轨提取。');context=new Audio();let decoded:AudioBuffer;
    try{decoded=await context.decodeAudioData(bytes.slice(0));}catch{throw new Error('无法读取视频音轨，请换用含有可识别音轨的 MP4、WebM 或 MOV 文件。');}
    const tolerance=.25;
    if(decoded.numberOfChannels<1||decoded.numberOfChannels>8||!Number.isFinite(decoded.duration)||decoded.duration<.1||decoded.sampleRate>192_000||decoded.length>decoded.sampleRate*(duration+tolerance)||Math.abs(decoded.duration-duration)>tolerance)throw new Error('视频音轨范围与画面时长不一致，无法安全提取。');
    const ranges=materialVideoAudioRanges(duration),audio:Array<{field:string;blob:Blob}>=[];for(const [i,range]of ranges.entries()){check(signal);audio.push({field:`audio${i}`,blob:renderMaterialAudioChunk(decoded,range.startSeconds,range.endSeconds)});}if(!audio.length)throw new Error('视频没有可识别的音轨。');onStage?.('ready');return{manifest:{durationSeconds:duration,audioDurationSeconds:decoded.duration,frames:frames.map((item,i)=>({field:item.field,startSeconds:starts[i]})),audio:audio.map((item,i)=>({field:item.field,startSeconds:ranges[i].startSeconds}))},frames,audio};
  }finally{video.removeAttribute('src');video.load();URL.revokeObjectURL(url);if(context)await context.close().catch(()=>undefined);}
}

declare global{interface Window{webkitAudioContext?:typeof AudioContext}}
