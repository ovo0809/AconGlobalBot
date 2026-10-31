import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { VoiceHooks } from './voice-server';
import { attachVoiceServer } from './voice-server';
import { readSharedLiveConfig, sameSharedLiveConfig, SHARED_LIVE_HEADER, stampSharedLiveMarker, stripSharedLiveMarker, validateSharedLiveHttpRequest, type SharedLiveConfig } from './shared-live-access';

export interface SharedLiveServerOptions {
  handle:(request:IncomingMessage,response:ServerResponse)=>void|Promise<void>;
  hooks:VoiceHooks;
  readConfig?:()=>SharedLiveConfig|null;
  pollIntervalMs?:number;
}

interface RunningSharedServer {config:SharedLiveConfig;server:Server;sockets:Set<Socket>;voice:{close():Promise<void>}}

function listen(server:Server,port:number){return new Promise<void>((resolve,reject)=>{const error=(cause:Error)=>reject(cause);server.once('error',error);server.listen(port,'127.0.0.1',()=>{server.off('error',error);resolve();});});}
function closeHttp(server:Server){return new Promise<void>(resolve=>{if(!server.listening)return resolve();server.close(()=>resolve());server.closeAllConnections?.();});}

async function startOne(config:SharedLiveConfig,options:SharedLiveServerOptions):Promise<RunningSharedServer>{
  const sockets=new Set<Socket>();
  const server=createServer((request,response)=>{
    try{
      stripSharedLiveMarker(request.headers);validateSharedLiveHttpRequest(request.headers,request.method,config);stampSharedLiveMarker(request.headers,config);
      response.setHeader('X-Robots-Tag','noindex, nofollow, noarchive');response.setHeader('Cache-Control','no-store');
      void Promise.resolve(options.handle(request,response)).catch(()=>{if(!response.headersSent)response.writeHead(500,{'Content-Type':'text/plain; charset=utf-8'});response.end('服务暂时不可用。');});
    }catch{response.writeHead(403,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'}).end('共享测试访问已失效。');}
  });
  server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
  server.prependListener('upgrade',(request,socket)=>{
    try{stripSharedLiveMarker(request.headers);validateSharedLiveHttpRequest(request.headers,request.method,config,true);stampSharedLiveMarker(request.headers,config);}
    catch{request.headers[SHARED_LIVE_HEADER]='rejected';socket.destroy();}
  });
  const voice=attachVoiceServer(server,options.hooks);
  await listen(server,config.port);
  return {config,server,sockets,voice};
}

async function stopOne(running:RunningSharedServer|null){
  if(!running)return;
  await running.voice.close();
  for(const socket of running.sockets)socket.destroy();
  await closeHttp(running.server);
}

export function startSharedLiveServer(options:SharedLiveServerOptions){
  const readConfig=options.readConfig??readSharedLiveConfig,pollInterval=Math.max(100,options.pollIntervalMs??1_000);
  let current:RunningSharedServer|null=null,closed=false,chain=Promise.resolve();
  const refresh=()=>chain=chain.then(async()=>{
    if(closed)return;
    const desired=readConfig();
    if(sameSharedLiveConfig(current?.config??null,desired))return;
    const previous=current;current=null;await stopOne(previous);
    if(desired)current=await startOne(desired,options);
  }).catch(error=>{console.error('共享实时语音入口更新失败。');void error;});
  const timer=setInterval(()=>{void refresh();},pollInterval);timer.unref();
  void refresh();
  return {
    refresh,
    current:()=>current?.config??null,
    close:async()=>{closed=true;clearInterval(timer);await chain;const previous=current;current=null;await stopOne(previous);},
  };
}
