import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { scenarios } from './scenarios';
import type { Case, Client, ProfileField, Settings, User } from './domain';

export const now = () => new Date().toISOString();
export const id = ():string => randomUUID();
export const pack = (value: unknown) => JSON.stringify(value);
export function unpack<T>(value: unknown): T { return JSON.parse(String(value)) as T; }
export function hashPassword(password:string) { const salt=randomBytes(16).toString('hex'); return `${salt}:${scryptSync(password,salt,64).toString('hex')}`; }
export function checkPassword(password:string,hash:string) { const [salt,key]=hash.split(':'); const expected=Buffer.from(key,'hex'); const actual=scryptSync(password,salt,64); return expected.length===actual.length && timingSafeEqual(expected,actual); }
const state = globalThis as typeof globalThis & { aeconnDb?:DatabaseSync };
export function db():DatabaseSync {
  if(state.aeconnDb) return state.aeconnDb;
  // Runtime database files are user data, never assets to trace into a Next deployment.
  const path=resolve(/* turbopackIgnore: true */ process.env.DATABASE_PATH || './data/aeconn.sqlite');
  mkdirSync(dirname(path),{recursive:true});
  const database=new DatabaseSync(path); state.aeconnDb=database;
  database.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS organizations (id TEXT PRIMARY KEY, settings TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, doc TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS clients (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), doc TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS cases (id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id), owner_id TEXT NOT NULL REFERENCES users(id), reviewer_id TEXT REFERENCES users(id), doc TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_sessions (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, user_id TEXT REFERENCES users(id), csrf TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'anonymous', active_case TEXT, active_interview TEXT, last_ended_case TEXT, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS interviews (id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), auth_id TEXT NOT NULL REFERENCES auth_sessions(id), state TEXT NOT NULL, entry TEXT, current_question TEXT, voice_state TEXT NOT NULL DEFAULT 'ended', incomplete INTEGER NOT NULL DEFAULT 0, deadline INTEGER, created_at TEXT NOT NULL, ended_at TEXT);
    CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), session_id TEXT NOT NULL, event_id TEXT NOT NULL, turn_id TEXT NOT NULL, role TEXT NOT NULL, doc TEXT NOT NULL, UNIQUE(session_id,event_id,role), UNIQUE(session_id,turn_id,role));
    CREATE TABLE IF NOT EXISTS profile_fields (case_id TEXT NOT NULL REFERENCES cases(id), field_key TEXT NOT NULL, doc TEXT NOT NULL, PRIMARY KEY(case_id,field_key));
    CREATE TABLE IF NOT EXISTS reports (case_id TEXT NOT NULL REFERENCES cases(id), version INTEGER NOT NULL, snapshot_id TEXT NOT NULL, doc TEXT NOT NULL, pdf BLOB NOT NULL, PRIMARY KEY(case_id,version), UNIQUE(case_id,snapshot_id));
    CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), doc TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, case_id TEXT NOT NULL, report_version INTEGER NOT NULL, snapshot_id TEXT NOT NULL, recipient_fingerprint TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, UNIQUE(case_id,report_version,recipient_fingerprint), FOREIGN KEY(case_id,report_version) REFERENCES reports(case_id,version));
    CREATE TABLE IF NOT EXISTS notification_jobs (id TEXT PRIMARY KEY, case_id TEXT NOT NULL, report_version INTEGER NOT NULL, recipient TEXT NOT NULL, notification_type TEXT NOT NULL, approval_id TEXT NOT NULL REFERENCES approvals(id), doc TEXT NOT NULL, UNIQUE(case_id,report_version,recipient,notification_type), FOREIGN KEY(case_id,report_version) REFERENCES reports(case_id,version));
    CREATE TABLE IF NOT EXISTS audit_events (id TEXT PRIMARY KEY, actor_id TEXT, case_id TEXT, action TEXT NOT NULL, metadata TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS voice_tokens (token_hash TEXT PRIMARY KEY, interview_id TEXT NOT NULL REFERENCES interviews(id), auth_id TEXT NOT NULL REFERENCES auth_sessions(id), expires_at INTEGER NOT NULL);
    PRAGMA user_version=1;
  `);
  seed(database); return database;
}
export function transaction<T>(fn:()=>T):T { const database=db(); database.exec('BEGIN IMMEDIATE'); try {const value=fn(); database.exec('COMMIT'); return value;} catch(error){database.exec('ROLLBACK');throw error;} }
export function docs<T>(sql:string,...args:(string|number|null)[]):T[] { return db().prepare(sql).all(...args).map(row=>unpack<T>(row.doc)); }
export function audit(actorId:string|null,caseId:string|null,action:string,metadata:unknown={}) { db().prepare('INSERT INTO audit_events VALUES(?,?,?,?,?,?)').run(id(),actorId,caseId,action,pack(metadata),now()); }
function seed(database:DatabaseSync) {
  if(database.prepare('SELECT id FROM organizations LIMIT 1').get()) return;
  database.exec('BEGIN IMMEDIATE');
  try {
    const settings:Settings={companyEmail:'company@aeconn.example',companyVerified:false,unreviewedSendPolicy:'pending',mailMode:'dry_run'};
    database.prepare('INSERT INTO organizations VALUES(?,?)').run('org-demo',pack(settings));
    const accountDefs=[['advisor-1','林顾问','advisor1','advisor'],['advisor-2','陈顾问','advisor2','advisor'],['charles','Charles','charles','reviewer'],['admin','系统管理员','admin','admin']] as const;
    const passwordHash=hashPassword(process.env.DEMO_PASSWORD || 'AeconnDemo!2026');
    for(const [userId,name,email,role] of accountDefs) {
      const user:User={id:userId,name,email:`${email}@aeconn.example`,role,orgId:'org-demo',emailVerified:false};
      database.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(userId,user.orgId,user.email,passwordHash,pack(user));
    }
    scenarios.forEach((scenario,index)=>{
      const clientId=`client-${index+1}`,caseId=`case-${index+1}`,ownerId=index<6?'advisor-1':'advisor-2',createdAt=now();
      const displayNames=['李明 · 退休准备','王芳 · 家庭责任','张伟 · 收入核对','陈静 · 退休现金流','刘洋 · 收入保障','赵宁 · 长期照护','周敏 · 多重目标','吴桐 · 现有保障','林悦 · 资料待补','何安 · 账户专项','徐佳 · 保留意见','郑宇 · 信息澄清'];
      const client:Client={id:clientId,name:`${displayNames[index]||scenario.name}（合成）`,birthday:'1985-06-15',gender:'不指定',phone:`+120255501${String(index).padStart(2,'0')}`,email:`client${index+1}@example.invalid`,maritalStatus:'已婚',state:'CA',language:'普通话',ownerAgentId:ownerId,consentStatus:'synthetic_demo',createdAt};
      const caseRecord:Case={id:caseId,clientId,ownerAgentId:ownerId,status:'needs_report',entry:scenario.entry,createdAt,updatedAt:createdAt,assignedReviewerId:null,reportVersion:0};
      database.prepare('INSERT INTO clients VALUES(?,?,?)').run(clientId,ownerId,pack(client));
      database.prepare('INSERT INTO cases VALUES(?,?,?,?,?)').run(caseId,clientId,ownerId,null,pack(caseRecord));
      const descriptionId=id();
      const description={id:descriptionId,caseId,sessionId:`seed-${caseId}`,eventId:descriptionId,turnId:descriptionId,role:'user',text:`合成场景：${scenario.description}`,final:true,interrupted:false,createdAt};
      database.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?)').run(descriptionId,caseId,description.sessionId,descriptionId,descriptionId,'user',pack(description));
      for(const partial of scenario.facts) {
        const messageId=id();
        const message={id:messageId,caseId,sessionId:`seed-${caseId}`,eventId:messageId,turnId:messageId,role:'user',text:`合成自述：${partial.key} = ${partial.value ?? '未知'} ${partial.currency ?? ''} ${partial.period ?? ''}`,final:true,interrupted:false,createdAt};
        database.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?)').run(messageId,caseId,message.sessionId,messageId,messageId,'user',pack(message));
        const fact:ProfileField={key:partial.key!,value:partial.value??null,currency:partial.currency??null,period:partial.period??null,factStatus:partial.factStatus??'reported_unverified',sourceMessageIds:[messageId],confirmedBy:null,confirmedAt:null};
        if(fact.factStatus==='confirmed'){fact.confirmedBy=ownerId;fact.confirmedAt=createdAt;}
        database.prepare('INSERT INTO profile_fields VALUES(?,?,?)').run(caseId,fact.key,pack(fact));
      }
    });
    database.exec('COMMIT');
  }catch(error){database.exec('ROLLBACK');throw error;}
}
