import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SharedLiveConfig } from '../lib/shared-live-access';

export type { SharedLiveConfig } from '../lib/shared-live-access';

export const SHARED_LIVE_PORT=3003;
export const SHARED_LIVE_DURATION_MS=24*60*60*1_000;
export const DEFAULT_SHARED_LIVE_CONFIG_PATH=resolve('data','shared-live.json');

export interface SharedLiveCredential {
  email:string;
  password:string;
  role:'advisor';
  name:string;
}

export interface SharedLiveStatus {
  state:'starting'|'running'|'stopped'|'failed';
  runId:string;
  runRoot:string;
  publicUrl?:string;
  tunnelPid?:number;
  launcherPid:number;
  credentialsPath:string;
  expiresAt:string;
  updatedAt:string;
  error?:string;
}

const SYSTEM_ENV_KEYS=['COMSPEC','NUMBER_OF_PROCESSORS','OS','Path','PATH','PATHEXT','PROCESSOR_ARCHITECTURE','SystemDrive','SystemRoot','TEMP','TMP','WINDIR'] as const;

export function createTunnelEnvironment(base:Record<string,string|undefined>=process.env):Record<string,string|undefined> {
  const safe:Record<string,string|undefined>={};
  for(const key of SYSTEM_ENV_KEYS)if(base[key])safe[key]=base[key];
  return safe;
}

export function createSharedLivePassword(){return randomBytes(24).toString('base64url');}
function hashPassword(password:string){const salt=randomBytes(16).toString('hex');return `${salt}:${scryptSync(password,salt,64).toString('hex')}`;}

function columnNames(database:DatabaseSync,table:string){
  return new Set((database.prepare(`PRAGMA table_info(${table})`).all() as {name:string}[]).map(row=>row.name));
}

export function assertSharedLiveSchema(database:DatabaseSync){
  const version=Number((database.prepare('PRAGMA user_version').get() as {user_version:number}).user_version);
  if(version<8)throw new Error('Aeconn database must be migrated to schema 8 before real sharing.');
  const auth=columnNames(database,'auth_sessions'),tokens=columnNames(database,'voice_tokens');
  for(const field of ['audience','share_run_id'])if(!auth.has(field))throw new Error(`auth_sessions.${field} is required for real sharing.`);
  for(const field of ['audience','share_run_id'])if(!tokens.has(field))throw new Error(`voice_tokens.${field} is required for real sharing.`);
}

export function createSharedLiveTesters(databasePath:string,runId:string):{credentials:SharedLiveCredential[];userIds:string[]} {
  if(!/^[0-9a-f-]{36}$/i.test(runId))throw new Error('Shared live run ID must be a UUID.');
  const database=new DatabaseSync(resolve(databasePath));
  database.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
  try{
    assertSharedLiveSchema(database);
    const organization=database.prepare('SELECT id FROM organizations WHERE id=?').get('org-demo');
    if(!organization)throw new Error('The Aeconn demo organization is missing.');
    const shortRun=runId.replaceAll('-','').slice(0,10).toLowerCase();
    const credentials:SharedLiveCredential[]=[],userIds:string[]=[];
    database.exec('BEGIN IMMEDIATE');
    try{
      for(let index=1;index<=2;index+=1){
        const userId=randomUUID(),email=`tester-${shortRun}-${index}@aeconn.example`,password=createSharedLivePassword(),name=`语音测试顾问${index}`;
        const user={id:userId,name,email,role:'advisor',orgId:'org-demo',emailVerified:false,accessScope:'public_tester',sharedRunId:runId};
        database.prepare('INSERT INTO users(id,org_id,email,password_hash,doc) VALUES(?,?,?,?,?)').run(userId,'org-demo',email,hashPassword(password),JSON.stringify(user));
        credentials.push({email,password,role:'advisor',name});userIds.push(userId);
      }
      database.exec('COMMIT');
    }catch(error){database.exec('ROLLBACK');throw error;}
    return {credentials,userIds};
  }finally{database.close();}
}

export function atomicWriteJson(path:string,value:unknown,mode=0o600){
  const destination=resolve(path);mkdirSync(dirname(destination),{recursive:true});
  const temporary=`${destination}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temporary,`${JSON.stringify(value,null,2)}\n`,{encoding:'utf8',mode,flag:'wx'});
  renameSync(temporary,destination);
}

export function writeSharedLiveConfig(path:string,config:SharedLiveConfig){atomicWriteJson(path,config);}

export function disableSharedLiveConfig(path:string,runId:string){
  if(!existsSync(path))return false;
  let current:{enabled?:boolean;runId?:string};
  try{current=JSON.parse(readFileSync(path,'utf8')) as typeof current;}catch{return false;}
  if(current.runId!==runId)return false;
  atomicWriteJson(path,{enabled:false,runId,disabledAt:new Date().toISOString()});
  return true;
}

export function writeSharedLiveInvitations(directory:string,publicUrl:string,credentials:SharedLiveCredential[],expiresAt:string){
  mkdirSync(directory,{recursive:true});
  for(const [index,credential] of credentials.entries()){
    const content=[`# Aeconn 真实语音测试邀请（顾问 ${index+1}）`,'',`打开 [Aeconn 真实语音 Demo](${publicUrl})`,'',`账号：${credential.email}`,'',`密码：${credential.password}`,'',
      `链接有效至：${expiresAt}`,'','请只把这份邀请发给对应测试者，并且只录入虚构客户资料。两个账号的案例互相隔离；共用同一账号的人会看到相同案例。','',
      '建议使用电脑 Chrome 或 Edge：登录 → 新建虚构客户 → 开始客户访谈 → 选择入口 → 点击“开始连续语音对话” → 允许麦克风 → 完成两轮对话 → 点击“结束对话” → 查看报告和 PDF。','',
      '这是会产生 OpenAI API 费用的真实语音测试。应用继续执行每案例、每日和每月费用保护；邮件仍只预览。不要在共享链接里输入真实客户资料。','',
      '邀请人的电脑、Aeconn 本机服务及共享启动器必须保持运行和联网。共享停止或到期后，本邀请失效。',''].join('\n');
    writeFileSync(join(directory,`真实语音测试邀请-顾问${index+1}.md`),content,{encoding:'utf8',mode:0o600});
  }
}

export function isProcessAlive(pid:number|undefined){
  if(!pid||!Number.isSafeInteger(pid)||pid<=0)return false;
  try{process.kill(pid,0);return true;}catch{return false;}
}
