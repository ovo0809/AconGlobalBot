import assert from 'node:assert/strict';
import test from 'node:test';
import type { AnalysisItem, Category, Message, ProfileField, ReportContent } from '../lib/domain';
import { buildReportWritingBrief, prioritizeReportQuestions, reviewReportDraft } from '../lib/report-editorial';

const fact = (key: string, factStatus: ProfileField['factStatus'], value: string | number | null, sourceMessageIds: string[] = []): ProfileField => ({
  key, value, factStatus, sourceMessageIds, currency: null, period: null, confirmedBy: null, confirmedAt: null,
});

const analysis = (category: Category, status: AnalysisItem['status'], nextQuestions: string[], overrides: Partial<AnalysisItem> = {}): AnalysisItem => ({
  category, status, nextQuestions, evidenceRefs: [], reasonSummary: '', missingFields: [], constraints: [], ...overrides,
});

const source = (id: string, caseId = 'case-1', final = true): Message & {label: string} => ({
  id, caseId, final, label: '来源 1', sessionId: 'session-1', turnId: 'turn-1', eventId: 'event-1',
  role: 'user', text: '不应被编辑检查结果复述的客户原文', interrupted: false, createdAt: '2026-11-01T12:00:00Z',
});

function report(overrides: Partial<Pick<ReportContent, 'caseId' | 'snapshotId' | 'sections' | 'facts' | 'analyses' | 'sourceReferences' | 'reviewStatus'>> = {}) {
  return {
    caseId: 'case-1', snapshotId: 'snapshot-1', reviewStatus: 'draft',
    sections: [
      {title: '一、客户画像', body: '已按保存事实形成客户画像。'},
      {title: '二、四类初步方向', body: '各主题仅作内部讨论。'},
      {title: '三、证据与理由', body: '事实依据见来源 1。'},
      {title: '四、限制与缺失', body: '未知与拒答均按原状态保留。'},
      {title: '五、下次问题', body: '• 请确认希望何时开始？'},
      {title: '六、人工复核', body: '请由顾问与 Charles 复核后决定下一步。'},
    ],
    facts: [fact('goal', 'confirmed', '客户隐私目标', ['m1'])],
    analyses: [analysis('life', 'priority_discussion', ['请确认希望何时开始？'], {evidenceRefs: ['fact:goal']})],
    sourceReferences: [source('m1')],
    ...overrides,
  };
}

test('writing brief groups status keys without copying raw values or mutating facts', () => {
  const facts = [
    fact('goal', 'confirmed', '不能出现在 brief 的客户原话', ['m1']),
    fact('income', 'reported_unverified', 125000, ['m2']),
    fact('budget', 'reported_unverified', null, ['m3']),
    fact('care', 'unknown', null, ['m4']),
    fact('liquidity', 'declined', null, ['m5']),
    fact('debt', 'conflicting', null, ['m6', 'm7']),
  ];
  const before = structuredClone(facts);
  const brief = buildReportWritingBrief(facts, true);

  assert.deepEqual(facts, before);
  assert.deepEqual(brief.knownFactKeys, ['goal', 'income']);
  assert.deepEqual(brief.unknownFactKeys, ['care']);
  assert.deepEqual(brief.declinedFactKeys, ['liquidity']);
  assert.deepEqual(brief.conflictingFactKeys, ['debt']);
  assert.equal(brief.incompleteTranscript, true);
  assert.doesNotMatch(JSON.stringify(brief), /客户原话|125000|m1|m2/);
});

test('question prioritization puts conflicting category before entry and deduplicates punctuation and whitespace', () => {
  const analyses = [
    analysis('life', 'priority_discussion', ['请确认家庭责任？', '共同问题 ?']),
    analysis('annuity', 'defer', ['共同问题？', '请确认退休时间。']),
    analysis('ltc', 'review_existing', ['请核对照护安排？']),
    analysis('disability_income', 'secondary_discussion', ['请核对收入中断安排？']),
  ];
  const facts = [fact('care', 'conflicting', null, ['m1', 'm2'])];
  const before = structuredClone({analyses, facts});
  const questions = prioritizeReportQuestions(analyses, facts, 'annuity');

  assert.deepEqual({analyses, facts}, before);
  assert.deepEqual(questions, [
    '请核对照护安排？',
    '共同问题？',
    '请确认退休时间。',
    '请确认家庭责任？',
    '请核对收入中断安排？',
  ]);
});

test('question deduplication preserves decimal separators between digits', () => {
  const questions = prioritizeReportQuestions([
    analysis('life', 'priority_discussion', ['预算 1.5 美元吗？', '预算15美元吗?', '预算 1.5 美元吗 ?']),
  ], [], 'life');

  assert.deepEqual(questions, ['预算 1.5 美元吗？', '预算15美元吗?']);
});

test('compound candidate questions split into ordered clauses without changing category priority', () => {
  const analyses = [
    analysis('annuity', 'priority_discussion', ['请确认退休时间？']),
    analysis('ltc', 'review_existing', ['先确认照护偏好？再核对照护安排？补充说明']),
  ];
  const before = structuredClone(analyses);
  const questions = prioritizeReportQuestions(analyses, [fact('care', 'conflicting', null)], 'annuity');

  assert.deepEqual(questions, ['先确认照护偏好？', '再核对照护安排？补充说明', '请确认退休时间？']);
  assert.deepEqual(analyses, before);
});

test('unknown and declined are valid facts and do not automatically fail editorial review', () => {
  const facts = [fact('goal', 'unknown', null, ['m1']), fact('budget', 'declined', null, ['m2'])];
  const draft = report({facts, analyses: [], sourceReferences: [source('m1'), {...source('m2'), label: '来源 2'}], reviewStatus: 'approved'});
  const brief = buildReportWritingBrief(facts, false);
  const before = structuredClone({draft, brief});
  const editorial = reviewReportDraft(draft, brief);

  assert.deepEqual({draft, brief}, before);
  assert.equal(editorial.status, 'ready_for_human_review');
  assert.notEqual(editorial.status as string, draft.reviewStatus);
  assert.equal(editorial.checks.length, 5);
  assert.ok(editorial.checks.every((item) => item.status === 'located'));
  assert.match(editorial.checks.find((item) => item.id === 'goal')!.answer, /不清楚|未知/);
  assert.doesNotMatch(JSON.stringify(editorial), /客户隐私|不应被编辑检查结果复述/);
});

test('review flags genuine display defects, question overload and exact known-as-missing contradictions only', () => {
  const facts = [fact('goal', 'confirmed', '隐私目标', ['m1']), fact('retirement', 'confirmed', '隐私退休计划', ['m2'])];
  const draft = report({
    facts,
    analyses: [analysis('annuity', 'priority_discussion', ['同一问题？'], {
      evidenceRefs: ['fact:goal'], missingFields: ['goal', 'retirement_account_balance'],
    })],
    sourceReferences: [source('m1'), {...source('m2'), label: '来源 2'}],
    sections: [
      {title: '一、客户画像', body: 'TODO [object Object] case_id=case-1 \uFFFD'},
      {title: '二、四类初步方向', body: '方向内容。'},
      {title: '三、证据与理由', body: '来源 1。'},
      {title: '四、限制与缺失', body: '仍需核对。'},
      {title: '五、下次问题', body: '• 问题一？\n• 问题一 ?\n• 问题二？\n• 问题三？\n• 问题四？'},
      {title: '六、人工复核', body: '需人工复核。'},
    ],
  });
  const editorial = reviewReportDraft(draft, buildReportWritingBrief(facts, false));
  const codes = editorial.issues.map((item) => item.code);

  assert.equal(editorial.status, 'needs_attention');
  assert.ok(codes.includes('display_artifact'));
  assert.ok(codes.includes('technical_identifier'));
  assert.ok(codes.includes('duplicate_question'));
  assert.ok(codes.includes('too_many_questions'));
  assert.equal(editorial.issues.filter((item) => item.code === 'known_fact_marked_missing').length, 1);
  assert.match(editorial.issues.find((item) => item.code === 'known_fact_marked_missing')!.message, /年金.*主要目标/);
  assert.doesNotMatch(editorial.issues.find((item) => item.code === 'known_fact_marked_missing')!.message, /retirement_account_balance/);
  assert.doesNotMatch(editorial.issues.map((item) => item.message).join(' '), /case-1|snapshot-1|m1|m2/);
});

test('review distinguishes missing, cross-case and non-final provenance including confirmed manual fact references', () => {
  const facts = [
    fact('goal', 'confirmed', '隐私目标', ['missing-message']),
    fact('income', 'reported_unverified', 1, ['cross-case']),
    fact('care', 'unknown', null, ['non-final']),
    fact('budget', 'reported_unverified', 2, ['assistant-message']),
  ];
  const draft = report({
    facts,
    analyses: [analysis('life', 'review_existing', [], {evidenceRefs: ['fact:goal', 'fact:income', 'analysis-missing']})],
    sourceReferences: [
      source('cross-case', 'case-2'),
      source('non-final', 'case-1', false),
      {...source('assistant-message'), role: 'assistant'},
    ],
  });
  const editorial = reviewReportDraft(draft, buildReportWritingBrief(facts, false));
  const codes = new Set(editorial.issues.map((item) => item.code));

  assert.ok(codes.has('missing_source_reference'));
  assert.ok(codes.has('cross_case_source_reference'));
  assert.ok(codes.has('non_final_source_reference'));
  assert.ok(codes.has('non_customer_source_reference'));
  assert.ok(codes.has('invalid_manual_fact_reference'));
  assert.equal(editorial.status, 'needs_attention');
  assert.equal(editorial.checks.find((item) => item.id === 'evidence')!.status, 'needs_attention');
  assert.match(editorial.checks.find((item) => item.id === 'evidence')!.answer, /来源.*需要人工处理/);
});

test('reported facts require provenance while a reviewer-confirmed manual fact reference is valid', () => {
  const reported = fact('income', 'reported_unverified', 1, []);
  const confirmed = {...fact('goal', 'confirmed', '隐私目标', []), confirmedBy: 'reviewer-1'};
  const draft = report({
    facts: [reported, confirmed],
    analyses: [analysis('life', 'priority_discussion', [], {evidenceRefs: ['fact:goal']})],
    sourceReferences: [],
  });
  const editorial = reviewReportDraft(draft, buildReportWritingBrief(draft.facts, false));

  assert.equal(editorial.issues.filter((item) => item.code === 'missing_source_reference').length, 1);
  assert.equal(editorial.issues.some((item) => item.code === 'invalid_manual_fact_reference'), false);
  assert.equal(editorial.checks.find((item) => item.id === 'evidence')!.status, 'needs_attention');
});

test('controlled no-question placeholder reports zero and is not treated as a visible question', () => {
  const draft = report({sections: [
    {title: '一、客户画像', body: '已按保存事实形成客户画像。'},
    {title: '二、四类初步方向', body: '各主题仅作内部讨论。'},
    {title: '三、证据与理由', body: '事实依据见来源 1。'},
    {title: '四、限制与缺失', body: '当前没有额外限制。'},
    {title: '五、下次问题', body: '• 无'},
    {title: '六、人工复核', body: '请由顾问与 Charles 复核后决定下一步。'},
  ]});
  const editorial = reviewReportDraft(draft, buildReportWritingBrief(draft.facts, false));

  assert.match(editorial.checks.find((item) => item.id === 'next_action')!.answer, /0 个/);
  assert.equal(editorial.issues.some((item) => item.code === 'duplicate_question' || item.code === 'too_many_questions'), false);
});

test('one bullet containing four interrogative clauses exceeds the reviewer question limit', () => {
  const draft = report({sections: [
    {title: '一、客户画像', body: '已按保存事实形成客户画像。'},
    {title: '二、四类初步方向', body: '各主题仅作内部讨论。'},
    {title: '三、证据与理由', body: '事实依据见来源 1。'},
    {title: '四、限制与缺失', body: '当前没有额外限制。'},
    {title: '五、下次问题', body: '• 问题一？问题二？问题三？问题四？'},
    {title: '六、人工复核', body: '请由顾问与 Charles 复核后决定下一步。'},
  ]});
  const editorial = reviewReportDraft(draft, buildReportWritingBrief(draft.facts, false));

  assert.match(editorial.checks.find((item) => item.id === 'next_action')!.answer, /4 个/);
  assert.equal(editorial.issues.some((item) => item.code === 'too_many_questions'), true);
});
