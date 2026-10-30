import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { Client, Message, ProfileField, ReportInput, User } from '../lib/domain';
import { analyzeDemo, buildReport, renderPdf, validateAnalyses, validateFacts } from '../lib/report';
import { formatFactValue } from '../lib/report-labels';
import { scenarios } from '../lib/scenarios';
import type { KnowledgeContext } from '../lib/knowledge';

function messagesFor(facts: ProfileField[], caseId = 'case-1'): Message[] {
  return [...new Set(facts.flatMap((fact) => fact.sourceMessageIds))].map((id, index) => ({
    id,
    caseId,
    sessionId: 'session-1',
    turnId: `turn-${index + 1}`,
    eventId: `event-${index + 1}`,
    role: 'user' as const,
    text: `合成测试陈述 ${index + 1}`,
    final: true,
    interrupted: false,
    createdAt: '2026-10-01T12:00:00.000Z',
    source: 'synthetic' as const,
  }));
}

function reportInput(facts: ProfileField[]): ReportInput {
  const owner: User = { id: 'advisor-1', name: '合成顾问 林', email: 'advisor1@aeconn.example', role: 'advisor', orgId: 'org-1', emailVerified: true };
  const client: Client = {
    id: 'client-1', name: '合成客户 王', birthday: '1985-05-16', gender: '未说明', phone: '+1-555-0100',
    email: 'client@example.invalid', maritalStatus: '已婚', state: 'CA', language: 'zh-CN', ownerAgentId: owner.id,
    consentStatus: 'demo_synthetic', createdAt: '2026-10-01T12:00:00.000Z',
  };
  const messages = messagesFor(facts);
  return {
    client,
    owner,
    caseRecord: { id: 'case-1', clientId: client.id, ownerAgentId: owner.id, status: 'report_ready', entry: 'life', createdAt: '2026-10-01T12:00:00.000Z', updatedAt: '2026-10-01T13:00:00.000Z', assignedReviewerId: 'charles-1', reportVersion: 1 },
    version: 1,
    snapshotId: 'snapshot-immutable-1',
    reviewStatus: 'draft',
    createdAt: '2026-10-01T13:00:00.000Z',
    facts,
    messages,
    analyses: analyzeDemo(facts),
    incompleteTranscript: false,
    provider: 'mock:demo-rules',
    reviewNote: 'approved：已核对合成案例引用与缺失项',
  };
}

const knowledgeRevision='0123456789abcdef0123456789abcdef01234567';
function knowledgeContext():KnowledgeContext{return {revision:knowledgeRevision,status:'ready',notices:['固定到生成时版本。'],sources:[{id:'knowledge:retirement:1',title:'退休访谈参考',path:'knowledge/retirement.md',url:`https://github.com/ovo0809/AconGlobalBot/blob/${knowledgeRevision}/knowledge/retirement.md`,revision:knowledgeRevision,startLine:8,endLine:10,excerpt:'先确认客户目标、时间与流动性约束。',reviewStatus:'reference_only'}]};}

test('report validates knowledge citations separately and freezes their exact source snapshot',()=>{
  const input=reportInput([]);input.knowledge=knowledgeContext();input.analyses=analyzeDemo([]).map((item,index)=>({...item,knowledgeRefs:index===0?['knowledge:retirement:1']:[]}));
  const report=buildReport(input);
  assert.equal(report.sections.length,6);
  assert.match(report.sections[2].body,/检索到的参考资料/);
  assert.match(report.sections[2].body,/不属于客户事实/);
  assert.match(report.sections[2].body,/knowledge\/retirement\.md/);
  assert.match(report.sections[2].body,/未调用 AI/);
  assert.deepEqual(report.facts,[]);
  input.knowledge.sources[0].excerpt='修改后的资料';
  input.analyses[0].knowledgeRefs!.push('篡改');
  assert.equal(report.knowledge?.sources[0].excerpt,'先确认客户目标、时间与流动性约束。');
  assert.deepEqual(report.analyses[0].knowledgeRefs,['knowledge:retirement:1']);
});

test('report rejects knowledge references outside the selected immutable snapshot',()=>{
  const input=reportInput([]);input.knowledge=knowledgeContext();input.analyses=analyzeDemo([]).map((item,index)=>({...item,knowledgeRefs:index===0?['knowledge:missing']:[]}));
  assert.throws(()=>buildReport(input),/参考资料引用不属于本报告快照/);
});

test('legacy reports remain valid without a knowledge snapshot',()=>{
  const report=buildReport(reportInput([]));
  assert.equal(report.knowledge,undefined);
  assert.doesNotMatch(report.fullText,/提供给 AI 的参考资料/);
});

test('empty knowledge and unsupported document notices remain in report and PDF text',()=>{
  const input=reportInput([]);input.knowledge={revision:'',status:'unavailable',sources:[],notices:['PDF 尚未解析，请先转换为文本。']};
  const report=buildReport(input);
  assert.match(report.fullText,/没有可用的相关知识资料片段/);
  assert.match(report.fullText,/PDF 尚未解析/);
});

test('provides at least ten distinct synthetic edge scenarios', () => {
  assert.ok(scenarios.length >= 10);
  assert.equal(new Set(scenarios.map((scenario) => scenario.name)).size, scenarios.length);
  assert.ok(scenarios.some((scenario) => scenario.facts.some((fact) => fact.factStatus === 'conflicting' && fact.sourceMessageIds.length >= 2)));
  assert.ok(scenarios.some((scenario) => scenario.name.includes('injection')));
});

test('demo analysis returns exactly four unique categories and valid case-local evidence', () => {
  for (const scenario of scenarios) {
    const results = analyzeDemo(scenario.facts);
    assert.equal(results.length, 4, scenario.name);
    assert.equal(new Set(results.map((entry) => entry.category)).size, 4, scenario.name);
    validateAnalyses(results, scenario.facts, messagesFor(scenario.facts));
  }
});

test('unknown and declined money stay null rather than becoming zero', () => {
  const scenario = scenarios.find((entry) => entry.name === 'declined-financial-details');
  assert.ok(scenario);
  validateFacts(scenario.facts);
  assert.equal(scenario.facts.find((fact) => fact.key === 'income')?.value, null);
  assert.throws(() => validateFacts([{ ...scenario.facts[1], value: 0 }]), /必须保留为 null/);
});

test('report value labels distinguish unknown, declined, conflicts and ordinary missing values', () => {
  const base = { key: 'budget', currency: null, period: null, sourceMessageIds: [], confirmedBy: null, confirmedAt: null };
  assert.equal(formatFactValue({ ...base, value: null, factStatus: 'unknown' }), '客户表示不清楚');
  assert.equal(formatFactValue({ ...base, value: null, factStatus: 'declined' }), '客户不愿提供');
  assert.equal(formatFactValue({ ...base, value: null, factStatus: 'conflicting' }), '说法存在冲突，待核对');
  assert.equal(formatFactValue({ ...base, value: null, factStatus: 'confirmed' }), '未提供');
  assert.equal(formatFactValue({ ...base, value: 5000, currency: 'USD', period: 'month', factStatus: 'confirmed' }), '5000（USD／每月）');
  assert.equal(formatFactValue({ ...base, value: 1e-21, currency: 'USD', period: 'month', factStatus: 'confirmed' }), '1e-21（USD／每月）');
});

test('conflicting income cannot become a direction until clarified', () => {
  const scenario = scenarios.find((entry) => entry.name === 'conflicting-income-period');
  assert.ok(scenario);
  const result = analyzeDemo(scenario.facts).find((entry) => entry.category === 'disability_income');
  assert.equal(result?.status, 'insufficient_information');
  assert.match(result?.constraints.join(' ') ?? '', /确认金额币种/);
});

test('existing arrangements are reviewed rather than treated as an automatic new recommendation', () => {
  const scenario = scenarios.find((entry) => entry.name === 'review-existing-coverage');
  assert.ok(scenario);
  const results = analyzeDemo(scenario.facts);
  assert.equal(results.find((entry) => entry.category === 'life')?.status, 'review_existing');
  assert.equal(results.find((entry) => entry.category === 'disability_income')?.status, 'review_existing');
});

test('instruction-like client text cannot alter recipients or produce a product recommendation', () => {
  const scenario = scenarios.find((entry) => entry.name === 'instruction-injection-text');
  assert.ok(scenario);
  const results = analyzeDemo(scenario.facts);
  assert.equal(JSON.stringify(results).includes('attacker@example.com'), false);
  assert.equal(JSON.stringify(results).includes('最高收益产品'), false);
});

test('validation rejects non-final and cross-case evidence', () => {
  const scenario = scenarios.find((entry) => entry.name === 'disability-income-gap');
  assert.ok(scenario);
  const results = analyzeDemo(scenario.facts);
  const messages = messagesFor(scenario.facts);
  assert.throws(() => validateAnalyses(results, scenario.facts, messages.map((message, index) => index === 0 ? { ...message, final: false } : message)), /不是最终转写/);
  assert.throws(() => validateAnalyses(results, scenario.facts, messages.map((message, index) => index === 0 ? { ...message, caseId: 'other-case' } : message)), /不同案例/);
});

test('report has immutable identifiers, programmatic contact data and six required sections', () => {
  const scenario = scenarios.find((entry) => entry.name === 'combined-family-needs');
  assert.ok(scenario);
  const report = buildReport(reportInput(scenario.facts));
  assert.equal(report.sections.length, 6);
  assert.match(report.fullText, /client_id：client-1/);
  assert.match(report.fullText, /case_id：case-1/);
  assert.match(report.fullText, /顾问联系邮箱（程序字段）：advisor1@aeconn\.example/);
  assert.match(report.fullText, /demo_unapproved/);
  assert.match(report.fullText, /演示规则，待业务审核/);
  assert.match(report.fullText, /六、给 Charles 的交接摘要与专项审核项/);
  assert.match(report.fullText, /复核状态：草稿/);
  assert.match(report.fullText, /本版本人工复核意见：approved：已核对合成案例引用与缺失项/);
  assert.ok(report.headerLines?.some((line) => line.includes('归属顾问：合成顾问 林 / advisor-1')));
  assert.match(report.sections[0].body, /来源：[^\n]+ \[合成资料\]/);
  assert.doesNotMatch(report.sections[0].body, /\b(?:goal|income|dependents|existing_life)：/);
});

test('report groups repeated missing fields by Chinese label without dropping category constraints', () => {
  const input = reportInput([]);
  input.analyses = [
    { category: 'life', status: 'insufficient_information', evidenceRefs: [], reasonSummary: '资料不足。', missingFields: ['goal'], constraints: ['人寿限制。'], nextQuestions: [] },
    { category: 'annuity', status: 'insufficient_information', evidenceRefs: [], reasonSummary: '资料不足。', missingFields: ['goal'], constraints: ['年金限制。'], nextQuestions: [] },
    { category: 'ltc', status: 'insufficient_information', evidenceRefs: [], reasonSummary: '资料不足。', missingFields: ['care'], constraints: [], nextQuestions: [] },
    { category: 'disability_income', status: 'insufficient_information', evidenceRefs: [], reasonSummary: '资料不足。', missingFields: ['income'], constraints: [], nextQuestions: [] },
  ];
  const report = buildReport(input);
  assert.equal(report.sections[0].body, '尚未提取到有来源的访谈事实，请先核对访谈记录。');
  assert.equal(report.sections[3].body.match(/待补充：主要目标/g)?.length, 1);
  assert.match(report.sections[3].body, /待补充：主要目标（涉及：人寿、年金／退休收入）/);
  assert.match(report.sections[3].body, /人寿：人寿限制。/);
  assert.match(report.sections[3].body, /年金／退休收入：年金限制。/);
});

test('report labels customer, advisor and synthetic fact sources without guessing actor names', () => {
  const facts: ProfileField[] = [
    { key: 'goal', value: '保障家庭', currency: null, period: null, factStatus: 'reported_unverified', sourceMessageIds: ['customer-source'], confirmedBy: null, confirmedAt: null },
    { key: 'income', value: 5000, currency: 'USD', period: 'month', factStatus: 'confirmed', sourceMessageIds: ['advisor-source'], confirmedBy: 'advisor-9', confirmedAt: '2026-10-01T12:00:00.000Z' },
    { key: 'dependents', value: '一名子女', currency: null, period: null, factStatus: 'reported_unverified', sourceMessageIds: ['synthetic-source'], confirmedBy: null, confirmedAt: null },
  ];
  const input = reportInput(facts);
  input.messages = [
    { id: 'customer-source', caseId: 'case-1', sessionId: 'session-1', turnId: 't1', eventId: 'e1', role: 'user', text: '保障家庭', final: true, interrupted: false, createdAt: input.createdAt, source: 'customer' },
    { id: 'advisor-source', caseId: 'case-1', sessionId: 'advisor-correction-case-1', turnId: 't2', eventId: 'e2', role: 'user', text: '顾问事实更正', final: true, interrupted: false, createdAt: input.createdAt, source: 'advisor', actorId: 'advisor-9' },
    { id: 'synthetic-source', caseId: 'case-1', sessionId: 'seed-case-1', turnId: 't3', eventId: 'e3', role: 'user', text: '合成自述', final: true, interrupted: false, createdAt: input.createdAt, source: 'synthetic' },
  ];
  input.analyses = analyzeDemo(facts);
  const report = buildReport(input);
  assert.match(report.sections[0].body, /customer-source \[客户自述\]/);
  assert.match(report.sections[0].body, /advisor-source \[顾问更正；actor_id=advisor-9\]/);
  assert.match(report.sections[0].body, /synthetic-source \[合成资料\]/);
  assert.doesNotMatch(report.sections[0].body, /林顾问|Charles/);
});

test('renders a real, embedded-font PDF with enough content to span pages', async () => {
  const base = scenarios.find((entry) => entry.name === 'combined-family-needs');
  assert.ok(base);
  const input = reportInput(base.facts);
  const report = buildReport(input);
  const pdf = await renderPdf(report);
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
  assert.ok(pdf.length > 50_000, `PDF unexpectedly small: ${pdf.length}`);
  assert.ok(pdf.includes(Buffer.from('NotoSansCJKsc')) || pdf.includes(Buffer.from('NotoSansCJK')));
  if (process.env.REPORT_VALIDATION_OUTPUT) {
    const output = path.resolve(process.env.REPORT_VALIDATION_OUTPUT);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, pdf);
  }
  const longReport = {
    ...report,
    sections: report.sections.map((section) => ({ ...section, body: `${section.body}\n${'用于分页验证的合成说明。'.repeat(120)}` })),
  };
  const longPdf = await renderPdf(longReport);
  assert.ok(longPdf.length > pdf.length);
  assert.match(longPdf.toString('latin1'), /\/Count [2-9][0-9]*/);
});

test('renders saved knowledge provenance into the report PDF',async()=>{
  const input=reportInput([]);input.knowledge=knowledgeContext();input.analyses=analyzeDemo([]).map((item,index)=>({...item,knowledgeRefs:index===0?['knowledge:retirement:1']:[]}));
  const report=buildReport(input);
  assert.match(report.fullText,/退休访谈参考/);
  assert.match(report.fullText,/0123456789abcdef0123456789abcdef01234567/);
  assert.match(report.fullText,/第 8–10 行/);
  const plainPdf=await renderPdf(buildReport(reportInput([])));
  const knowledgePdf=await renderPdf(report);
  assert.equal(knowledgePdf.subarray(0,4).toString(),'%PDF');
  assert.ok(knowledgePdf.length>plainPdf.length,`knowledge PDF should preserve extra provenance content: ${knowledgePdf.length} <= ${plainPdf.length}`);
  if(process.env.KNOWLEDGE_PDF_OUTPUT){const output=path.resolve(process.env.KNOWLEDGE_PDF_OUTPUT);fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,knowledgePdf);}
});
