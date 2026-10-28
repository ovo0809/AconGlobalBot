import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message, ProfileField } from '../lib/domain';
import { analyzeWithProvider, buildCloudSafeInput, providerCapabilities, validateProviderAnalyses, validateProviderFacts } from '../lib/providers';

const messages: Message[] = [{ id: 'm1', caseId: 'c1', sessionId: 's1', turnId: 't1', eventId: 'e1', role: 'user', text: '邮箱 alex@example.com，电话 415-555-1212，年收入 80000 美元。', final: true, interrupted: false, createdAt: '2026-01-01' }];
const facts: ProfileField[] = [
  { key: 'annual_income', value: '80000', currency: 'USD', period: 'year', factStatus: 'reported_unverified', sourceMessageIds: ['m1'], confirmedBy: null, confirmedAt: null },
  { key: 'email', value: 'alex@example.com', currency: null, period: null, factStatus: 'confirmed', sourceMessageIds: [], confirmedBy: 'advisor', confirmedAt: '2026-01-01' },
];

test('cloud payload excludes identity fact fields and redacts final user transcript text', () => {
  const safe = buildCloudSafeInput({ messages, facts });
  assert.equal(safe.facts.length, 1);
  assert.equal(safe.facts[0].key, 'annual_income');
  assert.deepEqual(safe.messages[0], { id: 'm1', role: 'user', text: '邮箱 [email removed]，电话 [phone removed]，年收入 80000 美元。' });
});

test('provider extraction keeps facts unconfirmed and requires case-local source IDs', () => {
  const output = { facts: [{ key: 'income', value: 80_000, currency: 'USD', period: 'year', factStatus: 'reported_unverified', sourceMessageIds: ['m1'] }] };
  const extracted = validateProviderFacts(output, { messages, facts });
  assert.equal(extracted[0].confirmedBy, null);
  assert.equal(extracted[0].confirmedAt, null);
  assert.throws(() => validateProviderFacts({ facts: [{ ...output.facts[0], sourceMessageIds: ['other-case'] }] }, { messages, facts }), /outside this case/);
  assert.throws(() => validateProviderFacts({ facts: [{ ...output.facts[0], factStatus: 'confirmed' }] }, { messages, facts }), /status is invalid/);
});

test('provider validation requires four unique categories and case-local evidence', () => {
  const analyses = ['life', 'annuity', 'ltc', 'disability_income'].map((category) => ({
    category,
    status: 'priority_discussion',
    evidenceRefs: ['m1'],
    reasonSummary: '仅供内部讨论。',
    missingFields: [],
    constraints: ['待人工复核'],
    nextQuestions: [],
  }));
  assert.equal(validateProviderAnalyses({ analyses }, { messages, facts }).length, 4);
  analyses[3].evidenceRefs = ['other-case'];
  assert.throws(() => validateProviderAnalyses({ analyses }, { messages, facts }), /outside this case/);
});

test('provider capability is explicit when credentials are absent', () => {
  const beforeKey = process.env.GEMINI_API_KEY;
  const beforeModel = process.env.GEMINI_MODEL;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_MODEL;
  assert.deepEqual(providerCapabilities(), { analysis: 'mock:demo_unapproved', voice: 'not_configured' });
  if (beforeKey) process.env.GEMINI_API_KEY = beforeKey;
  if (beforeModel) process.env.GEMINI_MODEL = beforeModel;
});

test('prototype mock mode ignores available cloud credentials and never makes a model request', async (t) => {
  const keys = ['LLM_PROVIDER', 'VOICE_PROVIDER', 'GEMINI_API_KEY', 'GEMINI_MODEL', 'GEMINI_LIVE_MODEL'] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => { for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } });
  process.env.GEMINI_API_KEY = 'synthetic-unused-key';
  process.env.GEMINI_MODEL = 'synthetic-unused-model';
  process.env.GEMINI_LIVE_MODEL = 'synthetic-unused-live-model';
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Prototype must not call a cloud model'); });
  for (const mode of [undefined, 'mock']) {
    if (mode === undefined) { delete process.env.LLM_PROVIDER; delete process.env.VOICE_PROVIDER; }
    else { process.env.LLM_PROVIDER = mode; process.env.VOICE_PROVIDER = mode; }
    const result = await analyzeWithProvider({ messages: [], facts: [] });
    assert.match(result.provider, /^mock/);
    assert.equal(result.analyses.length, 4);
    assert.deepEqual(providerCapabilities(), { analysis: 'mock:demo_unapproved', voice: 'not_configured' });
  }
  assert.equal(network.mock.callCount(), 0);
});

test('cloud analysis requires an explicit selector and does not enable realtime voice', async (t) => {
  const keys = ['LLM_PROVIDER', 'VOICE_PROVIDER', 'GEMINI_API_KEY', 'GEMINI_MODEL', 'GEMINI_LIVE_MODEL'] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => { for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } });
  process.env.LLM_PROVIDER = 'gemini';
  process.env.VOICE_PROVIDER = 'mock';
  process.env.GEMINI_API_KEY = 'synthetic-cloud-key';
  process.env.GEMINI_MODEL = 'synthetic-cloud-model';
  process.env.GEMINI_LIVE_MODEL = 'synthetic-unused-live-model';
  const analyses = ['life', 'annuity', 'ltc', 'disability_income'].map(category => ({ category, status:'insufficient_information', evidenceRefs:[], reasonSummary:'测试资料不足', missingFields:['goal'], constraints:['待核验'], nextQuestions:['目标是什么？'] }));
  const network = t.mock.method(globalThis, 'fetch', async (_url:unknown, options:RequestInit) => {
    const payload = JSON.parse(String(options.body));
    assert.equal(payload.model, 'synthetic-cloud-model');
    return new Response(JSON.stringify({ steps:[{ type:'model_output', content:[{ type:'text', text:JSON.stringify({facts:[],analyses}) }] }] }));
  });
  const result = await analyzeWithProvider({messages:[],facts:[]});
  assert.equal(result.provider, 'gemini:synthetic-cloud-model');
  assert.equal(network.mock.callCount(), 1);
  assert.equal(providerCapabilities().voice, 'not_configured');
  process.env.LLM_PROVIDER = 'mock';
  process.env.VOICE_PROVIDER = 'gemini';
  assert.deepEqual(providerCapabilities(), { analysis:'mock:demo_unapproved', voice:'configured_not_verified' });
});
