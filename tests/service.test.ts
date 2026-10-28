import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { Bootstrap, ReportRecord } from '../lib/domain';

const databaseRoot = mkdtempSync(join(tmpdir(), 'aeconn-service-test-'));
process.env.DATABASE_PATH = join(databaseRoot, 'service.sqlite');
process.env.DEMO_PASSWORD = 'AeconnDemo!2026';
process.env.MAIL_MODE = 'dry_run';
delete process.env.LLM_PROVIDER;
delete process.env.GEMINI_API_KEY;
delete process.env.GEMINI_MODEL;
delete process.env.GEMINI_LIVE_MODEL;
delete process.env.VOICE_PROVIDER;

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
