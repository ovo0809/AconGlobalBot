import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { backup, DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { Bootstrap, Message, ReportJob, ReportRecord } from '../lib/domain';
import { beginUsage, completeUsage, getUsageProgress, getUsageSummary, recordUsage } from '../lib/ai-usage';

const databaseRoot = mkdtempSync(join(tmpdir(), 'aeconn-service-test-'));
process.env.DATABASE_PATH = join(databaseRoot, 'service.sqlite');
process.env.DEMO_PASSWORD = 'AeconnDemo!2026';
process.env.MAIL_MODE = 'dry_run';
delete process.env.LLM_PROVIDER;
delete process.env.GEMINI_API_KEY;
delete process.env.GEMINI_MODEL;
delete process.env.GEMINI_LIVE_MODEL;
delete process.env.VOICE_PROVIDER;
delete process.env.OPENAI_API_KEY;
delete process.env.OPENAI_MODEL;

const servicePromise = import('../lib/service');
const ORIGIN = 'http://localhost';

async function body<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

function sessionCookie(response: Response): string | null {
  return response.headers.get('set-cookie')?.split(';', 1)[0] ?? null;
}

async function safeAction(request: Request): Promise<Response> {
  const service = await servicePromise;
  try {
    return await service.action(request);
  } catch (error) {
    return service.errorResponse(error);
  }
}

async function safeBootstrap(request: Request): Promise<Response> {
  const service = await servicePromise;
  try {
    return service.bootstrap(request);
  } catch (error) {
    return service.errorResponse(error);
  }
}

async function safeReport(request: Request): Promise<Response> {
  const service = await servicePromise;
  try {
    return service.reportDownload(request);
  } catch (error) {
    return service.errorResponse(error);
  }
}

class BrowserSession {
  cookie = '';
  csrf = '';

  async bootstrap(caseId?: string): Promise<{ response: Response; data: Bootstrap | { error: string } }> {
    const query = caseId ? `?caseId=${encodeURIComponent(caseId)}` : '';
    const response = await safeBootstrap(new Request(`${ORIGIN}/api/bootstrap${query}`, {
      headers: this.cookie ? { cookie: this.cookie } : undefined,
    }));
    const nextCookie = sessionCookie(response);
    if (nextCookie) this.cookie = nextCookie;
    const data = await body<Bootstrap | { error: string }>(response);
    if ('csrf' in data) this.csrf = data.csrf;
    return { response, data };
  }

  async action(input: Record<string, unknown>, options: { csrf?: string; origin?: string } = {}): Promise<{ response: Response; data: Record<string, unknown> }> {
    const response = await safeAction(new Request(`${ORIGIN}/api/action`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: this.cookie,
        'x-csrf-token': options.csrf ?? this.csrf,
        origin: options.origin ?? ORIGIN,
      },
      body: JSON.stringify(input),
    }));
    const nextCookie = sessionCookie(response);
    if (nextCookie) this.cookie = nextCookie;
    return { response, data: await body<Record<string, unknown>>(response) };
  }

  async login(email: string): Promise<Bootstrap> {
    await this.bootstrap();
    const login = await this.action({ action: 'login', email, password: 'AeconnDemo!2026' });
    assert.equal(login.response.status, 200, JSON.stringify(login.data));
    const loggedIn = await this.bootstrap();
    assert.equal(loggedIn.response.status, 200);
    assert.ok('user' in loggedIn.data && loggedIn.data.user);
    return loggedIn.data as Bootstrap;
  }

  async report(caseId: string, version: number, format = 'pdf'): Promise<Response> {
    return await safeReport(new Request(`${ORIGIN}/api/report?caseId=${encodeURIComponent(caseId)}&version=${version}&format=${format}`, {
      headers: { cookie: this.cookie },
    }));
  }
}

let createdCounter = 0;
async function createCase(session: BrowserSession, suffix: string): Promise<string> {
  createdCounter += 1;
  const result = await session.action({
    action: 'createClient',
    name: `合成测试客户 ${suffix}`,
    birthday: '1987-03-12',
    gender: '不指定',
    phone: `+1 202 555 ${String(1000 + createdCounter)}`,
    email: `service-${createdCounter}@example.invalid`,
    maritalStatus: '已婚',
    state: 'CA',
    language: '普通话',
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.data));
  return String(result.data.caseId);
}

test('anonymous sessions, login integrity, CSRF/origin and role data boundaries', async () => {
  const anonymous = new BrowserSession();
  const first = await anonymous.bootstrap();
  assert.equal(first.response.status, 200);
  assert.equal((first.data as Bootstrap).mode, 'anonymous');
  assert.equal((first.data as Bootstrap).user, null);
  assert.match(first.response.headers.get('cache-control') ?? '', /no-store/);

  const noCsrf = await anonymous.action({ action: 'login', email: 'advisor1@aeconn.example', password: 'AeconnDemo!2026' }, { csrf: 'wrong' });
  assert.equal(noCsrf.response.status, 403);
  const badOrigin = await anonymous.action({ action: 'login', email: 'advisor1@aeconn.example', password: 'AeconnDemo!2026' }, { origin: 'https://evil.example' });
  assert.equal(badOrigin.response.status, 403);

  const advisor1 = new BrowserSession();
  const advisor1Data = await advisor1.login('advisor1@aeconn.example');
  assert.equal(advisor1Data.user?.role, 'advisor');
  assert.ok(advisor1Data.cases.every((record) => record.ownerAgentId === 'advisor-1'));

  const advisor2 = new BrowserSession();
  const advisor2Data = await advisor2.login('advisor2@aeconn.example');
  assert.ok(advisor2Data.cases.every((record) => record.ownerAgentId === 'advisor-2'));
  const crossCase = await advisor2.bootstrap('case-1');
  assert.equal(crossCase.response.status, 403);
  assert.equal((await advisor2.report('case-1', 1)).status, 403);

  const reviewer = new BrowserSession();
  const reviewerData = await reviewer.login('charles@aeconn.example');
  assert.equal(reviewerData.cases.length, 0);
  assert.equal((await reviewer.report('case-1', 1)).status, 403);

  const admin = new BrowserSession();
  const adminData = await admin.login('admin@aeconn.example');
  assert.equal(adminData.clients.length, 0);
  assert.equal(adminData.cases.length, 0);
  assert.ok(adminData.settings);
  assert.ok(adminData.users?.length);
  assert.equal((await admin.report('case-1', 1)).status, 403);
});

test('client creation requires all six fields and ownership is server-derived', async () => {
  const advisor = new BrowserSession();
  await advisor.login('advisor1@aeconn.example');
  const missing = await advisor.action({ action: 'createClient', name: '字段不完整', birthday: '1985-01-01' });
  assert.equal(missing.response.status, 400);
  const invalidContact = await advisor.action({ action: 'createClient', name: '无效联系方式', birthday: '1985-01-01', gender: '不指定', phone: '12', email: 'bad', maritalStatus: '未知' });
  assert.equal(invalidContact.response.status, 400);
  const caseId = await createCase(advisor, '六字段');
  const data = (await advisor.bootstrap(caseId)).data as Bootstrap;
  assert.equal(data.activeCase?.ownerAgentId, 'advisor-1');
  assert.equal(data.clients.find((client) => client.id === data.activeCase?.clientId)?.ownerAgentId, 'advisor-1');
});

test('voice diagnostics persist only fixed reason metadata and retain separate attempts',async()=>{
  const advisor=new BrowserSession();await advisor.login('advisor1@aeconn.example');const caseId=await createCase(advisor,'语音诊断');
  await advisor.action({action:'enterClient',caseId});await advisor.action({action:'chooseEntry',caseId,entry:'life'});
  const sessionId=((await advisor.bootstrap()).data as Bootstrap).clientSession!.id;
  const service=await servicePromise;
  service.voiceHooks.diagnostic(sessionId,{code:'spending_limit',stage:'preflight'});
  service.voiceHooks.diagnostic(sessionId,{code:'spending_limit',stage:'preflight'});
  service.voiceHooks.diagnostic(sessionId,{code:'voice_usage_unverified',stage:'runtime'});
  const {db,unpack}=await import('../lib/db');
  const rows=db().prepare("SELECT action,metadata FROM audit_events WHERE case_id=? AND action IN ('voice.start_failed','voice.stopped') ORDER BY rowid").all(caseId) as {action:string;metadata:string}[];
  assert.deepEqual(rows.map(row=>({action:row.action,metadata:unpack(row.metadata)})),[
    {action:'voice.start_failed',metadata:{code:'spending_limit',stage:'preflight',sessionId}},
    {action:'voice.start_failed',metadata:{code:'spending_limit',stage:'preflight',sessionId}},
    {action:'voice.stopped',metadata:{code:'voice_usage_unverified',stage:'runtime',sessionId}},
  ]);
  assert.doesNotMatch(JSON.stringify(rows),/语音诊断|OPENAI|sk-|客户/);
  await advisor.action({action:'end',caseId});
});

test('owner can soft-delete and restore stable numbered cases without deleting usage or history',async()=>{
  await drainReportJobs();
  const owner=new BrowserSession();await owner.login('advisor1@aeconn.example');
  createdCounter+=1;
  const created=await owner.action({action:'createClient',name:'Mike',birthday:'1987-03-12',gender:'不指定',phone:`+1 202 555 ${String(1000+createdCounter)}`,email:`mike-${createdCounter}@example.invalid`,maritalStatus:'已婚',state:'CA',language:'普通话'});
  assert.equal(created.response.status,200,JSON.stringify(created.data));
  const clientId=String(created.data.clientId),baseId=String(created.data.caseId);
  const second=await owner.action({action:'createCase',clientId});const third=await owner.action({action:'createCase',clientId});
  const secondId=String(second.data.caseId),thirdId=String(third.data.caseId);
  let state=(await owner.bootstrap()).data as Bootstrap;
  const names=new Map(state.cases.filter(record=>record.clientId===clientId).map(record=>[record.id,record.clientName]));
  assert.equal(names.get(baseId),'Mike');assert.equal(names.get(secondId),'Mike（1）');assert.equal(names.get(thirdId),'Mike（2）');
  assert.equal(state.activeCase?.clientName,state.cases.find(record=>record.id===state.activeCase?.id)?.clientName);

  const otherOwnerSession=new BrowserSession();await otherOwnerSession.login('advisor1@aeconn.example');
  const anotherAdvisor=new BrowserSession();await anotherAdvisor.login('advisor2@aeconn.example');
  assert.equal((await anotherAdvisor.action({action:'deleteCase',caseId:thirdId})).response.status,403);
  const reviewer=new BrowserSession();await reviewer.login('charles@aeconn.example');
  assert.equal((await reviewer.action({action:'deleteCase',caseId:thirdId})).response.status,403);

  const usage=beginUsage({context:{caseId:thirdId},operation:'interview',model:'gpt-6-luna',reserveMicros:50_000});
  await owner.action({action:'enterClient',caseId:thirdId});
  assert.equal((await owner.action({action:'deleteCase',caseId:thirdId})).response.status,403,'client mode cannot delete cases');
  assert.equal((await otherOwnerSession.action({action:'deleteCase',caseId:thirdId})).response.status,409,'an active interview blocks deletion');
  await owner.action({action:'chooseEntry',caseId:thirdId,entry:'life'});await owner.action({action:'end',caseId:thirdId});
  assert.equal((await otherOwnerSession.action({action:'deleteCase',caseId:thirdId})).response.status,409,'a queued report blocks deletion');
  await drainReportJobs();

  const {db}=await import('../lib/db');
  db().exec("CREATE TEMP TRIGGER fail_soft_delete_audit BEFORE INSERT ON audit_events WHEN NEW.action='case.soft_deleted' BEGIN SELECT RAISE(ABORT,'synthetic soft delete rollback'); END");
  assert.equal((await otherOwnerSession.action({action:'deleteCase',caseId:thirdId})).response.status,500);
  db().exec('DROP TRIGGER fail_soft_delete_audit');
  assert.equal((await otherOwnerSession.bootstrap(thirdId)).response.status,200,'audit failure rolls back the soft-delete state');
  const deleted=await otherOwnerSession.action({action:'deleteCase',caseId:thirdId});
  assert.equal(deleted.response.status,200,JSON.stringify(deleted.data));assert.equal(deleted.data.nextCaseId,secondId);
  state=(await otherOwnerSession.bootstrap()).data as Bootstrap;
  assert.equal(state.cases.some(record=>record.id===thirdId),false);
  const endedOwnerBootstrap=await owner.bootstrap();assert.equal(endedOwnerBootstrap.response.status,200);assert.notEqual((endedOwnerBootstrap.data as Bootstrap).activeCase?.id,thirdId,'a deleted last-ended case falls back safely');
  const deletedBootstrap=await otherOwnerSession.bootstrap(thirdId);assert.equal(deletedBootstrap.response.status,404,'deleted cases cannot be selected directly');assert.equal((deletedBootstrap.data as {code?:string}).code,'CASE_NOT_FOUND');
  assert.deepEqual(getUsageProgress(usage.id),{costMicros:0,reservedMicros:50_000},'soft delete retains usage reservations');

  db().exec("CREATE TEMP TRIGGER fail_restore_audit BEFORE INSERT ON audit_events WHEN NEW.action='case.restored' BEGIN SELECT RAISE(ABORT,'synthetic restore rollback'); END");
  assert.equal((await otherOwnerSession.action({action:'restoreCase',caseId:thirdId})).response.status,500);
  db().exec('DROP TRIGGER fail_restore_audit');
  assert.ok(((await otherOwnerSession.bootstrap()).data as Bootstrap).deletedCases?.some(record=>record.id===thirdId),'audit failure rolls back the restored state');
  const restored=await otherOwnerSession.action({action:'restoreCase',caseId:thirdId});
  assert.equal(restored.response.status,200);assert.equal(restored.data.nextCaseId,thirdId);
  state=(await otherOwnerSession.bootstrap(thirdId)).data as Bootstrap;
  assert.equal(state.activeCase?.clientName,'Mike（2）');assert.equal(state.cases.find(record=>record.id===thirdId)?.clientName,'Mike（2）');
  completeUsage(usage.id,'released');
});

test('permanent deletion requires ownership, explicit confirmation and atomically removes every case-linked record',async()=>{
  await drainReportJobs();
  const owner=new BrowserSession();await owner.login('advisor1@aeconn.example');
  createdCounter+=1;
  const created=await owner.action({action:'createClient',name:'永久删除合成客户',birthday:'1987-03-12',gender:'不指定',phone:`+1 202 555 ${String(1000+createdCounter)}`,email:`purge-${createdCounter}@example.invalid`,maritalStatus:'已婚',state:'CA',language:'普通话'});
  assert.equal(created.response.status,200,JSON.stringify(created.data));
  const clientId=String(created.data.clientId),caseId=String(created.data.caseId);
  await owner.action({action:'enterClient',caseId});await owner.action({action:'chooseEntry',caseId,entry:'life'});
  await owner.action({action:'message',caseId,text:'我想保障家庭。',eventId:'purge-goal'});await owner.action({action:'end',caseId});await drainReportJobs();
  let state=(await owner.bootstrap(caseId)).data as Bootstrap;const report=state.reports[0];assert.ok(report);
  const approved=await owner.action({action:'approveSend',caseId,version:report.version,snapshotId:report.snapshotId,recipientFingerprint:report.recipientFingerprint});assert.equal(approved.response.status,200,JSON.stringify(approved.data));
  const {db,id,now,pack}=await import('../lib/db');
  const interview=db().prepare('SELECT id,auth_id FROM interviews WHERE case_id=?').get(caseId) as {id:string;auth_id:string};
  const reviewId=id();db().prepare('INSERT INTO reviews VALUES(?,?,?)').run(reviewId,caseId,pack({id:reviewId,caseId,reportVersion:report.version,reviewerId:'charles',decision:'approved',reason:'合成测试',createdAt:now()}));
  db().prepare('INSERT INTO voice_tokens VALUES(?,?,?,?)').run(`purge-token-${createdCounter}`,interview.id,interview.auth_id,Date.now()+60_000);
  const deleted=await owner.action({action:'deleteCase',caseId});assert.equal(deleted.response.status,200,JSON.stringify(deleted.data));
  state=(await owner.bootstrap()).data as Bootstrap;assert.equal(state.deletedCases?.find(item=>item.id===caseId)?.clientName,'永久删除合成客户');
  assert.equal(state.clients.some(client=>client.id===clientId),false,'a deleted-only client profile is not returned with the recycle-bin summary');
  assert.equal((await owner.report(caseId,report.version)).status,404,'soft-deleted reports cannot be downloaded directly');
  const pendingUsage=beginUsage({context:{caseId},operation:'interview',model:'gpt-6-luna',reserveMicros:50_000});
  assert.equal((await owner.action({action:'purgeCase',caseId,confirmation:'永久删除'})).response.status,409,'an unsettled call blocks permanent deletion');completeUsage(pendingUsage.id,'released');
  const settledUsage=beginUsage({context:{caseId},operation:'interview',model:'gpt-6-luna',reserveMicros:50_000});recordUsage(settledUsage.id,'purge-settled','responses',{input_tokens:1_000,output_tokens:100,input_tokens_details:{cached_tokens:0}});completeUsage(settledUsage.id,'settled');
  const usageBeforePurge=getUsageSummary('org-demo'),settledRowBefore=db().prepare('SELECT * FROM ai_usage_calls WHERE id=?').get(settledUsage.id),settledEventsBefore=db().prepare('SELECT COUNT(*) count FROM ai_usage_events WHERE call_id=?').get(settledUsage.id) as {count:number};

  const other=new BrowserSession();await other.login('advisor2@aeconn.example');const otherState=(await other.bootstrap()).data as Bootstrap;assert.equal(otherState.deletedCases?.some(item=>item.id===caseId)??false,false);assert.equal(otherState.clients.some(item=>item.id===clientId),false);assert.equal((await other.action({action:'purgeCase',caseId,confirmation:'永久删除'})).response.status,403);
  const reviewer=new BrowserSession();await reviewer.login('charles@aeconn.example');const reviewerState=(await reviewer.bootstrap()).data as Bootstrap;assert.equal(reviewerState.deletedCases,undefined);assert.equal(reviewerState.clients.some(item=>item.id===clientId),false);assert.equal((await reviewer.action({action:'purgeCase',caseId,confirmation:'永久删除'})).response.status,403);
  const admin=new BrowserSession();await admin.login('admin@aeconn.example');const adminState=(await admin.bootstrap()).data as Bootstrap;assert.equal(adminState.deletedCases,undefined);assert.equal(adminState.clients.some(item=>item.id===clientId),false);assert.equal((await admin.action({action:'purgeCase',caseId,confirmation:'永久删除'})).response.status,403);
  const clientMode=new BrowserSession();await clientMode.login('advisor1@aeconn.example');const activeId=await createCase(clientMode,'永久删除权限');await clientMode.action({action:'enterClient',caseId:activeId});const clientState=(await clientMode.bootstrap()).data as Bootstrap;assert.equal(clientState.deletedCases,undefined);assert.equal(clientState.clients.some(item=>item.id===clientId),false);assert.equal((await clientMode.action({action:'purgeCase',caseId,confirmation:'永久删除'})).response.status,403);
  const activeRow=db().prepare('SELECT doc FROM cases WHERE id=?').get(activeId) as {doc:string},activeRecord=JSON.parse(activeRow.doc);db().prepare('UPDATE cases SET doc=? WHERE id=?').run(pack({...activeRecord,deletedAt:now(),deletedBy:'advisor-1'}),activeId);
  assert.equal((await owner.action({action:'purgeCase',caseId:activeId,confirmation:'永久删除'})).response.status,409,'an inconsistent archived case with a live interview is still protected');db().prepare('UPDATE cases SET doc=? WHERE id=?').run(activeRow.doc,activeId);await clientMode.action({action:'end',caseId:activeId});
  assert.equal((await owner.action({action:'purgeCase',caseId})).response.status,400);

  db().exec(`CREATE TEMP TRIGGER fail_case_purge BEFORE DELETE ON cases WHEN OLD.id='${caseId}' BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END`);
  assert.equal((await owner.action({action:'purgeCase',caseId,confirmation:'永久删除'})).response.status,500);
  db().exec('DROP TRIGGER fail_case_purge');
  assert.ok(db().prepare('SELECT id FROM cases WHERE id=?').get(caseId),'transaction rollback keeps the case');
  assert.ok(db().prepare('SELECT id FROM messages WHERE case_id=?').get(caseId),'transaction rollback keeps case history');
  assert.deepEqual(db().prepare('SELECT * FROM ai_usage_calls WHERE id=?').get(settledUsage.id),settledRowBefore,'transaction rollback keeps the original usage call');assert.equal((db().prepare('SELECT COUNT(*) count FROM ai_usage_events WHERE call_id=?').get(settledUsage.id) as {count:number}).count,settledEventsBefore.count);
  const usageAfterRollback=getUsageSummary('org-demo');assert.deepEqual(usageAfterRollback.day,usageBeforePurge.day);assert.deepEqual(usageAfterRollback.month,usageBeforePurge.month);

  // Stale pointers from any browser are cleared as part of the same deletion transaction.
  db().prepare("UPDATE auth_sessions SET mode='client',active_case=?,active_interview=?,last_ended_case=? WHERE user_id='advisor-1' AND id<>?").run(caseId,interview.id,caseId,interview.auth_id);
  const purged=await owner.action({action:'purgeCase',caseId,confirmation:'永久删除'});assert.equal(purged.response.status,200,JSON.stringify(purged.data));
  const count=(sql:string,value:string)=>Number((db().prepare(sql).get(value) as {count:number}).count);
  for(const table of ['cases','messages','profile_fields','reports','reviews','approvals','notification_jobs','audit_events','report_jobs','interviews','ai_usage_calls'])assert.equal(count(`SELECT COUNT(*) count FROM ${table} WHERE ${table==='cases'?'id':'case_id'}=?`,caseId),0,table);
  assert.equal(count('SELECT COUNT(*) count FROM interview_extractions WHERE session_id=?',interview.id),0);
  assert.equal(count('SELECT COUNT(*) count FROM voice_tokens WHERE interview_id=?',interview.id),0);
  assert.equal(db().prepare('SELECT id FROM ai_usage_calls WHERE id=?').get(settledUsage.id),undefined);assert.equal((db().prepare('SELECT COUNT(*) count FROM ai_usage_events WHERE call_id=?').get(settledUsage.id) as {count:number}).count,0);
  const usageAfterPurge=getUsageSummary('org-demo');assert.deepEqual(usageAfterPurge.day,usageBeforePurge.day);assert.deepEqual(usageAfterPurge.month,usageBeforePurge.month);
  assert.equal(db().prepare('SELECT id FROM clients WHERE id=?').get(clientId),undefined,'the last case removes the client profile');
  assert.equal(db().prepare('SELECT id FROM auth_sessions WHERE active_case=? OR active_interview=? OR last_ended_case=?').get(caseId,interview.id,caseId),undefined);
  const service=await servicePromise;
  service.voiceHooks.persist(interview.id,{role:'user',text:'永久删除后的迟到语音',eventId:'purge:late',turnId:'purge-late',final:true});
  service.voiceHooks.status(interview.id,'transcript_incomplete');
  service.voiceHooks.diagnostic(interview.id,{code:'voice_usage_unverified',stage:'runtime'});
  await assert.rejects(()=>service.voiceHooks.getContext(interview.id),/访谈不存在/);
  assert.equal(count('SELECT COUNT(*) count FROM messages WHERE case_id=?',caseId),0,'late voice callbacks cannot recreate messages');
  assert.equal(count('SELECT COUNT(*) count FROM audit_events WHERE case_id=?',caseId),0,'late voice callbacks cannot recreate audit history');
  assert.equal((await owner.bootstrap(caseId)).response.status,404);assert.equal((await owner.report(caseId,report.version)).status,404);
});

test('permanent deletion preserves sibling clients and never reuses or renumbers case suffixes',async()=>{
  await drainReportJobs();const owner=new BrowserSession();await owner.login('advisor1@aeconn.example');
  createdCounter+=1;const created=await owner.action({action:'createClient',name:'编号稳定客户',birthday:'1987-03-12',gender:'不指定',phone:`+1 202 555 ${String(1000+createdCounter)}`,email:`stable-${createdCounter}@example.invalid`,maritalStatus:'已婚',state:'CA',language:'普通话'});
  const clientId=String(created.data.clientId),baseId=String(created.data.caseId),secondId=String((await owner.action({action:'createCase',clientId})).data.caseId),thirdId=String((await owner.action({action:'createCase',clientId})).data.caseId);
  await owner.action({action:'deleteCase',caseId:secondId});assert.equal((await owner.action({action:'purgeCase',caseId:secondId,confirmation:'永久删除'})).response.status,200);
  const fourthId=String((await owner.action({action:'createCase',clientId})).data.caseId);const state=(await owner.bootstrap(fourthId)).data as Bootstrap;
  const names=new Map(state.cases.filter(item=>item.clientId===clientId).map(item=>[item.id,item.clientName]));
  assert.equal(names.get(baseId),'编号稳定客户');assert.equal(names.get(thirdId),'编号稳定客户（2）');assert.equal(names.get(fourthId),'编号稳定客户（3）');assert.ok(state.clients.some(client=>client.id===clientId));
  const {db,unpack}=await import('../lib/db');const seededRow=db().prepare("SELECT doc FROM cases WHERE id='case-1'").get() as {doc:string},seededClientRow=db().prepare("SELECT clients.doc FROM clients JOIN cases ON cases.client_id=clients.id WHERE cases.id='case-1'").get() as {doc:string};
  const seeded=unpack<import('../lib/domain').Case>(seededRow.doc),seededClient=unpack<import('../lib/domain').Client>(seededClientRow.doc);
  assert.equal(seeded.caseNumber,0,'existing rows receive stable persisted numbers during migration');assert.equal(seededClient.nextCaseNumber,1);
});

test('case-number migration preserves the first valid number and repairs later duplicates above the prior maximum',()=>{
  const migrationPath=join(databaseRoot,'duplicate-number-migration.sqlite'),options={cwd:process.cwd(),env:{...process.env,DATABASE_PATH:migrationPath},encoding:'utf8' as const};
  const setup=spawnSync(process.execPath,['--import','tsx','--input-type=module','--eval',`const {db,pack,unpack}=await import('./lib/db.ts');const d=db(),row=d.prepare("SELECT client_id,owner_id,doc FROM cases WHERE id='case-1'").get(),record=unpack(row.doc);record.id='case-duplicate';record.caseNumber=0;d.prepare('INSERT INTO cases(id,client_id,owner_id,reviewer_id,doc) VALUES(?,?,?,?,?)').run(record.id,row.client_id,row.owner_id,null,pack(record));`],options);
  assert.equal(setup.status,0,setup.stderr);
  const migrated=spawnSync(process.execPath,['--import','tsx','--input-type=module','--eval',`const {db,unpack}=await import('./lib/db.ts');const rows=db().prepare("SELECT doc FROM cases WHERE id IN ('case-1','case-duplicate') ORDER BY rowid").all().map(row=>unpack(row.doc).caseNumber);console.log(JSON.stringify(rows));`],options);
  assert.equal(migrated.status,0,migrated.stderr);assert.deepEqual(JSON.parse(migrated.stdout.trim()),[0,1]);
});

test('failed case creation rolls back its persistent suffix counter',async()=>{
  const owner=new BrowserSession();await owner.login('advisor1@aeconn.example');createdCounter+=1;
  const created=await owner.action({action:'createClient',name:'编号事务客户',birthday:'1987-03-12',gender:'不指定',phone:`+1 202 555 ${String(1000+createdCounter)}`,email:`counter-${createdCounter}@example.invalid`,maritalStatus:'已婚',state:'CA',language:'普通话'}),clientId=String(created.data.clientId);
  const {db}=await import('../lib/db');db().exec(`CREATE TEMP TRIGGER fail_case_create BEFORE INSERT ON cases WHEN NEW.client_id='${clientId}' BEGIN SELECT RAISE(ABORT,'synthetic creation rollback'); END`);
  assert.equal((await owner.action({action:'createCase',clientId})).response.status,500);db().exec('DROP TRIGGER fail_case_create');
  const nextId=String((await owner.action({action:'createCase',clientId})).data.caseId),state=(await owner.bootstrap(nextId)).data as Bootstrap;
  assert.equal(state.activeCase?.clientName,'编号事务客户（1）','a failed insert cannot consume a case suffix');
});

test('all four entries start and end through restricted client mode', async () => {
  const advisor = new BrowserSession();
  await advisor.login('advisor1@aeconn.example');
  for (const entry of ['life', 'annuity', 'ltc', 'disability_income']) {
    const caseId = await createCase(advisor, entry);
    const entered = await advisor.action({ action: 'enterClient', caseId });
    assert.equal(entered.response.status, 200);
    const restricted = (await advisor.bootstrap()).data as Bootstrap;
    assert.equal(restricted.mode, 'client');
    assert.equal(restricted.user, null);
    assert.deepEqual(restricted.clients, []);
    assert.deepEqual(restricted.reports, []);
    assert.equal(restricted.activeCase?.clientId, '');
    const selected = await advisor.action({ action: 'chooseEntry', caseId, entry });
    assert.equal(selected.response.status, 200, `${entry}: ${JSON.stringify(selected.data)}`);
    const ended = await advisor.action({ action: 'end', caseId });
    assert.equal(ended.response.status, 200);
    const endedAgain = await advisor.action({ action: 'end', caseId });
    assert.equal(endedAgain.response.status, 200);
    assert.equal(endedAgain.data.caseId, caseId);
  }
});

test('client mode blocks internal actions, direct IDs and report downloads; pause/end revoke voice token', async () => {
  const advisor = new BrowserSession();
  await advisor.login('advisor1@aeconn.example');
  const caseId = await createCase(advisor, '客户模式边界');
  await advisor.action({ action: 'enterClient', caseId });
  await advisor.action({ action: 'chooseEntry', caseId, entry: 'life' });

  const internal = await advisor.action({ action: 'approveSend', caseId, version: 1, snapshotId: 'fake', recipientFingerprint: 'fake' });
  assert.equal(internal.response.status, 403);
  assert.equal((await advisor.report('case-1', 1)).status, 403);
  const wrongCase = await advisor.action({ action: 'message', caseId: 'case-1', text: '尝试越权', eventId: 'wrong-case-event' });
  assert.equal(wrongCase.response.status, 403);

  const paused = await advisor.action({ action: 'pause', caseId });
  assert.equal(paused.response.status, 200);
  const whilePaused = await advisor.action({ action: 'message', caseId, text: '暂停时不应保存', eventId: 'paused-event' });
  assert.equal(whilePaused.response.status, 409);
  assert.equal((await advisor.action({ action: 'resume', caseId })).response.status, 200);

  process.env.VOICE_PROVIDER = 'gemini';
  process.env.GEMINI_API_KEY = 'synthetic-test-key';
  process.env.GEMINI_LIVE_MODEL = 'synthetic-test-model';
  const tokenResponse = await advisor.action({ action: 'voiceToken', caseId });
  assert.equal(tokenResponse.response.status, 200);
  const token = String(tokenResponse.data.token);
  const ended = await advisor.action({ action: 'end', caseId });
  assert.equal(ended.response.status, 200);
  assert.equal((await servicePromise).voiceHooks.consumeToken(token), null);
  delete process.env.VOICE_PROVIDER;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_LIVE_MODEL;
});

test('text interview preserves unknown/declined and validates numeric currency/period', async () => {
  const advisor = new BrowserSession();
  await advisor.login('advisor1@aeconn.example');
  const caseId = await createCase(advisor, '事实类型');
  await advisor.action({ action: 'enterClient', caseId });
  await advisor.action({ action: 'chooseEntry', caseId, entry: 'disability_income' });
  assert.equal((await advisor.action({ action: 'message', caseId, text: '不知道', eventId: 'fact-goal' })).response.status, 200);
  assert.equal((await advisor.action({ action: 'message', caseId, text: '不愿提供', eventId: 'fact-employment' })).response.status, 200);
  assert.equal((await advisor.action({ action: 'message', caseId, text: '5000', eventId: 'fact-income-invalid' })).response.status, 200);
  assert.equal((await advisor.action({ action: 'message', caseId, text: '5000 USD 每月', eventId: 'fact-income-valid' })).response.status, 200);
  await advisor.action({ action: 'end', caseId });
  const data = (await advisor.bootstrap(caseId)).data as Bootstrap;
  const byKey = new Map(data.facts.map((fact) => [fact.key, fact]));
  assert.equal(byKey.get('goal')?.factStatus, 'unknown');
  assert.equal(byKey.get('goal')?.value, null);
  assert.equal(byKey.get('employment')?.factStatus, 'declined');
  assert.equal(byKey.get('employment')?.value, null);
  assert.equal(byKey.get('income')?.value, 5000);
  assert.equal(byKey.get('income')?.currency, 'USD');
  assert.equal(byKey.get('income')?.period, 'month');
  assert.equal(byKey.get('income')?.sourceMessageIds.length, 1);
  assert.ok(data.messages.some((message) => message.text.includes('请确认金额、币种')));
});

test('report PDF, fact versions, review queue and dry-run notification snapshots are immutable', async () => {
  const advisor = new BrowserSession();
  await advisor.login('advisor1@aeconn.example');
  const generated = await advisor.action({ action: 'generateReport', caseId: 'case-1' });
  assert.equal(generated.response.status, 200, JSON.stringify(generated.data));
  assert.equal(generated.data.version, 1);

  const initialData = (await advisor.bootstrap('case-1')).data as Bootstrap;
  const v1 = initialData.reports.find((report) => report.version === 1);
  assert.ok(v1);
  const pdf = await advisor.report('case-1', 1);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  const pdfBytes = new Uint8Array(await pdf.arrayBuffer());
  assert.equal(Buffer.from(pdfBytes.subarray(0, 4)).toString(), '%PDF');
  assert.ok(pdfBytes.length > 50_000);

  const badSourceShape = await advisor.action({ action: 'updateFact', caseId: 'case-1', key: 'income', value: 2500, factStatus: 'confirmed', reason: '缺少币种周期的反向测试' });
  assert.equal(badSourceShape.response.status, 400);
  const corrected = await advisor.action({ action: 'updateFact', caseId: 'case-1', key: 'care', value: '希望优先居家照护', factStatus: 'confirmed', reason: '顾问依据客户补充完成确认' });
  assert.equal(corrected.response.status, 200, JSON.stringify(corrected.data));
  assert.equal(corrected.data.version, 2);
  const versioned = (await advisor.bootstrap('case-1')).data as Bootstrap;
  assert.equal(versioned.reports.find((report) => report.version === 1)?.stale, true);
  assert.equal(versioned.reports.find((report) => report.version === 2)?.stale, false);

  assert.equal((await advisor.action({ action: 'cancelSend', caseId: 'case-1', version: 2 })).response.status, 200);
  assert.equal(((await advisor.bootstrap('case-1')).data as Bootstrap).notifications.length, 0);
  assert.equal((await advisor.action({ action: 'submitReview', caseId: 'case-1' })).response.status, 200);

  const charles = new BrowserSession();
  const charlesData = await charles.login('charles@aeconn.example');
  assert.ok(charlesData.cases.some((record) => record.id === 'case-1'));
  const missingReason = await charles.action({ action: 'review', caseId: 'case-1', decision: 'approved', reason: '' });
  assert.equal(missingReason.response.status, 400);
  const reviewed = await charles.action({ action: 'review', caseId: 'case-1', decision: 'approved', reason: '已核对合成案例的引用与缺失项' });
  assert.equal(reviewed.response.status, 200, JSON.stringify(reviewed.data));
  assert.equal(reviewed.data.version, 3);

  const reviewedData = (await advisor.bootstrap('case-1')).data as Bootstrap;
  const v3 = reviewedData.reports.find((report) => report.version === 3);
  assert.ok(v3);
  assert.equal(v3.reviewStatus, 'reviewed');
  assert.match(v3.fullText, /本版本人工复核意见：approved：已核对合成案例的引用与缺失项/);
  assert.ok(v3.headerLines?.some((line) => line === '复核状态：reviewed'));
  assert.equal(reviewedData.reviews.at(-1)?.decision, 'approved');
  const approve = await advisor.action({ action: 'approveSend', caseId: 'case-1', version: 3, snapshotId: v3.snapshotId, recipientFingerprint: v3.recipientFingerprint });
  assert.equal(approve.response.status, 200, JSON.stringify(approve.data));
  assert.equal((await advisor.action({ action: 'approveSend', caseId: 'case-1', version: 3, snapshotId: v3.snapshotId, recipientFingerprint: v3.recipientFingerprint })).response.status, 200);
  const afterApproval = (await advisor.bootstrap('case-1')).data as Bootstrap;
  assert.equal(afterApproval.notifications.length, 2);
  for (const job of afterApproval.notifications) {
    assert.equal(job.status, 'dry_run');
    assert.match(job.body, /Aeconn AI Agent 内部报告/);
    assert.match(job.body, /case_id：case-1/);
    assert.match(job.attachmentUrl, /version=3/);
  }

  const v1Again = await advisor.report('case-1', 1);
  assert.equal(v1Again.status, 200);
  assert.deepEqual(new Uint8Array(await v1Again.arrayBuffer()), pdfBytes);
});

test('reviewer can correct facts only on an assigned case and the subsequent review note is immutable', async () => {
  const advisor = new BrowserSession();
  await advisor.login('advisor1@aeconn.example');
  assert.equal((await advisor.action({ action: 'generateReport', caseId: 'case-3' })).response.status, 200);
  assert.equal((await advisor.action({ action: 'submitReview', caseId: 'case-3' })).response.status, 200);

  const charles = new BrowserSession();
  await charles.login('charles@aeconn.example');
  const unassigned = await charles.action({ action: 'updateFact', caseId: 'case-4', key: 'care', value: '越权修改', factStatus: 'confirmed', reason: '反向权限测试' });
  assert.equal(unassigned.response.status, 403);
  const corrected = await charles.action({ action: 'updateFact', caseId: 'case-3', key: 'care', value: '希望由家人协助居家照护', factStatus: 'confirmed', reason: 'Charles 根据合成访谈记录完成确认' });
  assert.equal(corrected.response.status, 200, JSON.stringify(corrected.data));
  assert.equal(corrected.data.version, 2);
  const afterCorrection = (await charles.bootstrap('case-3')).data as Bootstrap;
  const care = afterCorrection.facts.find((fact) => fact.key === 'care');
  assert.equal(care?.confirmedBy, 'charles');
  assert.equal(care?.value, '希望由家人协助居家照护');
  assert.equal(afterCorrection.reports.find((report) => report.version === 1)?.stale, true);

  const reviewed = await charles.action({ action: 'review', caseId: 'case-3', decision: 'amended', reason: '已确认照护偏好；其余缺失项保留待顾问追问' });
  assert.equal(reviewed.response.status, 200, JSON.stringify(reviewed.data));
  assert.equal(reviewed.data.version, 3);
  const final = (await charles.bootstrap('case-3')).data as Bootstrap;
  const reviewedReport = final.reports.find((report) => report.version === 3);
  assert.ok(reviewedReport);
  assert.match(reviewedReport.fullText, /本版本人工复核意见：amended：已确认照护偏好；其余缺失项保留待顾问追问/);
  assert.ok(reviewedReport.headerLines?.some((line) => line === '复核状态：reviewed'));
  assert.equal(final.reviews.at(-1)?.reason, '已确认照护偏好；其余缺失项保留待顾问追问');
});

test('recipient changes invalidate previews, and pending policy blocks unreviewed live send', async () => {
  const advisor = new BrowserSession();
  await advisor.login('advisor1@aeconn.example');
  const before = (await advisor.bootstrap('case-1')).data as Bootstrap;
  const current = before.reports.find((report) => report.version === before.activeCase?.reportVersion) as ReportRecord;
  assert.ok(current);

  const admin = new BrowserSession();
  await admin.login('admin@aeconn.example');
  const updateSettings = await admin.action({ action: 'updateSettings', companyEmail: 'company@verified.test', companyVerified: true, unreviewedSendPolicy: 'pending' });
  assert.equal(updateSettings.response.status, 200);
  const updateAdvisor = await admin.action({ action: 'updateUserEmail', userId: 'advisor-1', email: 'advisor1@verified.test', verified: true });
  assert.equal(updateAdvisor.response.status, 200);

  const refreshed = (await advisor.bootstrap('case-1')).data as Bootstrap;
  const refreshedCurrent = refreshed.reports.find((report) => report.version === refreshed.activeCase?.reportVersion);
  assert.ok(refreshedCurrent);
  assert.notEqual(refreshedCurrent.recipientFingerprint, current.recipientFingerprint);
  const stalePreview = await advisor.action({ action: 'approveSend', caseId: 'case-1', version: refreshedCurrent.version, snapshotId: refreshedCurrent.snapshotId, recipientFingerprint: current.recipientFingerprint });
  assert.equal(stalePreview.response.status, 409);

  const draft = await advisor.action({ action: 'generateReport', caseId: 'case-2' });
  assert.equal(draft.response.status, 200, JSON.stringify(draft.data));
  const case2 = (await advisor.bootstrap('case-2')).data as Bootstrap;
  const draftReport = case2.reports.find((report) => report.version === case2.activeCase?.reportVersion);
  assert.ok(draftReport);
  process.env.MAIL_MODE = 'live';
  const live = await advisor.action({ action: 'approveSend', caseId: 'case-2', version: draftReport.version, snapshotId: draftReport.snapshotId, recipientFingerprint: draftReport.recipientFingerprint });
  process.env.MAIL_MODE = 'dry_run';
  assert.equal(live.response.status, 409);
  assert.match(String(live.data.error), /发送政策|禁止真实投递/);
  assert.equal(((await advisor.bootstrap('case-2')).data as Bootstrap).notifications.length, 0);
});

test('online backup and restore preserve the populated application database byte-for-byte', async () => {
  const { db } = await import('../lib/db');
  const source = db();
  const backupPath = join(databaseRoot, 'populated-backup.sqlite');
  const restoredPath = join(databaseRoot, 'populated-restored.sqlite');
  await backup(source, backupPath);
  const snapshot = new DatabaseSync(backupPath, { readOnly: true });
  try {
    await backup(snapshot, restoredPath);
  } finally {
    snapshot.close();
  }
  const restored = new DatabaseSync(restoredPath, { readOnly: true });
  try {
    for (const table of ['clients', 'cases', 'messages', 'reports', 'notification_jobs']) {
      const sourceCount = Number((source.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number | bigint }).count);
      const restoredCount = Number((restored.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number | bigint }).count);
      assert.equal(restoredCount, sourceCount, table);
      assert.ok(restoredCount > 0, `${table} should contain real app rows`);
    }

    const sourceVersions = source.prepare('SELECT case_id, version, snapshot_id FROM reports ORDER BY case_id, version').all();
    const restoredVersions = restored.prepare('SELECT case_id, version, snapshot_id FROM reports ORDER BY case_id, version').all();
    assert.deepEqual(restoredVersions, sourceVersions);
    assert.ok(sourceVersions.some((row) => Number(row.version) >= 3), 'expected multiple immutable report versions');

    const sourcePdfs = source.prepare('SELECT case_id, version, pdf FROM reports ORDER BY case_id, version').all() as { case_id: string; version: number; pdf: Uint8Array }[];
    const restoredPdfs = restored.prepare('SELECT case_id, version, pdf FROM reports ORDER BY case_id, version').all() as { case_id: string; version: number; pdf: Uint8Array }[];
    assert.equal(restoredPdfs.length, sourcePdfs.length);
    sourcePdfs.forEach((row, index) => {
      assert.equal(restoredPdfs[index].case_id, row.case_id);
      assert.equal(restoredPdfs[index].version, row.version);
      assert.deepEqual(Buffer.from(restoredPdfs[index].pdf), Buffer.from(row.pdf));
      assert.equal(Buffer.from(row.pdf).subarray(0, 4).toString(), '%PDF');
    });
    assert.equal((restored.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
  } finally {
    restored.close();
  }
});

test('same-origin requests use the browser Host when Next normalizes the URL hostname', async () => {
  const browser = new BrowserSession();
  const data = await browser.login('advisor2@aeconn.example');
  const request = (origin: string) => new Request(`${ORIGIN}/api/action`, {
    method: 'POST',
    headers: { cookie: browser.cookie, 'x-csrf-token': browser.csrf, host: '127.0.0.1:3000', origin, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'cancelSend', caseId: data.cases[0].id }),
  });
  assert.equal((await safeAction(request('http://127.0.0.1:3000'))).status, 200);
  assert.equal((await safeAction(request('http://attacker.invalid'))).status, 403);
});

async function drainReportJobs(){
  const {db}=await import('../lib/db');const service=await servicePromise;
  for(let i=0;i<30&&db().prepare("SELECT 1 FROM report_jobs WHERE status='queued'").get();i++)await service.processReportJobs();
  assert.equal(db().prepare("SELECT 1 FROM report_jobs WHERE status='queued'").get(),undefined);
}

test('end persists a report job that completes without a browser request, with immutable PDF and no mail',async()=>{
  await drainReportJobs();
  const advisor=new BrowserSession();await advisor.login('advisor1@verified.test');const caseId=await createCase(advisor,'后台持久队列');
  await advisor.action({action:'enterClient',caseId});await advisor.action({action:'chooseEntry',caseId,entry:'life'});
  await advisor.action({action:'message',caseId,text:'家庭保障',eventId:'background-goal'});
  const ended=await advisor.action({action:'end',caseId});assert.equal(ended.response.status,200);
  let state=(await advisor.bootstrap(caseId)).data as Bootstrap;
  assert.equal(state.mode,'advisor');assert.equal(state.activeCase?.id,caseId);assert.equal(state.reportJob?.status,'queued');assert.equal(state.reports.length,0);
  const {db,pack,unpack}=await import('../lib/db');
  // Simulate a process stopping after claiming the durable job.
  const job=state.reportJob!;db().prepare("UPDATE report_jobs SET status='generating',doc=? WHERE case_id=?").run(pack({...job,status:'generating'}),caseId);
  (await servicePromise).recoverReportJobs();
  assert.equal(unpack<ReportJob>(db().prepare('SELECT doc FROM report_jobs WHERE case_id=?').get(caseId)!.doc).status,'queued');
  await drainReportJobs();
  state=(await advisor.bootstrap(caseId)).data as Bootstrap;
  assert.equal(state.reportJob?.status,'ready');assert.equal(state.reports.length,1);assert.equal(state.notifications.length,0);
  assert.equal((await advisor.report(caseId,1)).status,200);
  await (await servicePromise).processReportJobs();assert.equal(((await advisor.bootstrap(caseId)).data as Bootstrap).reports.length,1);
});

test('real-provider interview and background voice extraction save sourced facts before report analysis (fake HTTP)',async(t)=>{
  await drainReportJobs();
  const keys=['LLM_PROVIDER','OPENAI_API_KEY','OPENAI_MODEL'];const before=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  t.after(()=>{for(const k of keys){if(before[k]===undefined)delete process.env[k];else process.env[k]=before[k];}});
  process.env.LLM_PROVIDER='openai';process.env.OPENAI_API_KEY='synthetic-key';process.env.OPENAI_MODEL='gpt-6-luna';
  const {db,docs}=await import('../lib/db');
  let phase='text';let caseId='';
  t.mock.method(globalThis,'fetch',async(_url:unknown,options:RequestInit)=>{
    const request=JSON.parse(String(options.body));const prompt=request.input[0].content as string;
    let output:unknown;
    const customer=docs<Message>("SELECT doc FROM messages WHERE case_id=? AND role='user' ORDER BY rowid",caseId);
    if(['aeconn_interview','aeconn_extraction'].includes(request.text.format.name)){
      if(phase==='text')output={reply:'哪些家人依赖您的收入？',facts:[{key:'goal',value:'家庭保障',currency:null,period:null,factStatus:'reported_unverified',sourceMessageIds:[customer[0].id]}]};
      else{assert.match(prompt,/conversation is ended/);const voice=customer.find(m=>m.text==='每月收入 5000 美元。')!;output={reply:'访谈已保存。',facts:[{key:'income',value:5000,currency:'USD',period:'month',factStatus:'reported_unverified',sourceMessageIds:[voice.id]}]};}
    }else{
      assert.match(prompt,/SAVED FACTS/);assert.match(prompt,/5000/);assert.doesNotMatch(prompt,/残留草稿/);
      const saved=db().prepare("SELECT doc FROM profile_fields WHERE case_id=? AND field_key='income'").get(caseId);assert.ok(saved,'facts must be durable before report call');
      output={analyses:['life','annuity','ltc','disability_income'].map(category=>({category,status:'insufficient_information',evidenceRefs:[],reasonSummary:'待补充资料。',missingFields:['budget'],constraints:[],nextQuestions:[]}))};
    }
    return new Response(JSON.stringify({usage:{input_tokens:2000,output_tokens:100,total_tokens:2100,input_tokens_details:{cached_tokens:500},output_tokens_details:{reasoning_tokens:0}},status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(output)}]}]}));
  });
  const advisor=new BrowserSession();await advisor.login('advisor1@verified.test');caseId=await createCase(advisor,'云端事实链');
  await advisor.action({action:'enterClient',caseId});await advisor.action({action:'chooseEntry',caseId,entry:'life'});
  const sent=await advisor.action({action:'message',caseId,text:'家庭保障',eventId:'cloud-goal'});assert.equal(sent.response.status,200,JSON.stringify(sent.data));
  assert.equal((await advisor.action({action:'message',caseId,text:'家庭保障',eventId:'cloud-goal'})).response.status,200);
  const client=(await advisor.bootstrap()).data as Bootstrap;const sessionId=client.clientSession!.id;
  assert.match(await (await servicePromise).voiceHooks.getContext(sessionId),/家庭保障/);
  (await servicePromise).voiceHooks.persist(sessionId,{role:'user',text:'每月收入 5000 美元。',eventId:'test:voice:income',turnId:'voice-income',final:true});
  (await servicePromise).voiceHooks.persist(sessionId,{role:'user',text:'残留草稿 999999',eventId:'test:voice:partial',turnId:'voice-partial',final:false});
  (await servicePromise).voiceHooks.status(sessionId,'transcript_incomplete');
  phase='finalize';assert.equal((await advisor.action({action:'end',caseId})).response.status,200);
  (await servicePromise).voiceHooks.persist(sessionId,{role:'user',text:'迟到不应保存',eventId:'late-voice',turnId:'late',final:true});
  await drainReportJobs();const state=(await advisor.bootstrap(caseId)).data as Bootstrap;
  assert.equal(state.reportJob?.status,'ready');assert.equal(state.facts.find(f=>f.key==='income')?.value,5000);assert.equal(state.facts.find(f=>f.key==='income')?.confirmedBy,null);
  assert.equal(state.messages.filter(m=>m.eventId==='cloud-goal').length,1);assert.equal(state.messages.some(m=>m.eventId==='late-voice'),false);
  assert.equal(state.messages.find(m=>m.eventId==='test:voice:partial')?.final,false);assert.equal(state.notifications.length,0);
});

test('cloud failure keeps conversation, fails background job without a mock report, and supports explicit retry',async(t)=>{
  await drainReportJobs();const keys=['LLM_PROVIDER','OPENAI_API_KEY','OPENAI_MODEL'];const before=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  t.after(()=>{for(const k of keys){if(before[k]===undefined)delete process.env[k];else process.env[k]=before[k];}});
  const advisor=new BrowserSession();await advisor.login('advisor1@verified.test');const caseId=await createCase(advisor,'失败重试');
  await advisor.action({action:'enterClient',caseId});await advisor.action({action:'chooseEntry',caseId,entry:'life'});
  process.env.LLM_PROVIDER='openai';process.env.OPENAI_API_KEY='synthetic-key';process.env.OPENAI_MODEL='gpt-6-luna';
  let fail=true;
  t.mock.method(globalThis,'fetch',async(_url:unknown,options:RequestInit)=>{
    if(fail)return new Response('{}',{status:503});
    const request=JSON.parse(String(options.body));const result=['aeconn_interview','aeconn_extraction'].includes(request.text.format.name)?{reply:'访谈已保存。',facts:[]}:{analyses:['life','annuity','ltc','disability_income'].map(category=>({category,status:'insufficient_information',evidenceRefs:[],reasonSummary:'资料不足。',missingFields:['goal'],constraints:[],nextQuestions:[]}))};
    return new Response(JSON.stringify({usage:{input_tokens:2000,output_tokens:100,total_tokens:2100,input_tokens_details:{cached_tokens:500},output_tokens_details:{reasoning_tokens:0}},status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(result)}]}]}));
  });
  assert.equal((await advisor.action({action:'message',caseId,text:'需要更多保障',eventId:'failed-message'})).response.status,503);
  assert.equal(((await advisor.bootstrap()).data as Bootstrap).messages.some(m=>m.eventId==='failed-message'),true);
  await advisor.action({action:'end',caseId});await drainReportJobs();let state=(await advisor.bootstrap(caseId)).data as Bootstrap;
  assert.equal(state.reportJob?.status,'failed');assert.equal(state.reports.length,0);assert.equal(state.notifications.length,0);
  fail=false;const retry=await advisor.action({action:'generateReport',caseId});assert.equal(retry.response.status,200,JSON.stringify(retry.data));
  state=(await advisor.bootstrap(caseId)).data as Bootstrap;assert.equal(state.reportJob?.status,'ready');assert.equal(state.reports.length,1);assert.match(state.reports[0].provider,/openai/);
});

test('repeated unsafe extraction fails report job without facts or reports and returns a stable safe error',async(t)=>{
  await drainReportJobs();
  const keys=['LLM_PROVIDER','OPENAI_API_KEY','OPENAI_MODEL'];const before=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  t.after(()=>{for(const k of keys){if(before[k]===undefined)delete process.env[k];else process.env[k]=before[k];}});
  process.env.LLM_PROVIDER='mock';
  const advisor=new BrowserSession();await advisor.login('advisor1@verified.test');const caseId=await createCase(advisor,'严格提取失败');
  await advisor.action({action:'enterClient',caseId});await advisor.action({action:'chooseEntry',caseId,entry:'life'});
  await advisor.action({action:'message',caseId,text:'家庭保障',eventId:'strict-source'});
  process.env.LLM_PROVIDER='openai';process.env.OPENAI_API_KEY='synthetic-key';process.env.OPENAI_MODEL='gpt-6-luna';
  const network=t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({
    usage:{input_tokens:2000,output_tokens:100,total_tokens:2100,input_tokens_details:{cached_tokens:500},output_tokens_details:{reasoning_tokens:0}},
    status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({reply:'访谈已保存。',facts:[{key:'goal',value:'家庭保障',currency:null,period:null,factStatus:'reported_unverified',sourceMessageIds:['outside-case']}]})}]}],
  })));
  assert.equal((await advisor.action({action:'end',caseId})).response.status,200);
  const factsBefore=((await advisor.bootstrap(caseId)).data as Bootstrap).facts;
  await drainReportJobs();
  let state=(await advisor.bootstrap(caseId)).data as Bootstrap;
  assert.equal(state.reportJob?.status,'failed');
  assert.equal(state.reportJob?.error,'事实提取未通过来源校验，原对话已保存；请核对后重试。');
  assert.deepEqual(state.facts,factsBefore);assert.equal(state.reports.length,0);
  const {db,unpack}=await import('../lib/db');
  const auditRow=db().prepare("SELECT metadata FROM audit_events WHERE case_id=? AND action='report.background_failed' ORDER BY rowid DESC LIMIT 1").get(caseId);
  assert.deepEqual(unpack<Record<string,string>>(auditRow!.metadata),{failureCode:'AI_EXTRACTION_VALIDATION',category:'source_evidence'});

  const manual=await advisor.action({action:'generateReport',caseId});
  assert.equal(manual.response.status,422);
  assert.deepEqual(manual.data,{error:'事实提取未通过来源校验，原对话已保存；请核对后重试。',code:'AI_EXTRACTION_VALIDATION'});
  state=(await advisor.bootstrap(caseId)).data as Bootstrap;
  assert.equal(state.reportJob?.status,'failed');assert.deepEqual(state.facts,factsBefore);assert.equal(state.reports.length,0);
  assert.equal(network.mock.callCount(),4,'background and manual extraction each make at most two metered attempts');
});

test('pause and resume invalidate an in-flight cloud turn instead of resurrecting its late reply',async(t)=>{
  const keys=['LLM_PROVIDER','OPENAI_API_KEY','OPENAI_MODEL'];const before=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  t.after(()=>{for(const k of keys){if(before[k]===undefined)delete process.env[k];else process.env[k]=before[k];}});
  const advisor=new BrowserSession();await advisor.login('advisor1@verified.test');const caseId=await createCase(advisor,'暂停代次');
  await advisor.action({action:'enterClient',caseId});await advisor.action({action:'chooseEntry',caseId,entry:'life'});
  process.env.LLM_PROVIDER='openai';process.env.OPENAI_API_KEY='synthetic-key';process.env.OPENAI_MODEL='gpt-6-luna';
  let resolveRequest!:(value:Response)=>void;let markStarted!:()=>void;const started=new Promise<void>(resolve=>{markStarted=resolve;});
  t.mock.method(globalThis,'fetch',async()=>{markStarted();return await new Promise<Response>(resolve=>{resolveRequest=resolve;});});
  const pending=advisor.action({action:'message',caseId,text:'家庭保障',eventId:'delayed-turn'});await started;
  assert.equal((await advisor.action({action:'pause',caseId})).response.status,200);
  assert.equal((await advisor.action({action:'resume',caseId})).response.status,200);
  resolveRequest(new Response(JSON.stringify({usage:{input_tokens:2000,output_tokens:100,total_tokens:2100,input_tokens_details:{cached_tokens:500},output_tokens_details:{reasoning_tokens:0}},status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({reply:'这条迟到的问题不应出现。',facts:[]})}]}]})));
  assert.equal((await pending).response.status,409);
  const state=(await advisor.bootstrap()).data as Bootstrap;assert.equal(state.messages.some(m=>m.eventId==='delayed-turn:reply'),false);assert.equal(state.messages.filter(m=>m.eventId==='delayed-turn').length,1);
  process.env.LLM_PROVIDER='mock';await advisor.action({action:'end',caseId});await drainReportJobs();
});

test('mock money parsing never changes CAD into CNY or truncates ambiguous magnitudes; manual sources are explicit',async()=>{
  const advisor=new BrowserSession();await advisor.login('advisor1@verified.test');const caseId=await createCase(advisor,'币种来源');
  await advisor.action({action:'enterClient',caseId});await advisor.action({action:'chooseEntry',caseId,entry:'disability_income'});
  await advisor.action({action:'message',caseId,text:'不知道',eventId:'money-goal'});await advisor.action({action:'message',caseId,text:'不愿提供',eventId:'money-job'});
  await advisor.action({action:'message',caseId,text:'5万 USD 每年',eventId:'money-bad'});await advisor.action({action:'message',caseId,text:'5000 加元 每月',eventId:'money-good'});
  await advisor.action({action:'end',caseId});await drainReportJobs();let state=(await advisor.bootstrap(caseId)).data as Bootstrap;
  assert.equal(state.facts.find(f=>f.key==='income')?.value,5000);assert.equal(state.facts.find(f=>f.key==='income')?.currency,'CAD');
  const invalid=await advisor.action({action:'updateFact',caseId,key:'goal',value:'保护家庭',currency:'USD',period:'year',factStatus:'confirmed',reason:'测试不允许非金额单位'});assert.equal(invalid.response.status,400);
  const correction=await advisor.action({action:'updateFact',caseId,key:'goal',value:'保护家庭',factStatus:'confirmed',reason:'顾问核对后的更正'});assert.equal(correction.response.status,200);
  state=(await advisor.bootstrap(caseId)).data as Bootstrap;const corrected=state.facts.find(f=>f.key==='goal')!;const message=state.messages.find(m=>m.id===corrected.sourceMessageIds[0])!;
  assert.equal(message.source,'advisor');assert.equal(message.actorId,'advisor-1');assert.match(state.reports[0].fullText,/顾问更正/);
});

test('usage is scoped to authorized internal cases and budget refusal preserves the conversation',async t=>{
  await drainReportJobs();
  const advisor=new BrowserSession();await advisor.login('advisor1@verified.test');
  const caseId=await createCase(advisor,'预算保护');
  const usage=await import('../lib/ai-usage');
  const held=usage.beginUsage({context:{caseId},model:'gpt-realtime-2.1',operation:'realtime'});
  usage.completeUsage(held.id,'unknown');
  const internal=(await advisor.bootstrap(caseId)).data as Bootstrap;
  assert.equal(internal.usage?.case?.remainingMicros,0);
  assert.equal(internal.usage?.records.length,1);
  assert.equal(internal.usage?.records[0].status,'unknown');
  const another=new BrowserSession();await another.login('advisor2@aeconn.example');
  assert.equal((await another.bootstrap(caseId)).response.status,403);
  const other=(await another.bootstrap()).data as Bootstrap;
  assert.equal(other.usage?.records.some(record=>record.id===held.id),false);
  const admin=new BrowserSession();await admin.login('admin@aeconn.example');
  const administrative=(await admin.bootstrap()).data as Bootstrap;
  assert.equal(administrative.usage?.case,null);assert.deepEqual(administrative.usage?.records,[]);
  await advisor.action({action:'enterClient',caseId});await advisor.action({action:'chooseEntry',caseId,entry:'life'});
  assert.equal(((await advisor.bootstrap()).data as Bootstrap).usage,undefined);
  const keys=['LLM_PROVIDER','OPENAI_API_KEY','OPENAI_MODEL'];const before=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  t.after(()=>{for(const key of keys){if(before[key]===undefined)delete process.env[key];else process.env[key]=before[key];}});
  process.env.LLM_PROVIDER='openai';process.env.OPENAI_API_KEY='synthetic-test';process.env.OPENAI_MODEL='gpt-6-luna';
  const network=t.mock.method(globalThis,'fetch',async()=>{throw new Error('Budget test must not call network');});
  const response=await advisor.action({action:'message',caseId,text:'家庭保障',eventId:'budget-protected-answer'});
  assert.equal(response.response.status,429);
  assert(((await advisor.bootstrap()).data as Bootstrap).messages.some(message=>message.eventId==='budget-protected-answer'));
  await advisor.action({action:'end',caseId});await drainReportJobs();
  const ended=(await advisor.bootstrap(caseId)).data as Bootstrap;
  assert.equal(ended.mode,'advisor');assert.equal(ended.reportJob?.status,'failed');assert.equal(ended.reports.length,0);
  assert.match(ended.reportJob?.error??'',/额度|预算/);
  assert.equal(network.mock.callCount(),0);
  const anonymous=new BrowserSession();assert.equal(((await anonymous.bootstrap()).data as Bootstrap).usage,undefined);
});
