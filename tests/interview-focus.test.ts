import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message, ProfileField } from '../lib/domain';
import { buildInterviewContext, INTERVIEW_QUESTIONS, interviewControlReply, mockInterviewControlReply, nextInterviewTurn, parseGroundedAnswer, validateInterviewTurn, type InterviewInput } from '../lib/interview';

function message(id: string, role: Message['role'], text: string, sessionId = 'current'): Message {
  return { id, caseId: 'case', sessionId, turnId: id, eventId: id, role, text, final: true, interrupted: false, createdAt: '2026-10-30T12:00:00Z' };
}
function input(messages: Message[] = [], facts: ProfileField[] = []): InterviewInput {
  return { entry: 'ltc', knownClient: { state: 'CA' }, caseRecord: { id: 'case' }, sessionId: 'current', messages, facts };
}
function known(key: string, source: string, value: string | null = null): ProfileField {
  return { key, value, currency: null, period: null, factStatus: value === null ? 'unknown' : 'reported_unverified', sourceMessageIds: [source], confirmedBy: null, confirmedAt: null };
}

test('focused LTC intake does not force all 17 fields and finishes when its core is covered', () => {
  const keys = ['goal', 'care', 'existing_ltc', 'budget', 'horizon'];
  const fresh = buildInterviewContext(input());
  assert.deepEqual(fresh.missingPriorityItems.map(item => item.key), keys);
  const messages = keys.map(key => message(key, 'user', '不知道'));
  const complete = input(messages, keys.map(key => known(key, key)));
  assert.equal(nextInterviewTurn(complete).reason, 'complete');
  assert.equal(buildInterviewContext(complete).conversationPlan.phase, 'summarize');
  assert.equal(complete.facts.length, 5); // No fabricated unknown records for the other fields.
});

test('a single grounded answer can cover several topics without re-questioning them', () => {
  const answer = message('answer', 'user', '我想安排长期照护。家人可以协助。我没有长期照护保险。');
  const data = input([answer]);
  const turn = validateInterviewTurn({ reply: '您愿意为这件事留出多少预算？', facts: [
    ['goal', '安排长期照护'], ['care', '家人可以协助'], ['existing_ltc', '没有长期照护保险'],
  ].map(([key, value]) => ({ key, value, currency: null, period: null, factStatus: 'reported_unverified', sourceMessageIds: ['answer'] })) }, data);
  assert.deepEqual(buildInterviewContext({ ...data, facts: turn.facts }).missingPriorityItems.map(item => item.key), ['budget', 'horizon']);
});

test('two unanswered attempts defer the topic without inventing an unknown fact or exposing field keys', () => {
  const data = input([message('q1', 'assistant', INTERVIEW_QUESTIONS.goal), message('q2', 'assistant', INTERVIEW_QUESTIONS.goal)]);
  const context = buildInterviewContext(data);
  assert(context.conversationPlan.deferredTopics.includes('goal'));
  assert.equal(nextInterviewTurn(data).targetKey, 'care');
  assert.equal(data.facts.length, 0);
  const retry = nextInterviewTurn(input([message('q1', 'assistant', INTERVIEW_QUESTIONS.goal)]));
  assert.doesNotMatch(retry.reply, /goal|可能没有听清/);
});

test('bounded intake reaches a stopping point even when previous natural questions were not template matches', () => {
  const messages = Array.from({ length: 10 }, (_, i) => message(`q${i}`, 'assistant', `您刚才提到的安排，第 ${i} 点可以再说说吗？`));
  const context = buildInterviewContext(input(messages));
  assert.equal(context.conversationPlan.phase, 'summarize');
  assert.equal(nextInterviewTurn(input(messages)).targetKey, null);
  assert.match(nextInterviewTurn(input(messages)).reply, /待核对/);
});

test('prior interviews do not spend the current session question allowance', () => {
  const messages = Array.from({ length: 12 }, (_, i) => message(`old${i}`, 'assistant', '您希望怎么安排？', 'old'));
  const context = buildInterviewContext(input(messages));
  assert.equal(context.conversationPlan.questionTurns, 0);
  assert.equal(context.conversationPlan.phase, 'explore');
  assert.equal(nextInterviewTurn(input(messages)).targetKey, 'goal');
});

test('relevant contradictions are clarified in human language, never silently cleared at the question limit', () => {
  const sources = [message('a', 'user', '预算 500 美元 每月'), message('b', 'user', '预算 800 美元 每月')];
  const conflict: ProfileField = { ...known('budget', 'a'), factStatus: 'conflicting', sourceMessageIds: ['a', 'b'] };
  const data = input(sources, [conflict]);
  assert.equal(nextInterviewTurn(data).targetKey, 'budget');
  assert.match(nextInterviewTurn(data).reply, /预算/);
  assert.doesNotMatch(nextInterviewTurn(data).reply, /budget/);
  const messages = [...sources, ...Array.from({ length: 10 }, (_, i) => message(`q${i}`, 'assistant', '再说说您的想法？'))];
  assert.equal(nextInterviewTurn(input(messages, [conflict])).reason, 'complete');
  assert.equal(conflict.factStatus, 'conflicting');
  assert.deepEqual(conflict.sourceMessageIds, ['a', 'b']);
});

test('mock conversation controls answer the customer without inventing a financial fact', () => {
  assert.match(mockInterviewControlReply(input([message('stop', 'user', '先到这里。')])) ?? '', /点击.*结束对话/);
  assert.match(mockInterviewControlReply(input([message('count', 'user', '还有多少问题？')])) ?? '', /最多还有 5 个/);
  assert.match(mockInterviewControlReply(input([message('thanks', 'user', '谢谢')])) ?? '', /不客气/);
  assert.equal(mockInterviewControlReply(input([message('goal', 'user', '我想明年准备退休')])), null);
  assert.equal(mockInterviewControlReply(input([message('old-stop', 'user', '先到这里', 'old')])), null);
});

test('local help controls explain only the current question and offer the existing advisor handback', () => {
  const currentIncome = input([
    message('income-question', 'assistant', INTERVIEW_QUESTIONS.income),
    message('why-income', 'user', '为什么要问收入？'),
  ]);
  const explanation = interviewControlReply(currentIncome) ?? '';
  assert.match(explanation, /收入/);
  assert.match(explanation, /顾问/);
  assert.doesNotMatch(explanation, /[？?]/);

  const naturalExplanation = interviewControlReply(input([
    message('income-question', 'assistant', INTERVIEW_QUESTIONS.income),
    message('why-my-income', 'user', '为什么要问我的收入？'),
  ])) ?? '';
  assert.match(naturalExplanation, /收入/);
  assert.doesNotMatch(naturalExplanation, /[？?]/);

  const mismatchedTopic = interviewControlReply(input([
    message('income-question', 'assistant', INTERVIEW_QUESTIONS.income),
    message('why-debt', 'user', '为什么要问债务？'),
  ])) ?? '';
  assert.match(mismatchedTopic, /与您目标相关/);
  assert.doesNotMatch(mismatchedTopic, /收入|债务|[？?]/);

  const oldIncome = input([
    message('old-income-question', 'assistant', INTERVIEW_QUESTIONS.income, 'old'),
    message('why-current', 'user', '为什么问这个？'),
  ]);
  const generic = interviewControlReply(oldIncome) ?? '';
  assert.match(generic, /与您目标相关/);
  assert.doesNotMatch(generic, /收入|[？?]/);

  const handback = interviewControlReply(input([message('advisor', 'user', '我想找顾问')])) ?? '';
  assert.match(handback, /点击.*结束对话/);
  assert.match(handback, /交还顾问/);
  assert.doesNotMatch(handback, /回拨|报告|[？?]/);

  assert.equal(interviewControlReply(input([
    message('income-question', 'assistant', INTERVIEW_QUESTIONS.income),
    message('mixed', 'user', '为什么要问我的收入，我每月收入是 5000 USD'),
  ])), null);
  assert.equal(interviewControlReply(input([
    message('draft-help', 'user', '我想找顾问'),
  ].map(item => item.id === 'draft-help' ? { ...item, final: false } : item))), null);
  assert.equal(interviewControlReply(input([message('old-help', 'user', '我想找顾问', 'old')])), null);
  assert.equal(mockInterviewControlReply(currentIncome), explanation, 'legacy export remains behaviorally compatible');
});

test('pure local controls cannot become transcript memory or extracted facts', () => {
  const handback = message('handback-control', 'user', '我想找顾问');
  const data = input([handback]);
  const context = buildInterviewContext(data);
  assert.equal(context.transcriptMemory.some(item => item.key === 'goal'), false);
  assert.equal(context.answeredTopics.includes('goal'), false);
  assert(context.missingPriorityItems.some(item => item.key === 'goal'));
  assert.equal(parseGroundedAnswer('goal', handback.text, handback.id), null);
  assert.throws(() => validateInterviewTurn({
    reply: '好的。',
    facts: [{ key: 'goal', value: handback.text, currency: null, period: null, factStatus: 'reported_unverified', sourceMessageIds: [handback.id] }],
  }, data), /source|final|user|case/i);

  const mixed = '我想找顾问，不过我每月收入是 5000 USD';
  const parsed = parseGroundedAnswer('income', mixed, 'mixed-financial-answer');
  assert.equal(parsed?.value, 5000);
  assert.equal(parsed?.currency, 'USD');
  assert.equal(parsed?.period, 'month');
});

test('the generated clarification counts as the second attempt and defers an unclear amount', () => {
  const messages = [message('q1', 'assistant', INTERVIEW_QUESTIONS.budget), message('unclear', 'user', '五千左右')];
  const facts = ['goal', 'care', 'existing_ltc'].map(key => known(key, 'unclear'));
  const data = input(messages, facts);
  const clarification = nextInterviewTurn(data);
  assert.equal(clarification.targetKey, 'budget');
  data.messages.push(message('q2', 'assistant', clarification.reply), message('still-unclear', 'user', '刚才说的'));
  assert.equal(nextInterviewTurn(data).targetKey, 'horizon');
  assert(!data.facts.some(fact => fact.key === 'budget'));
});

test('after eight questions only an identified clarification can extend the intake', () => {
  const questions = Array.from({ length: 8 }, (_, i) => message(`q${i}`, 'assistant', '可以说说您的想法吗？'));
  assert.equal(nextInterviewTurn(input(questions)).reason, 'complete');
  const sources = [message('a', 'user', '预算 500 美元 每月'), message('b', 'user', '预算 800 美元 每月')];
  const conflict: ProfileField = { ...known('budget', 'a'), factStatus: 'conflicting', sourceMessageIds: ['a', 'b'] };
  const context = buildInterviewContext(input([...sources, ...questions], [conflict]));
  assert.deepEqual(context.missingPriorityItems.map(item => item.key), ['budget']);
  assert.equal(nextInterviewTurn(input([...sources, ...questions], [conflict])).reason, 'clarify');
});

test('explicit undecided answers remain sourced unknowns instead of another mandatory amount question', () => {
  for (const text of ['暂时没定', '还没决定', '还没有决定', '尚未确定', '暫時沒定', '還沒有決定']) {
    const answer = message('budget', 'user', text);
    const data = input([answer]);
    const parsed = parseGroundedAnswer('budget', text, answer.id);
    assert.equal(parsed?.factStatus, 'unknown');
    assert.equal(parsed?.value, null);
    const turn = validateInterviewTurn({ reply: '预算可以留到之后确定。', facts: [{ key: 'budget', value: null, currency: null, period: null, factStatus: 'unknown', sourceMessageIds: [answer.id] }] }, data);
    assert(!buildInterviewContext({ ...data, facts: turn.facts }).missingPriorityItems.some(item => item.key === 'budget'));
  }
});
