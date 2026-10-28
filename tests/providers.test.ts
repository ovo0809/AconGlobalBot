import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message, ProfileField } from '../lib/domain';
import { buildCloudSafeInput, providerCapabilities, validateProviderAnalyses, validateProviderFacts } from '../lib/providers';

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
