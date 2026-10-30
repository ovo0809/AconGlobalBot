import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { formatKnowledgePrompt, loadKnowledge, validateKnowledgeRefs } from '../lib/knowledge';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'aeconn-knowledge-'));
  const knowledge = join(root, 'knowledge');
  await mkdir(join(knowledge, 'demo_unapproved'), { recursive: true });
  await writeFile(join(knowledge, 'life.md'), '# 家庭责任\n家庭收入依赖与现有保障应分开核对。不要根据单一金额推荐具体产品。\n', 'utf8');
  await writeFile(join(knowledge, 'retirement.txt'), '退休访谈应询问时间、流动性和预期收入来源。\n', 'utf8');
  await writeFile(join(knowledge, 'demo_unapproved', 'sample.md'), 'review_status: demo_unapproved\n合成示例：照护偏好仍需人工复核。\n', 'utf8');
  await writeFile(join(knowledge, 'README.md'), '这个说明不应进入模型。', 'utf8');
  await writeFile(join(knowledge, 'life.source.md'), '来源元数据不应作为正文。', 'utf8');
  await writeFile(join(knowledge, 'brochure.pdf'), 'not a real pdf', 'utf8');
  return { root, knowledge, cache: join(root, 'cache.json') };
}

test('selects only relevant bounded local excerpts with immutable provenance', async () => {
  const { knowledge, cache } = await fixture();
  const result = await loadKnowledge('客户依赖家庭收入，已有保障需要确认', { remote: false, localDirectory: knowledge, cachePath: cache });
  assert.equal(result.status, 'ready');
  assert.ok(result.sources.length > 0 && result.sources.length <= 4);
  assert.equal(result.sources[0].path, 'knowledge/life.md');
  assert.match(result.sources[0].id, /^K_[a-f0-9]{30}$/);
  assert.match(result.sources[0].url, /^knowledge:\/\/local\/knowledge\/life\.md\?revision=[a-f0-9]{64}#L1-L2$/);
  assert.equal(result.sources[0].reviewStatus, 'reference_only');
  assert.ok(Buffer.byteLength(JSON.stringify(result.sources), 'utf8') <= 6_000);
  assert.ok(result.notices.some((notice) => /PDF/.test(notice)));
  assert.ok(result.sources.every((source) => !/README|\.source\./i.test(source.path)));
});

test('bounds the actual JSON source payload when excerpts require escaping', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aeconn-knowledge-json-'));
  const knowledge = join(root, 'knowledge');
  await mkdir(knowledge);
  await writeFile(join(knowledge, 'quoted.md'), `家庭保障\n${'家庭保障 "quoted" \\ slash\n'.repeat(1_500)}`, 'utf8');
  const result = await loadKnowledge('家庭保障', { remote: false, localDirectory: knowledge, cachePath: null });
  assert.equal(result.status, 'ready');
  assert.ok(Buffer.byteLength(JSON.stringify(result.sources), 'utf8') <= 6_000);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(result.sources)));
});

test('does not add arbitrary material when there is no lexical match', async () => {
  const { knowledge, cache } = await fixture();
  const result = await loadKnowledge('量子计算卫星', { remote: false, localDirectory: knowledge, cachePath: cache });
  assert.equal(result.status, 'empty');
  assert.deepEqual(result.sources, []);
});

test('marks synthetic examples and treats all snippets as untrusted references', async () => {
  const { knowledge, cache } = await fixture();
  const result = await loadKnowledge('合成照护偏好', { remote: false, localDirectory: knowledge, cachePath: cache });
  assert.equal(result.sources[0].reviewStatus, 'demo_unapproved');
  const prompt = formatKnowledgePrompt(result);
  assert.match(prompt, new RegExp(result.sources[0].id));
  assert.match(prompt, /untrusted JSON data/i);
  assert.match(prompt, /not a client fact/i);
  assert.match(prompt, /exact source id/i);
  assert.deepEqual(validateKnowledgeRefs([result.sources[0].id, result.sources[0].id], result), [result.sources[0].id]);
  assert.deepEqual(validateKnowledgeRefs(undefined, result), []);
  assert.throws(() => validateKnowledgeRefs(['K_forged'], result), /outside the selected context/);
});

test('excludes symlinks and files that appear to contain credentials', async () => {
  const { root, knowledge, cache } = await fixture();
  await writeFile(join(knowledge, 'secret.txt'), 'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz1234', 'utf8');
  const outside = join(root, 'outside.txt');
  await writeFile(outside, '家庭收入外部文件', 'utf8');
  let linked = true;
  try { await symlink(outside, join(knowledge, 'linked.txt')); } catch { linked = false; }
  const result = await loadKnowledge('家庭收入 secret', { remote: false, localDirectory: knowledge, cachePath: cache });
  assert.ok(result.sources.every((source) => !/secret/.test(source.path)));
  if (linked) assert.ok(result.sources.every((source) => !/linked/.test(source.path)));
  assert.ok(result.notices.some((notice) => /疑似包含密钥/.test(notice)));
});

test('refuses a symlinked knowledge root and bounds diagnostic notices', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aeconn-knowledge-symlink-root-'));
  const real = join(root, 'real');
  const linked = join(root, 'linked');
  await mkdir(real);
  await writeFile(join(real, 'life.md'), '家庭保障', 'utf8');
  let linkedRoot = true;
  try { await symlink(real, linked, 'junction'); } catch { linkedRoot = false; }
  if (linkedRoot) {
    const result = await loadKnowledge('家庭保障', { remote: false, localDirectory: linked, cachePath: null });
    assert.equal(result.status, 'unavailable');
    assert.deepEqual(result.sources, []);
  }

  const noisy = join(root, 'noisy');
  await mkdir(noisy);
  for (let index = 0; index < 12; index += 1) {
    await writeFile(join(noisy, `secret-${index}-${'x'.repeat(90)}.txt`), `sk-proj-${'a'.repeat(30)}`, 'utf8');
  }
  const bounded = await loadKnowledge('secret', { remote: false, localDirectory: noisy, cachePath: null });
  assert.ok(Buffer.byteLength(bounded.notices.join(''), 'utf8') <= 1_500);
});

test('test runtime defaults to local-only retrieval and never contacts GitHub', async () => {
  const { knowledge, cache } = await fixture();
  let requests = 0;
  const result = await loadKnowledge('退休流动性', {
    localDirectory: knowledge, cachePath: cache,
    fetcher: (async () => { requests += 1; throw new Error('network forbidden in tests'); }) as typeof fetch,
  });
  assert.equal(result.status, 'ready');
  assert.equal(requests, 0);
});

test('supports an explicit local source directory environment override', async (t) => {
  const { knowledge, cache } = await fixture();
  const before = process.env.KNOWLEDGE_LOCAL_DIR;
  t.after(() => { if (before === undefined) delete process.env.KNOWLEDGE_LOCAL_DIR; else process.env.KNOWLEDGE_LOCAL_DIR = before; });
  process.env.KNOWLEDGE_LOCAL_DIR = knowledge;
  const result = await loadKnowledge('退休流动性', { remote: false, cachePath: cache });
  assert.equal(result.status, 'ready');
  assert.equal(result.sources[0].path, 'knowledge/retirement.txt');
});

test('rejects a tampered persistent cache instead of passing its content to the model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aeconn-knowledge-cache-'));
  const cache = join(root, 'cache.json');
  const revision = 'b'.repeat(40);
  await writeFile(cache, JSON.stringify({
    revision, fetchedAt: 1, notices: [],
    documents: [{ title: 'forged', path: 'knowledge/forged.md', revision, reviewStatus: 'reference_only',
      url: 'https://attacker.invalid/forged', content: '家庭保障' }],
  }), 'utf8');
  const result = await loadKnowledge('家庭保障', { remote: false, localDirectory: null, cachePath: cache });
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.sources, []);
});

test('uses a stale persisted snapshot after a later GitHub outage', async () => {
  const { root, cache } = await fixture();
  const revision = 'a'.repeat(40);
  let offline = false;
  let requests = 0;
  const fetcher = async (input: string | URL | Request) => {
    requests += 1;
    if (offline) throw new Error('offline');
    const url = String(input);
    if (url.includes('/git/ref/heads/main')) return new Response(JSON.stringify({ object: { type: 'commit', sha: revision } }), { status: 200 });
    if (url.includes('/git/trees/')) return new Response(JSON.stringify({ tree: [{ path: 'knowledge/life.md', type: 'blob', size: 42 }] }), { status: 200 });
    if (url.includes('raw.githubusercontent.com')) return new Response('家庭收入需要核对现有保障。', { status: 200 });
    return new Response('', { status: 404 });
  };
  const first = await loadKnowledge('家庭收入', { remote: true, localDirectory: null, cachePath: cache, cacheTtlMs: 1, now: () => 1, fetcher: fetcher as typeof fetch });
  assert.equal(first.status, 'ready');
  assert.match(first.sources[0].url, new RegExp(`/blob/${revision}/knowledge/life\\.md#L1-L1$`));
  offline = true;
  const second = await loadKnowledge('家庭收入', { remote: true, localDirectory: null, cachePath: cache, cacheTtlMs: 1, now: () => 3, fetcher: fetcher as typeof fetch });
  assert.equal(second.status, 'stale');
  assert.equal(second.revision, revision);
  assert.ok(second.notices.some((notice) => /缓存/.test(notice)));
  assert.equal(second.sources[0].id, first.sources[0].id);
  const third = await loadKnowledge('退休流动性', { remote: true, localDirectory: null, cachePath: cache, cacheTtlMs: 1, now: () => 4, fetcher: fetcher as typeof fetch });
  assert.deepEqual(third.sources, []);
  assert.equal(requests, 4);
  assert.equal(root.length > 0, true);
});

test('streams and cancels oversized GitHub metadata instead of buffering it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aeconn-knowledge-metadata-'));
  const revision = 'c'.repeat(40);
  let cancelled = false;
  const oversized = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array(100_000)); },
    cancel() { cancelled = true; },
  });
  const fetcher = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/git/ref/heads/main')) return new Response(JSON.stringify({ object: { type: 'commit', sha: revision } }));
    return new Response(oversized);
  };
  const result = await loadKnowledge('家庭保障', { remote: true, localDirectory: null, cachePath: join(root, 'cache.json'), fetcher: fetcher as typeof fetch });
  assert.equal(result.status, 'unavailable');
  assert.equal(cancelled, true);
});

test('streams and cancels an oversized knowledge file with a misleading tree size', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aeconn-knowledge-file-'));
  const revision = 'd'.repeat(40);
  let cancelled = false;
  const fetcher = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/git/ref/heads/main')) return new Response(JSON.stringify({ object: { type: 'commit', sha: revision } }));
    if (url.includes('/git/trees/')) return new Response(JSON.stringify({ tree: [{ path: 'knowledge/life.md', type: 'blob', size: 10 }] }));
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(10_000)); },
      cancel() { cancelled = true; },
    }));
  };
  const result = await loadKnowledge('家庭保障', { remote: true, localDirectory: null, cachePath: join(root, 'cache.json'), fetcher: fetcher as typeof fetch });
  assert.equal(result.status, 'unavailable');
  assert.equal(cancelled, true);
});

test('remote mode never falls back to local files or a local cache', async () => {
  const { knowledge, cache } = await fixture();
  const local = await loadKnowledge('家庭收入', { remote: false, localDirectory: knowledge, cachePath: cache });
  assert.equal(local.status, 'ready');
  let requests = 0;
  const fetcher = (async () => { requests += 1; throw new Error('offline'); }) as typeof fetch;
  const options = { remote: true, localDirectory: knowledge, cachePath: cache, fetcher };
  const first = await loadKnowledge('家庭收入', options);
  const second = await loadKnowledge('家庭收入', options);
  assert.equal(first.status, 'unavailable');
  assert.equal(second.status, 'unavailable');
  assert.deepEqual(first.sources, []);
  assert.ok(first.notices.some((notice) => /没有可用的 GitHub 缓存/.test(notice)));
  assert.equal(requests, 1);
});

test('rejects an oversized cache before parsing and bounds local traversal depth', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aeconn-knowledge-bounds-'));
  const cache = join(root, 'cache.json');
  await writeFile(cache, ' '.repeat(700_001), 'utf8');
  const unavailable = await loadKnowledge('家庭保障', { remote: false, localDirectory: null, cachePath: cache });
  assert.equal(unavailable.status, 'unavailable');

  const knowledge = join(root, 'knowledge');
  let directory = knowledge;
  await mkdir(directory);
  for (let index = 0; index < 10; index += 1) { directory = join(directory, `level-${index}`); await mkdir(directory); }
  await writeFile(join(directory, 'deep.md'), '家庭保障深层资料', 'utf8');
  const bounded = await loadKnowledge('家庭保障', { remote: false, localDirectory: knowledge, cachePath: null });
  assert.equal(bounded.status, 'empty');
  assert.deepEqual(bounded.sources, []);
});

test('cold remote retrieval is bounded even when the fetch implementation hangs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aeconn-knowledge-timeout-'));
  const started = Date.now();
  const result = await loadKnowledge('家庭保障', {
    remote: true, localDirectory: null, cachePath: join(root, 'cache.json'),
    fetcher: (() => new Promise<Response>(() => undefined)) as typeof fetch,
  });
  assert.equal(result.status, 'unavailable');
  assert.ok(Date.now() - started < 1_500, `cold retrieval took ${Date.now() - started}ms`);
});
