import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  SHARED_LIVE_PORT, assertSharedLiveSchema, atomicWriteJson, createSharedLiveTesters,
  createTunnelEnvironment, disableSharedLiveConfig, writeSharedLiveConfig, writeSharedLiveInvitations,
} from '../scripts/shared-live-runtime';

function fixture(version=8){
  const root=mkdtempSync(join(tmpdir(),'aeconn-shared-live-')),databasePath=join(root,'aeconn.sqlite');
  const db=new DatabaseSync(databasePath);
  db.exec(`PRAGMA user_version=${version};
    CREATE TABLE organizations(id TEXT PRIMARY KEY,settings TEXT NOT NULL);
    CREATE TABLE users(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),email TEXT UNIQUE,password_hash TEXT NOT NULL,doc TEXT NOT NULL);
    CREATE TABLE auth_sessions(id TEXT PRIMARY KEY,audience TEXT NOT NULL DEFAULT 'local',share_run_id TEXT);
    CREATE TABLE voice_tokens(token_hash TEXT PRIMARY KEY,audience TEXT NOT NULL DEFAULT 'local',share_run_id TEXT);
    INSERT INTO organizations VALUES('org-demo','{}');
    INSERT INTO users VALUES('existing','org-demo','existing@aeconn.example','untouched','{"id":"existing","role":"advisor"}');`);
  db.close();return {root,databasePath};
}

test('tunnel environment uses an allowlist and never inherits API credentials',()=>{
  const env=createTunnelEnvironment({Path:'C:\\Windows',TEMP:'C:\\Temp',OPENAI_API_KEY:'forbidden',GEMINI_API_KEY:'forbidden',DATABASE_PATH:'forbidden'});
  assert.equal(env.Path,'C:\\Windows');assert.equal(env.TEMP,'C:\\Temp');assert.equal(env.OPENAI_API_KEY,undefined);assert.equal(env.GEMINI_API_KEY,undefined);assert.equal(env.DATABASE_PATH,undefined);
});

test('real sharing requires audience-bound schema 8',()=>{
  const old=fixture(7),db=new DatabaseSync(old.databasePath);assert.throws(()=>assertSharedLiveSchema(db),/schema 8/);db.close();
  const current=fixture(),ready=new DatabaseSync(current.databasePath);assert.doesNotThrow(()=>assertSharedLiveSchema(ready));ready.close();
});

test('creates two isolated public tester advisors without changing existing users',()=>{
  const {databasePath}=fixture(),runId='a7677b84-a50f-41a6-bbdf-fce88fc847b1';
  const result=createSharedLiveTesters(databasePath,runId);
  assert.equal(result.credentials.length,2);assert.equal(new Set(result.credentials.map(item=>item.password)).size,2);assert.ok(result.credentials.every(item=>item.password.length>=16&&item.role==='advisor'));
  const db=new DatabaseSync(databasePath,{readOnly:true}),existing=db.prepare('SELECT password_hash,doc FROM users WHERE id=?').get('existing') as {password_hash:string;doc:string};
  assert.equal(existing.password_hash,'untouched');
  const testers=db.prepare("SELECT org_id,email,doc FROM users WHERE id<>'existing' ORDER BY email").all() as {org_id:string;email:string;doc:string}[];db.close();
  assert.equal(testers.length,2);assert.ok(testers.every(row=>row.org_id==='org-demo'&&row.email.startsWith('tester-a7677b84a5-')));
  for(const row of testers){const user=JSON.parse(row.doc);assert.equal(user.role,'advisor');assert.equal(user.accessScope,'public_tester');assert.equal(user.sharedRunId,runId);}
});

test('config activation and disable are atomic and run scoped',()=>{
  const root=mkdtempSync(join(tmpdir(),'aeconn-live-config-')),path=join(root,'shared-live.json'),runId='a7677b84-a50f-41a6-bbdf-fce88fc847b1';
  const config={enabled:true as const,runId,origin:'https://example.trycloudflare.com',port:SHARED_LIVE_PORT,testerUserIds:['one','two'],expiresAt:'2030-01-01T00:00:00.000Z'};
  writeSharedLiveConfig(path,config);assert.deepEqual(JSON.parse(readFileSync(path,'utf8')),config);
  assert.equal(disableSharedLiveConfig(path,'00000000-0000-0000-0000-000000000000'),false);assert.equal(JSON.parse(readFileSync(path,'utf8')).enabled,true);
  assert.equal(disableSharedLiveConfig(path,runId),true);const disabled=JSON.parse(readFileSync(path,'utf8'));assert.equal(disabled.enabled,false);assert.equal(disabled.runId,runId);
  atomicWriteJson(path,config);assert.deepEqual(JSON.parse(readFileSync(path,'utf8')),config);
});

test('invitation files describe real microphone testing and contain only assigned credentials',()=>{
  const root=mkdtempSync(join(tmpdir(),'aeconn-live-invite-')),credentials=[
    {email:'one@aeconn.example',password:'one-secure-password',role:'advisor' as const,name:'语音测试顾问1'},
    {email:'two@aeconn.example',password:'two-secure-password',role:'advisor' as const,name:'语音测试顾问2'},
  ];
  writeSharedLiveInvitations(root,'https://example.trycloudflare.com',credentials,'2030-01-01T00:00:00.000Z');
  const first=readFileSync(join(root,'真实语音测试邀请-顾问1.md'),'utf8'),second=readFileSync(join(root,'真实语音测试邀请-顾问2.md'),'utf8');
  assert.match(first,/开始连续语音对话/);assert.match(first,/Chrome 或 Edge/);assert.match(first,/OpenAI API 费用/);assert.match(first,/one-secure-password/);assert.doesNotMatch(first,/two-secure-password/);
  assert.match(second,/two-secure-password/);assert.doesNotMatch(second,/one-secure-password/);
});
