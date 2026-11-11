import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { Client, Message, ProfileField, ReportInput, User } from '../lib/domain';
import { analyzeDemo, buildReport, renderPdf, validateAnalyses, validateFacts, reportClientContext } from '../lib/report';
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

test('coauthoring report saves a local reader check without approving or altering facts', () => {
  const input=reportInput([
    {key:'goal',value:'希望明年安排在家照护',currency:null,period:null,factStatus:'reported_unverified',sourceMessageIds:['editorial-goal'],confirmedBy:null,confirmedAt:null},
    {key:'budget',value:null,currency:null,period:null,factStatus:'declined',sourceMessageIds:['editorial-budget'],confirmedBy:null,confirmedAt:null},
  ]);
  input.incompleteTranscript=true;
  const original=JSON.stringify(input);
  const report=buildReport(input);
  assert.ok(report.editorial,'new report snapshots must save their local reader check');
  assert.equal(report.editorial.method,'local_rules');
  assert.equal(report.editorial.version,'doc-coauthoring/1');
  assert.equal(report.editorial.brief.incompleteTranscript,true);
  assert.deepEqual(report.editorial.brief.declinedFactKeys,['budget']);
  assert.equal(report.editorial.checks.length,5);
  assert.equal(report.reviewStatus,'draft');
  assert.match(report.summary,/希望明年安排在家照护/);
  assert.ok(report.fullText.includes(report.summary),'screen summary must also be saved in PDF/email body');
  assert.equal(JSON.stringify(input),original);
});

test('coauthoring prioritizes the current topic while retaining all original analysis candidates', () => {
  const input=reportInput([]);
  input.caseRecord.entry='ltc';
  input.analyses.forEach(item=>{item.nextQuestions=[`${item.category==='ltc'?'请核对照护安排':item.category+' 合成问题'}？`];});
  const original=JSON.stringify(input.analyses);
  const report=buildReport(input);
  const shown=report.sections[4].body.split('\n').filter(line=>line.startsWith('• '));
  assert.equal(shown.length,3);
  assert.match(shown[0],/请核对照护安排/);
  assert.equal(JSON.stringify(report.analyses),original);
  assert.equal(JSON.stringify(input.analyses),original);
});

test('reader feedback removes known-as-missing contradictions and repeated care questions in demo drafting', () => {
  const fields:ProfileField[]=[
    {key:'goal',value:'希望明年准备长期照护',currency:null,period:null,factStatus:'reported_unverified',sourceMessageIds:['reader-goal'],confirmedBy:null,confirmedAt:null},
    {key:'horizon',value:'明年',currency:null,period:null,factStatus:'reported_unverified',sourceMessageIds:['reader-time'],confirmedBy:null,confirmedAt:null},
    {key:'care',value:'希望在家照护',currency:null,period:null,factStatus:'reported_unverified',sourceMessageIds:['reader-care'],confirmedBy:null,confirmedAt:null},
    {key:'existing_life',value:null,currency:null,period:null,factStatus:'unknown',sourceMessageIds:['reader-life'],confirmedBy:null,confirmedAt:null},
    {key:'existing_ltc',value:null,currency:null,period:null,factStatus:'unknown',sourceMessageIds:['reader-ltc'],confirmedBy:null,confirmedAt:null},
  ];
  const original=JSON.stringify(fields);
  const analyses=analyzeDemo(fields);
  assert.ok(analyses.every(item=>!item.missingFields.includes('goal')&&!item.missingFields.includes('horizon')));
  assert.doesNotMatch(analyses.find(item=>item.category==='ltc')!.nextQuestions.join(' '),/希望在哪里接受照护/);
  assert.match(analyses.find(item=>item.category==='ltc')!.nextQuestions.join(' '),/保单|核对/);
  assert.doesNotMatch(analyses.find(item=>item.category==='life')!.nextQuestions.join(' '),/目前已有何种人寿保障/);
  assert.equal(JSON.stringify(fields),original);
  const declined=fields.map(fact=>fact.key.startsWith('existing_')?{...fact,factStatus:'declined' as const}:fact);
  assert.equal(analyzeDemo(declined).find(item=>item.category==='ltc')!.nextQuestions.length,0,'a declined existing-policy answer does not trigger another request');
});

test('company report separates readable business content from full audit provenance', () => {
  const input = reportInput([{key:'income',value:120000,currency:'USD',period:'year',factStatus:'reported_unverified',sourceMessageIds:['internal-message-uuid'],confirmedBy:null,confirmedAt:null}]);
  input.knowledge = knowledgeContext();
  input.knowledge.sources[0].excerpt = '# 内部资料\n| 表头 |\n<br>不应直接印到正文';
  input.analyses.forEach(item => { item.nextQuestions = ['请核对现有保单。','请补充退休账户资料。','请核对照护安排。','请重复所有收入信息。']; });
  const report = buildReport(input);
  assert.doesNotMatch(report.fullText, /internal-message-uuid|snapshot-immutable-1|client_id|case_id|<br>|\| 表头 \||knowledge\/retirement\.md/);
  assert.match(report.fullText, /120,000 美元／年/);
  assert.match(report.fullText, /来源 1/);
  assert.equal(report.facts[0].sourceMessageIds[0], 'internal-message-uuid');
  assert.equal(report.knowledge?.sources[0].excerpt, input.knowledge.sources[0].excerpt);
  assert.equal(report.sections[4].body.split('\n').filter(line=>line.startsWith('• ')).length, 3);
  assert.equal(report.analyses[0].nextQuestions.length, 4);
});

test('readable report never rounds a nonzero saved amount down to zero',()=>{
  const report=buildReport(reportInput([{key:'income',value:1e-21,currency:'USD',period:'month',factStatus:'reported_unverified',sourceMessageIds:['m1'],confirmedBy:null,confirmedAt:null}]));
  assert.match(report.sections[0].body,/1e-21 美元／月/);
  assert.doesNotMatch(report.sections[0].body,/收入：0 /);
});

test('saved intake age is dated correctly and stays separate from sourced transcript facts',()=>{
  const client={birthday:'1986-06-18',maritalStatus:'已婚',state:'CA'};
  assert.equal(reportClientContext(client,'2026-06-17T12:00:00Z').ageYears,39);
  assert.equal(reportClientContext(client,'2026-06-18T12:00:00Z').ageYears,40);
  const report=buildReport(reportInput([]));
  assert.match(report.sections[0].body,/建档资料：41岁；已婚；CA/);
  assert.match(report.sections[0].body,/来源：顾问建档，非访谈转写/);
  assert.deepEqual(report.facts,[]);
});

test('report validates knowledge citations separately and freezes their exact source snapshot',()=>{
  const input=reportInput([]);input.knowledge=knowledgeContext();input.analyses=analyzeDemo([]).map((item,index)=>({...item,knowledgeRefs:index===0?['knowledge:retirement:1']:[]}));
  const report=buildReport(input);
  assert.equal(report.sections.length,6);
  assert.match(report.sections[2].body,/引用参考资料/);
  assert.match(report.sections[2].body,/不属于客户事实/);
  assert.match(report.sections[2].body,/资料 1：退休访谈参考/);
  assert.equal(report.knowledge?.sources[0].path,'knowledge/retirement.md');
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

test('recording facts retain advisor review and segment provenance in the report', () => {
  const input=reportInput([{key:'goal',value:'明年准备家庭保障',currency:null,period:null,factStatus:'reported_unverified',sourceMessageIds:['recording-message-1'],confirmedBy:null,confirmedAt:null}]);
  input.messages[0]={...input.messages[0],source:'customer',sourceKind:'advisor_reviewed_recording',actorId:'advisor-1',recordingSegmentIds:['segment-1','segment-2']};
  const report=buildReport(input);
  assert.match(report.fullText,/顾问核对的录音客户发言/);
  assert.equal(report.sourceReferences?.[0].actorId,'advisor-1');
  assert.deepEqual(report.sourceReferences?.[0].recordingSegmentIds,['segment-1','segment-2']);
  assert.doesNotMatch(report.fullText,/actor_id=|segment-1/);
  assert.equal(report.facts[0].factStatus,'reported_unverified');
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
  assert.equal(report.clientId,'client-1');
  assert.equal(report.caseId,'case-1');
  assert.equal(report.owner?.email,'advisor1@aeconn.example');
  assert.equal(report.ruleVersion,'demo_unapproved/1.0');
  assert.match(report.fullText, /演示规则，待业务审核/);
  assert.match(report.fullText, /六、给 Charles 的交接摘要与专项审核项/);
  assert.match(report.fullText, /复核状态：草稿/);
  assert.match(report.fullText, /本版本人工复核意见：approved：已核对合成案例引用与缺失项/);
  assert.ok(report.headerLines?.some((line) => line.includes('归属顾问：合成顾问 林')));
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
  assert.match(report.sections[0].body, /尚未提取到有来源的访谈事实，请先核对访谈记录。/);
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
  assert.match(report.sections[0].body, /来源 1 \[客户自述\]/);
  assert.match(report.sections[0].body, /来源 2 \[顾问更正\]/);
  assert.match(report.sections[0].body, /来源 3 \[合成资料\]/);
  assert.equal(report.sourceReferences?.[1].id,'advisor-source');
  assert.equal(report.sourceReferences?.[1].actorId,'advisor-9');
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
  assert.doesNotMatch(report.fullText,/0123456789abcdef0123456789abcdef01234567/);
  assert.equal(report.knowledge?.sources[0].revision,knowledgeRevision);
  assert.match(report.fullText,/第 8–10 行/);
  const plainPdf=await renderPdf(buildReport(reportInput([])));
  const knowledgePdf=await renderPdf(report);
  assert.equal(knowledgePdf.subarray(0,4).toString(),'%PDF');
  assert.ok(knowledgePdf.length>plainPdf.length,`knowledge PDF should preserve extra provenance content: ${knowledgePdf.length} <= ${plainPdf.length}`);
  if(process.env.KNOWLEDGE_PDF_OUTPUT){const output=path.resolve(process.env.KNOWLEDGE_PDF_OUTPUT);fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,knowledgePdf);}
});
