import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import type { IncomingHttpHeaders } from 'node:http';
import { dirname, resolve } from 'node:path';

export const SHARED_LIVE_DEFAULT_PORT=3003;
export const SHARED_LIVE_HEADER='x-aeconn-shared-live';

export interface SharedLiveConfig {
  enabled:true;
  runId:string;
  origin:string;
  port:number;
  testerUserIds:string[];
  expiresAt:string;
}

export type VoiceAccessScope={audience:'local'}|{audience:'public';runId:string};

export class SharedAccessError extends Error {
  constructor(public readonly status=403,message='共享测试访问已失效。'){super(message);this.name='SharedAccessError';}
}

const shared=globalThis as typeof globalThis&{aeconnSharedLiveMarkerKey?:Buffer};
const markerKey=shared.aeconnSharedLiveMarkerKey??=randomBytes(32);

function configPath(){return resolve(/* turbopackIgnore: true */ process.env.SHARED_LIVE_CONFIG_PATH?.trim()||'./data/shared-live.json');}
function isObject(value:unknown):value is Record<string,unknown>{return Boolean(value)&&typeof value==='object'&&!Array.isArray(value);}

export function validateSharedLiveConfig(value:unknown,at=Date.now()):SharedLiveConfig {
  if(!isObject(value)||value.enabled!==true)throw new SharedAccessError(400,'共享语音配置无效。');
  const runId=value.runId,origin=value.origin,port=value.port,testerUserIds=value.testerUserIds,expiresAt=value.expiresAt;
  if(typeof runId!=='string'||!/^[A-Za-z0-9_-]{16,128}$/.test(runId))throw new SharedAccessError(400,'共享语音运行编号无效。');
  let parsedOrigin:URL;
  try{parsedOrigin=new URL(String(origin));}catch{throw new SharedAccessError(400,'共享语音 HTTPS 地址无效。');}
  if(parsedOrigin.protocol!=='https:'||parsedOrigin.origin!==origin||parsedOrigin.username||parsedOrigin.password)throw new SharedAccessError(400,'共享语音 HTTPS 地址无效。');
  if(!Number.isInteger(port)||Number(port)<1024||Number(port)>65535)throw new SharedAccessError(400,'共享语音端口无效。');
  if(!Array.isArray(testerUserIds)||testerUserIds.length<1||testerUserIds.length>20||testerUserIds.some(id=>typeof id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(id))||new Set(testerUserIds).size!==testerUserIds.length)throw new SharedAccessError(400,'共享语音测试账号无效。');
  if(typeof expiresAt!=='string'||!Number.isFinite(Date.parse(expiresAt))||Date.parse(expiresAt)<=at)throw new SharedAccessError(400,'共享语音配置已过期。');
  return {enabled:true,runId,origin,port:Number(port),testerUserIds:[...testerUserIds],expiresAt};
}

export function readSharedLiveConfig():SharedLiveConfig|null {
  let text:string;
  try{text=readFileSync(/* turbopackIgnore: true */ configPath(),'utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;return null;}
  try{return validateSharedLiveConfig(JSON.parse(text));}catch{return null;}
}

export function writeSharedLiveConfig(config:SharedLiveConfig):string {
  const validated=validateSharedLiveConfig(config),target=configPath(),temporary=`${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  mkdirSync(dirname(target),{recursive:true});
  try{
    writeFileSync(temporary,`${JSON.stringify(validated,null,2)}\n`,{encoding:'utf8',mode:0o600,flag:'wx'});
    renameSync(temporary,target);
  }catch(error){try{unlinkSync(temporary);}catch{}throw error;}
  return target;
}

function signature(config:SharedLiveConfig){return createHmac('sha256',markerKey).update(`${config.runId}\n${config.origin}\n${config.port}`).digest('hex');}
function marker(config:SharedLiveConfig){return `${config.runId}.${signature(config)}`;}
function headerValue(headers:Headers|IncomingHttpHeaders){return headers instanceof Headers?headers.get(SHARED_LIVE_HEADER):Array.isArray(headers[SHARED_LIVE_HEADER])?headers[SHARED_LIVE_HEADER]?.[0]:headers[SHARED_LIVE_HEADER]??null;}

export function stripSharedLiveMarker(headers:Headers|IncomingHttpHeaders){
  if(headers instanceof Headers)headers.delete(SHARED_LIVE_HEADER);
  else delete headers[SHARED_LIVE_HEADER];
}

export function stampSharedLiveMarker(headers:Headers|IncomingHttpHeaders,config:SharedLiveConfig){
  stripSharedLiveMarker(headers);
  if(headers instanceof Headers)headers.set(SHARED_LIVE_HEADER,marker(config));
  else headers[SHARED_LIVE_HEADER]=marker(config);
}

function configForMarker(headers:Headers|IncomingHttpHeaders):SharedLiveConfig|null {
  const provided=headerValue(headers);
  if(!provided)return null;
  const config=readSharedLiveConfig();
  if(!config)throw new SharedAccessError();
  const expected=marker(config),actual=Buffer.from(provided),wanted=Buffer.from(expected);
  if(actual.length!==wanted.length||!timingSafeEqual(actual,wanted))throw new SharedAccessError();
  return config;
}

export function publicRequestConfig(request:{headers:Headers|IncomingHttpHeaders}):SharedLiveConfig|null{return configForMarker(request.headers);}
export function sharedLiveScope(request:{headers:Headers|IncomingHttpHeaders}):VoiceAccessScope {
  const config=configForMarker(request.headers);
  return config?{audience:'public',runId:config.runId}:{audience:'local'};
}

export function validateSharedLiveHttpRequest(headers:IncomingHttpHeaders,method:string|undefined,config:SharedLiveConfig,webSocket=false){
  const origin=new URL(config.origin),host=Array.isArray(headers.host)?headers.host[0]:headers.host;
  if(host!==origin.host)throw new SharedAccessError();
  const suppliedOrigin=Array.isArray(headers.origin)?headers.origin[0]:headers.origin;
  if(webSocket||!['GET','HEAD'].includes((method||'GET').toUpperCase())){
    if(suppliedOrigin!==config.origin)throw new SharedAccessError();
  }else if(suppliedOrigin&&suppliedOrigin!==config.origin)throw new SharedAccessError();
}

export function sameSharedLiveConfig(left:SharedLiveConfig|null,right:SharedLiveConfig|null){
  return left===right||Boolean(left&&right&&left.runId===right.runId&&left.origin===right.origin&&left.port===right.port&&left.expiresAt===right.expiresAt&&left.testerUserIds.length===right.testerUserIds.length&&left.testerUserIds.every((id,index)=>id===right.testerUserIds[index]));
}
