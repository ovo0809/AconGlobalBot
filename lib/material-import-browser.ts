'use client';

import {
  MATERIAL_IMPORT_CHUNK_BYTES,
  MATERIAL_IMPORT_MAX_BYTES,
  MATERIAL_IMPORT_MAX_SECONDS,
  type MaterialImportJob,
} from './material-import-types';

export function isSupportedMaterialVideoFile(file:File){return file.type.startsWith('video/')||/\.(?:mp4|m4v|mov|webm)$/i.test(file.name);}

export function validateLargeMaterialVideo(file:File,durationSeconds?:number){
  if(/\.webm$/i.test(file.name)||file.type==='video/webm'||(!/\.(?:mp4|m4v|mov)$/i.test(file.name)&&!['video/mp4','video/quicktime','video/x-m4v'].includes(file.type)))throw new Error('大视频自动处理支持 MP4、MOV、M4V；WebM 请使用不超过 32 MB、10 分钟的小视频。');
  if(file.size<=0||file.size>MATERIAL_IMPORT_MAX_BYTES)throw new Error('单个视频须小于 2 GB。');
  if(durationSeconds!==undefined&&(!Number.isFinite(durationSeconds)||durationSeconds<=0||durationSeconds>MATERIAL_IMPORT_MAX_SECONDS))throw new Error('单个视频最长支持 2 小时。');
}

export function matchesMaterialImportFile(job:MaterialImportJob,file:File){
  return job.filename===file.name&&job.size===file.size&&job.lastModified===file.lastModified;
}

export function materialImportProgress(job:MaterialImportJob){
  if(job.state==='uploading')return `正在上传原视频 ${job.receivedChunks}/${job.totalChunks} 段`;
  if(job.state==='queued'||job.state==='preparing')return '正在本机压缩和分段';
  if(job.state==='ready')return `已准备 ${job.segments.length} 段，已送入提取 ${job.segments.filter(item=>item.materialId).length} 段`;
  if(job.state==='completed')return `已送入提取 ${job.segments.length} 段，等待逐段复核`;
  if(job.state==='failed')return `准备失败：${job.error||'请重试'}`;
  return '已取消';
}

export async function uploadMaterialImportChunks(input:{
  file:File;job:MaterialImportJob;csrf:string;signal?:AbortSignal;onProgress?:(job:MaterialImportJob)=>void;
}){
  let current=input.job;
  for(let index=0;index<current.totalChunks;index+=1){
    if(input.signal?.aborted)throw new DOMException('资料处理已取消。','AbortError');
    const body=input.file.slice(index*MATERIAL_IMPORT_CHUNK_BYTES,Math.min(input.file.size,(index+1)*MATERIAL_IMPORT_CHUNK_BYTES));
    const response=await fetch(`/api/material-imports?id=${encodeURIComponent(current.id)}&index=${index}`,{
      method:'PUT',credentials:'same-origin',cache:'no-store',headers:{'content-type':'application/octet-stream','x-csrf-token':input.csrf},body,signal:input.signal,
    });
    const value=await response.json().catch(()=>({})) as MaterialImportJob&{error?:string};
    if(!response.ok)throw new Error(value.error||'大视频分片上传未完成。');
    current=value;input.onProgress?.(current);
  }
  return current;
}
