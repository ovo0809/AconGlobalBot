import assert from 'node:assert/strict';
import test from 'node:test';
import type { Category, Message, ProfileField } from '../lib/domain';
import {
  buildInterviewContext,
  INTERVIEW_QUESTIONS,
  INTERVIEW_SCHEMA,
  interviewSystemPrompt,
  nextInterviewTurn,
  parseGroundedAnswer,
  validateInterviewTurn,
  type InterviewInput,
} from '../lib/interview';

function message(id: string, role: Message['role'], text: string, options: { final?: boolean; caseId?: string; source?: 'customer' | 'advisor' | 'synthetic'; actorId?: string; sessionId?: string } = {}): Message {
  return {
    id,
    caseId: options.caseId ?? 'case-1',
    sessionId: options.sessionId ?? 'session-1',
    turnId: `turn-${id}`,
    eventId: `event-${id}`,
    role,
    text,
    final: options.final ?? true,
    interrupted: false,
    createdAt: '2026-10-01T12:00:00.000Z',
    source: options.source,
    actorId: options.actorId,
  };
}

function fact(key: string, value: string | number | null, factStatus: ProfileField['factStatus'], sources: string[], currency: string | null = null, period: string | null = null): ProfileField {
  return { key, value, currency, period, factStatus, sourceMessageIds: sources, confirmedBy: factStatus === 'confirmed' ? 'advisor-1' : null, confirmedAt: factStatus === 'confirmed' ? '2026-10-01T12:00:00.000Z' : null };
}

function input(entry: Category, facts: ProfileField[], messages: Message[]): InterviewInput {
  return { entry, facts, messages, caseRecord: { id: 'case-1' } };
}

test('structured context keeps only final case messages, redacts contact data and does not repeat known or declined topics', () => {
  const messages = [
    message('assistant-goal', 'assistant', INTERVIEW_QUESTIONS.goal),
    message('goal-source', 'user', '我的目标是保障家庭责任，邮箱 test@example.com，电话 +1 202 555 0199'),
    message('dependents-source', 'user', '这个问题我不愿提供'),
    message('draft', 'user', '临时字幕不能进入上下文', { final: false }),
  ];
  const context = buildInterviewContext(input('life', [
    fact('goal', '保障家庭责任', 'reported_unverified', ['goal-source']),
    fact('dependents', null, 'declined', ['dependents-source']),
  ], messages));
  assert.deepEqual(context.askedTopics, ['goal']);
  assert.deepEqual(context.answeredTopics, ['goal', 'dependents']);
  assert.equal(context.transcript.some((row) => row.id === 'draft'), false);
  assert.match(context.transcript.find((row) => row.id === 'goal-source')?.text ?? '', /\[email removed\]/);
  assert.match(context.transcript.find((row) => row.id === 'goal-source')?.text ?? '', /\[phone removed\]/);
  assert.equal(context.missingPriorityItems.some((item) => item.key === 'goal' || item.key === 'dependents'), false);
  assert.equal(context.missingPriorityItems[0].key, 'existing_life');
});

test('read-only client record state prevents repeat questions without becoming an extracted fact', () => {
  const withClientState = buildInterviewContext({
    ...input('life', [], []),
    knownClient: { state: 'CA', language: '普通话' },
  });
  assert.deepEqual(withClientState.clientRecord, { state: 'CA', language: '普通话' });
  assert.equal(withClientState.missingPriorityItems.some((item) => item.key === 'state'), false);
  assert.equal(withClientState.knownFacts.some((item) => item.key === 'state'), false);
  assert.equal(withClientState.transcript.length, 0);

  const unknownClientState = buildInterviewContext({
    ...input('life', [], []),
    knownClient: { state: '未知', language: 'English' },
  });
  assert.equal(unknownClientState.clientRecord.state, null);
  assert.equal(unknownClientState.missingPriorityItems.some((item) => item.key === 'state'), true);

  const conflictSourceOne = message('state-1', 'user', '我住在 CA');
  const conflictSourceTwo = message('state-2', 'user', '我现在住在 WA');
  const factWins = buildInterviewContext({
    ...input('life', [fact('state', null, 'conflicting', ['state-1', 'state-2'])], [conflictSourceOne, conflictSourceTwo]),
    knownClient: { state: 'CA', language: '普通话' },
  });
  assert.equal(factWins.missingPriorityItems.find((item) => item.key === 'state')?.kind, 'clarify');
  assert.equal(factWins.knownFacts.find((item) => item.key === 'state')?.factStatus, 'conflicting');
});

test('deterministic turn prioritizes contradictions, naturally rephrases unheard questions, then completes', () => {
  const conflictingMessages = [message('income-1', 'user', '我的收入是 5000 USD 每月'), message('income-2', 'user', '更正一下，是 7000 USD 每月')];
  const conflictInput = input('disability_income', [fact('income', null, 'conflicting', ['income-1', 'income-2'])], conflictingMessages);
  const conflict = nextInterviewTurn(conflictInput);
  assert.equal(conflict.targetKey, 'income');
  assert.equal(conflict.reason, 'clarify');
  assert.match(conflict.reply, /前后不一致/);

  const unheard = nextInterviewTurn(input('life', [], [message('assistant-goal', 'assistant', INTERVIEW_QUESTIONS.goal)]));
  assert.equal(unheard.targetKey, 'goal');
  assert.equal(unheard.reason, 'clarify');
  assert.match(unheard.reply, /可能没有听清/);

  const completeFacts = Object.keys(INTERVIEW_QUESTIONS).map((key, index) => fact(key, null, index % 2 ? 'unknown' : 'declined', [`source-${key}`]));
  const completeMessages = completeFacts.map((item) => message(item.sourceMessageIds[0], 'user', item.factStatus === 'unknown' ? '不知道' : '不愿提供'));
  const complete = nextInterviewTurn(input('annuity', completeFacts, completeMessages));
  assert.equal(complete.targetKey, null);
  assert.equal(complete.reason, 'complete');
});

test('system prompt and exported schema define one safe shared text/live contract', () => {
  const prompt = interviewSystemPrompt(input('ltc', [], []));
  assert.match(prompt, /单个客户访谈助手/);
  assert.match(prompt, /不得报价/);
  assert.match(prompt, /模型提取的事实绝不能标 confirmed/);
  assert.deepEqual(INTERVIEW_SCHEMA.required, ['reply', 'facts']);
  assert.equal(INTERVIEW_SCHEMA.additionalProperties, false);
  assert.deepEqual(INTERVIEW_SCHEMA.properties.facts.items.properties.factStatus.enum, ['reported_unverified', 'unknown', 'declined', 'conflicting']);
});

test('validates exact string, amount, unknown and declined facts from final user messages', () => {
  const messages = [
    message('goal', 'user', '我的目标是保障家庭责任'),
    message('income', 'user', '我的收入大约是 5,000 USD 每月'),
    message('unknown', 'user', '这个我不知道'),
    message('declined', 'user', '我不愿提供这项信息'),
  ];
  const turn = validateInterviewTurn({
    reply: '谢谢。您目前有哪些收入中断或伤残保障？',
    facts: [
      { key: 'goal', value: '保障家庭责任', currency: null, period: null, factStatus: 'reported_unverified', sourceMessageIds: ['goal'] },
      { key: 'income', value: 5000, currency: 'USD', period: 'month', factStatus: 'reported_unverified', sourceMessageIds: ['income'] },
      { key: 'care', value: null, currency: null, period: null, factStatus: 'unknown', sourceMessageIds: ['unknown'] },
      { key: 'budget', value: null, currency: null, period: null, factStatus: 'declined', sourceMessageIds: ['declined'] },
    ],
  }, input('disability_income', [], messages));
  assert.equal(turn.facts.length, 4);
  assert.equal(turn.facts.find((item) => item.key === 'income')?.confirmedBy, null);
  assert.equal(turn.facts.find((item) => item.key === 'unknown'), undefined);
  assert.equal(turn.facts.find((item) => item.key === 'care')?.value, null);
});

test('recognizes explicit Chinese monthly and annual amount periods', () => {
  for (const [id, text, period] of [
    ['annual-income', '年收入 80000 美元', 'year'],
    ['annual-period', '年度收入 90000 USD', 'year'],
    ['monthly-income', '月收入 5000 加元', 'month'],
    ['monthly-period', '月度支出 3000 欧元', 'month'],
  ] as const) {
    const source = message(id, 'user', text);
    const currency = text.includes('加元') ? 'CAD' : text.includes('欧元') ? 'EUR' : 'USD';
    const value = Number(text.match(/\d+/)?.[0]);
    const turn = validateInterviewTurn({
      reply: '谢谢。请继续说明下一项资料。',
      facts: [{ key: id === 'monthly-period' ? 'expenses' : 'income', value, currency, period, factStatus: 'reported_unverified', sourceMessageIds: [id] }],
    }, input('disability_income', [], [source]));
    assert.equal(turn.facts[0].period, period);
  }
});

test('deterministic grounded parser accepts only exact unambiguous source text', () => {
  assert.deepEqual(parseGroundedAnswer('income', '月收入 5,000 加元', 'm-cad'), fact('income', 5000, 'reported_unverified', ['m-cad'], 'CAD', 'month'));
  assert.deepEqual(parseGroundedAnswer('income', '年收入 80000 美元', 'm-usd'), fact('income', 80000, 'reported_unverified', ['m-usd'], 'USD', 'year'));
  assert.equal(parseGroundedAnswer('income', '收入 5万 USD 每年', 'm-magnitude'), null);
  assert.equal(parseGroundedAnswer('income', '收入 1e5 USD 每年', 'm-scientific'), null);
  assert.equal(parseGroundedAnswer('income', '工资 5000 USD 每月，奖金 2000 USD 每月', 'm-multiple'), null);
  assert.equal(parseGroundedAnswer('income', '收入 5000 USD，每月或每年', 'm-periods'), null);
  assert.deepEqual(parseGroundedAnswer('goal', '保障家庭责任', 'm-goal'), fact('goal', '保障家庭责任', 'reported_unverified', ['m-goal']));
  assert.deepEqual(parseGroundedAnswer('goal', '不知道', 'm-unknown'), fact('goal', null, 'unknown', ['m-unknown']));
});

test('advisor corrections remain known context but are excluded from transcript extraction sources', () => {
  const advisor = message('advisor-correction', 'user', '顾问事实更正：收入=5000 USD 每月', { source: 'advisor', actorId: 'advisor-1', sessionId: 'advisor-correction-case-1' });
  const synthetic = message('synthetic-source', 'user', '合成自述：目标是退休准备', { source: 'synthetic', sessionId: 'seed-case-1' });
  const known = fact('income', 5000, 'confirmed', ['advisor-correction'], 'USD', 'month');
  const context = buildInterviewContext(input('disability_income', [known], [advisor, synthetic]));
  assert.equal(context.knownFacts[0].sourceKind, 'advisor');
  assert.equal(context.transcript.some((row) => row.id === 'advisor-correction'), false);
  assert.equal(context.transcript.some((row) => row.id === 'synthetic-source'), true);
  assert.throws(() => validateInterviewTurn({
    reply: '谢谢。请继续说明下一项资料。',
    facts: [{ key: 'goal', value: '顾问事实更正', currency: null, period: null, factStatus: 'reported_unverified', sourceMessageIds: ['advisor-correction'] }],
  }, input('disability_income', [known], [advisor, synthetic])), /non-final, non-user, or out-of-case/);
  const accepted = validateInterviewTurn({
    reply: '谢谢。请继续说明下一项资料。',
    facts: [{ key: 'goal', value: '退休准备', currency: null, period: null, factStatus: 'reported_unverified', sourceMessageIds: ['synthetic-source'] }],
  }, input('disability_income', [known], [advisor, synthetic]));
  assert.equal(accepted.facts[0].value, '退休准备');
});

test('preserves both sides of a conflict and permits only a new explicit clarification to resolve it', () => {
  const messages = [
    message('income-1', 'user', '我的收入是 5000 USD 每月'),
    message('income-2', 'user', '不对，我的收入是 7000 USD 每月'),
    message('income-3', 'user', '我确认收入是 6000 USD 每月'),
  ];
  const existing = fact('income', 5000, 'reported_unverified', ['income-1'], 'USD', 'month');
  const conflict = validateInterviewTurn({
    reply: '我听到两个不同金额，请确认您的收入金额。',
    facts: [{ key: 'income', value: null, currency: null, period: null, factStatus: 'conflicting', sourceMessageIds: ['income-1', 'income-2'] }],
  }, input('disability_income', [existing], messages));
  assert.equal(conflict.facts[0].factStatus, 'conflicting');
  assert.deepEqual(conflict.facts[0].sourceMessageIds, ['income-1', 'income-2']);

  const unresolved = fact('income', null, 'conflicting', ['income-1', 'income-2']);
  assert.throws(() => validateInterviewTurn({
    reply: '请确认收入金额。',
    facts: [{ key: 'income', value: 7000, currency: 'USD', period: 'month', factStatus: 'reported_unverified', sourceMessageIds: ['income-2'] }],
  }, input('disability_income', [unresolved], messages)), /new final user clarification/);
  const resolved = validateInterviewTurn({
    reply: '谢谢，已记录您的澄清。下一项，您目前有哪些收入中断保障？',
    facts: [{ key: 'income', value: 6000, currency: 'USD', period: 'month', factStatus: 'reported_unverified', sourceMessageIds: ['income-3'] }],
  }, input('disability_income', [unresolved], messages));
  assert.equal(resolved.facts[0].value, 6000);
  assert.equal(resolved.facts[0].factStatus, 'reported_unverified');
});

test('rejects fabricated values, unit changes, confirmed output, invalid sources and known-fact overwrites', () => {
  const final = message('income', 'user', '我的收入是 5000 USD 每月');
  const draft = message('draft', 'user', '收入是 9000 USD 每月', { final: false });
  const base = input('disability_income', [], [final, draft]);
  const validReply = '谢谢。您目前有哪些收入中断保障？';
  assert.throws(() => validateInterviewTurn({ reply: validReply, facts: [{ key: 'income', value: 6000, currency: 'USD', period: 'month', factStatus: 'reported_unverified', sourceMessageIds: ['income'] }] }, base), /not present verbatim/);
  assert.throws(() => validateInterviewTurn({ reply: validReply, facts: [{ key: 'income', value: 5000, currency: 'USD', period: 'year', factStatus: 'reported_unverified', sourceMessageIds: ['income'] }] }, base), /exactly one plain numeric value/);
  assert.throws(() => validateInterviewTurn({ reply: validReply, facts: [{ key: 'income', value: 5000, currency: 'USD', period: 'month', factStatus: 'confirmed', sourceMessageIds: ['income'] }] }, base), /status is invalid/);
  assert.throws(() => validateInterviewTurn({ reply: validReply, facts: [{ key: 'income', value: 9000, currency: 'USD', period: 'month', factStatus: 'reported_unverified', sourceMessageIds: ['draft'] }] }, base), /non-final/);
  const known = fact('income', 5000, 'confirmed', ['income'], 'USD', 'month');
  const duplicate = validateInterviewTurn({ reply: validReply, facts: [{ key: 'income', value: 5000, currency: 'USD', period: 'month', factStatus: 'reported_unverified', sourceMessageIds: ['income'] }] }, input('disability_income', [known], [final]));
  assert.deepEqual(duplicate.facts, []);
  assert.throws(() => validateInterviewTurn({ reply: validReply, facts: [{ key: 'income', value: 4000, currency: 'USD', period: 'month', factStatus: 'reported_unverified', sourceMessageIds: ['income'] }] }, input('disability_income', [known], [final])), /cannot overwrite|not present verbatim/);
});

test('amount evidence is conservative for Chinese currencies, magnitude words, scientific notation and ambiguous contexts', () => {
  const validReply = '谢谢。下一项，您的家庭支出大约是多少？';
  const cases: Array<{ text: string; value: number; currency: string; period: string; error: RegExp }> = [
    { text: '我的收入是 5000 美元 每月', value: 5000, currency: 'CNY', period: 'month', error: /exactly one plain numeric value/ },
    { text: '我的收入是 5000 欧元 每月', value: 5000, currency: 'CNY', period: 'month', error: /exactly one plain numeric value/ },
    { text: '我的收入是 5000 加元 每月', value: 5000, currency: 'CNY', period: 'month', error: /exactly one plain numeric value/ },
    { text: '我的收入大约 5000 万元 每年', value: 5000, currency: 'CNY', period: 'year', error: /not present verbatim|exactly one plain numeric value/ },
    { text: '我的收入是 5e3 USD 每月', value: 5, currency: 'USD', period: 'month', error: /not present verbatim|exactly one plain numeric value/ },
    { text: '工资 5000 USD 每月，奖金 2000 USD 每月', value: 5000, currency: 'USD', period: 'month', error: /not present verbatim|exactly one plain numeric value/ },
    { text: '金额是 5000 美元或欧元 每月', value: 5000, currency: 'USD', period: 'month', error: /exactly one plain numeric value/ },
    { text: '金额是 5000 USD，每月或每年', value: 5000, currency: 'USD', period: 'month', error: /exactly one plain numeric value/ },
  ];
  for (const [index, item] of cases.entries()) {
    const source = message(`ambiguous-${index}`, 'user', item.text);
    assert.throws(() => validateInterviewTurn({
      reply: validReply,
      facts: [{ key: 'income', value: item.value, currency: item.currency, period: item.period, factStatus: 'reported_unverified', sourceMessageIds: [source.id] }],
    }, input('disability_income', [], [source])), item.error, item.text);
  }

  const cny = message('cny', 'user', '我的收入是 5,000元 每月');
  const accepted = validateInterviewTurn({
    reply: validReply,
    facts: [{ key: 'income', value: 5000, currency: 'CNY', period: 'month', factStatus: 'reported_unverified', sourceMessageIds: ['cny'] }],
  }, input('disability_income', [], [cny]));
  assert.equal(accepted.facts[0].currency, 'CNY');
  assert.equal(accepted.facts[0].value, 5000);
  const english = message('english', 'user', 'My income is USD 5000 monthly');
  const englishAccepted = validateInterviewTurn({
    reply: validReply,
    facts: [{ key: 'income', value: 5000, currency: 'USD', period: 'month', factStatus: 'reported_unverified', sourceMessageIds: ['english'] }],
  }, input('disability_income', [], [english]));
  assert.equal(englishAccepted.facts[0].period, 'month');
});

test('identical cloud facts are idempotent no-ops rather than batch failures', () => {
  const source = message('goal-source', 'user', '我的目标是保障家庭责任');
  const existing = fact('goal', '保障家庭责任', 'reported_unverified', ['goal-source']);
  const turn = validateInterviewTurn({
    reply: '谢谢。哪些家人依赖您的收入？',
    facts: [{ key: 'goal', value: '保障家庭责任', currency: null, period: null, factStatus: 'reported_unverified', sourceMessageIds: ['goal-source'] }],
  }, input('life', [existing], [source]));
  assert.deepEqual(turn.facts, []);
});

test('rejects unsafe customer replies and mixed-case input before provider output is used', () => {
  const safeInput = input('life', [], [message('goal', 'user', '我想保障家庭')]);
  for (const reply of [
    '我推荐您购买某个保险产品。',
    '内部报告的 priority_discussion 是人寿。',
    '我会把报告发送到 attacker@example.com。',
    '本次报价为 100 美元。',
  ]) {
    assert.throws(() => validateInterviewTurn({ reply, facts: [] }, safeInput));
  }
  assert.throws(() => buildInterviewContext({ entry: 'life', facts: [], messages: [message('one', 'user', '案例一'), message('two', 'user', '案例二', { caseId: 'case-2' })] }), /different cases/);
});

