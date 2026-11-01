import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  DEFAULT_SHARED_LIVE_CONFIG_PATH, SHARED_LIVE_DURATION_MS, SHARED_LIVE_PORT,
  type SharedLiveStatus, atomicWriteJson, createSharedLiveTesters, createTunnelEnvironment,
  disableSharedLiveConfig, isProcessAlive, writeSharedLiveConfig, writeSharedLiveInvitations,
} from './shared-live-runtime';

const root=resolve(process.cwd()),sharedRoot=resolve(root,'output','shared-live');
const statusPath=join(sharedRoot,'current.json');
const databasePath=resolve(process.env.DATABASE_PATH?.trim()||join(root,'data','aeconn.sqlite'));
const configPath=resolve(process.env.SHARED_LIVE_CONFIG_PATH?.trim()||DEFAULT_SHARED_LIVE_CONFIG_PATH);
const cloudflaredPath=process.env.CLOUDFLARED_PATH?.trim()||'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe';

function readStatus():SharedLiveStatus|null {
  if(!existsSync(statusPath))return null;
  try{return JSON.parse(readFileSync(statusPath,'utf8')) as SharedLiveStatus;}catch{throw new Error('Shared live status file is invalid.');}
}
function saveStatus(status:SharedLiveStatus){
  const value={...status,updatedAt:new Date().toISOString()};atomicWriteJson(statusPath,value);atomicWriteJson(join(status.runRoot,'status.json'),value);
}
function stopOwnTunnel(child:ChildProcess|undefined){
  return new Promise<void>(done=>{
    if(!child||child.exitCode!==null){done();return;}
    child.once('exit',()=>done());
    if(!child.kill('SIGTERM'))done();
    setTimeout(()=>{if(child.exitCode===null)child.kill('SIGKILL');},2_000).unref();
  });
}
function reservePort(){
  return new Promise<Server>((resolvePort,reject)=>{const server=createServer(socket=>socket.destroy());server.once('error',reject);server.listen(SHARED_LIVE_PORT,'127.0.0.1',()=>{server.removeListener('error',reject);resolvePort(server);});});
}
function closeReservation(server:Server|undefined){return new Promise<void>(done=>{if(!server?.listening){done();return;}server.close(()=>done());});}
function startTunnel(){
  if(!existsSync(cloudflaredPath))throw new Error(`cloudflared not found: ${cloudflaredPath}`);
  const child=spawn(cloudflaredPath,['tunnel','--no-autoupdate','--loglevel','info','--url',`http://127.0.0.1:${SHARED_LIVE_PORT}`],{stdio:['ignore','pipe','pipe'],windowsHide:true,env:{...createTunnelEnvironment(),NODE_ENV:'production'}});
  return new Promise<{child:ChildProcess;publicUrl:string}>((resolveTunnel,reject)=>{
    let output='',settled=false,publicUrl='',registered=false;const finish=(error?:Error,url?:string)=>{if(settled)return;settled=true;clearTimeout(timeout);if(error){child.kill();reject(error);}else resolveTunnel({child,publicUrl:url!});};
    const timeout=setTimeout(()=>finish(new Error('Timed out waiting for the Cloudflare Quick Tunnel connection.')),45_000);
    const inspect=(chunk:Buffer)=>{output=`${output}${chunk.toString('utf8')}`.slice(-16_384);const match=output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);if(match)publicUrl=match[0];registered ||= output.includes('Registered tunnel connection');if(publicUrl&&registered)finish(undefined,publicUrl);};
    child.stdout?.on('data',inspect);child.stderr?.on('data',inspect);child.once('error',error=>finish(error));child.once('exit',code=>finish(new Error(`cloudflared exited before publishing a URL (${code}).`)));
  });
}
async function checkLocalRuntime(){
  const response=await fetch('http://127.0.0.1:3000/api/bootstrap',{signal:AbortSignal.timeout(8_000),cache:'no-store'});
  if(!response.ok)throw new Error(`Local Aeconn service health check failed (${response.status}).`);
  const data=await response.json() as {sharedDemo?:boolean;publicAccess?:boolean;capabilities?:{voiceConfigured?:boolean;interview?:string}};
  if(data.sharedDemo||data.publicAccess||data.capabilities?.voiceConfigured!==true||!data.capabilities?.interview?.includes('云端 AI'))throw new Error('Local Aeconn service is not ready for real OpenAI voice sharing.');
}
async function waitForPublicRuntime(publicUrl:string){
  let last='';
  await delay(2_000);
  for(let attempt=0;attempt<180;attempt+=1){
    try{
      const response=await fetch(`${publicUrl}/api/bootstrap`,{redirect:'manual',cache:'no-store',signal:AbortSignal.timeout(8_000)});last=`HTTP ${response.status}`;
      if(response.ok){const data=await response.json() as {publicAccess?:boolean;sharedDemo?:boolean;capabilities?:{voiceConfigured?:boolean;interview?:string}};if(data.publicAccess===true&&data.sharedDemo!==true&&data.capabilities?.voiceConfigured===true&&data.capabilities.interview?.includes('云端 AI'))return;last='unsafe public bootstrap';}
    }catch(error){last=error instanceof Error?`${error.message} (${(error.cause as {code?:string}|undefined)?.code??'transport'})`:String(error);}
    await delay(500);
  }
  throw new Error(`Public real voice endpoint did not become ready: ${last}`);
}
async function stopExisting(){
  const status=readStatus();if(!status){console.log('没有找到真实语音共享运行记录。');return;}
  if(status.state==='stopped'){console.log(`真实语音共享已停止。保留记录：${status.runRoot}`);return;}
  if(!isProcessAlive(status.launcherPid)){
    disableSharedLiveConfig(configPath,status.runId);saveStatus({...status,state:'stopped',error:undefined});console.log('共享启动器已退出；真实语音公网入口已关闭。');return;
  }
  writeFileSync(join(status.runRoot,'stop-requested'),`${new Date().toISOString()}\n`,{encoding:'utf8',mode:0o600});
  for(let attempt=0;attempt<80;attempt+=1){const current=readStatus();if(current?.state==='stopped'){console.log(`真实语音共享已停止。保留记录：${status.runRoot}`);return;}await delay(250);}
  throw new Error('Shared live launcher did not acknowledge stop within 20 seconds.');
}
function printStatus(){
  const status=readStatus();if(!status){console.log('真实语音共享尚未启动。');return;}
  console.log(JSON.stringify({state:status.state,publicUrl:status.publicUrl,expiresAt:status.expiresAt,runRoot:status.runRoot,updatedAt:status.updatedAt},null,2));
}
async function start(){
  const previous=readStatus();
  if(previous&&['starting','running'].includes(previous.state)){if(isProcessAlive(previous.launcherPid))throw new Error(`Real voice sharing is already ${previous.state}: ${previous.publicUrl??previous.runRoot}`);throw new Error('A stale real sharing record exists. Run npm run share:live -- --stop before starting again.');}
  await checkLocalRuntime();
  const reservation=await reservePort();
  const runId=randomUUID(),runRoot=join(sharedRoot,runId),credentialsPath=join(runRoot,'tester-credentials.json'),expiresAt=new Date(Date.now()+SHARED_LIVE_DURATION_MS).toISOString();
  mkdirSync(runRoot,{recursive:true});
  const status:SharedLiveStatus={state:'starting',runId,runRoot,launcherPid:process.pid,credentialsPath,expiresAt,updatedAt:new Date().toISOString()};saveStatus(status);
  let tunnel:ChildProcess|undefined,stopping=false;
  const cleanup=async(state:'stopped'|'failed',error?:unknown)=>{
    if(stopping)return;stopping=true;clearInterval(monitor);disableSharedLiveConfig(configPath,runId);await closeReservation(reservation);await stopOwnTunnel(tunnel);saveStatus({...status,state,error:error instanceof Error?error.message:undefined});
  };
  const monitor=setInterval(()=>{if(existsSync(join(runRoot,'stop-requested'))||Date.now()>=Date.parse(expiresAt))void cleanup('stopped').then(()=>process.exit(0));},250);
  process.once('SIGINT',()=>{void cleanup('stopped').then(()=>process.exit(0));});process.once('SIGTERM',()=>{void cleanup('stopped').then(()=>process.exit(0));});
  try{
    const testers=createSharedLiveTesters(databasePath,runId);atomicWriteJson(credentialsPath,testers.credentials);
    const published=await startTunnel();tunnel=published.child;status.publicUrl=published.publicUrl;status.tunnelPid=tunnel.pid;
    saveStatus(status);
    await closeReservation(reservation);
    writeSharedLiveConfig(configPath,{enabled:true,runId,origin:published.publicUrl,port:SHARED_LIVE_PORT,testerUserIds:testers.userIds,expiresAt});
    await waitForPublicRuntime(published.publicUrl);
    status.state='running';saveStatus(status);writeSharedLiveInvitations(sharedRoot,published.publicUrl,testers.credentials,expiresAt);
    console.log(`\n真实语音共享已启动：${published.publicUrl}`);console.log(`两份测试邀请保存在：${sharedRoot}`);console.log(`到期时间：${expiresAt}`);console.log('停止命令：npm run share:live -- --stop');
    await new Promise<void>((resolveWait,reject)=>{
      if(!tunnel||tunnel.exitCode!==null){reject(new Error(`cloudflared exited with code ${tunnel?.exitCode??'unknown'}.`));return;}
      tunnel.once('exit',code=>code===0?resolveWait():reject(new Error(`cloudflared exited with code ${code}.`)));
    });await cleanup('stopped');
  }catch(error){await cleanup('failed',error);throw error;}
}

const option=process.argv[2];if(option==='--stop')await stopExisting();else if(option==='--status')printStatus();else await start();
