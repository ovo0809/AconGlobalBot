import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  SNAPSHOT_ENTRIES,
  createSharedDemoEnvironment,
  createSharedDemoSnapshot,
  rotateSharedDemoAccounts,
  writePrivateJson,
} from '../scripts/shared-demo-runtime';

test('shared demo environment is hard-pinned to mock providers and contains no inherited cloud secret', () => {
  const env = createSharedDemoEnvironment({
    databasePath: 'output/shared-demo/test/data.sqlite',
    publicOrigin: 'https://safe-name.trycloudflare.com',
    bootstrapPassword: 'a-unique-bootstrap-password',
    base: { Path: 'C:\\Windows', OPENAI_API_KEY: 'must-not-leak', GEMINI_API_KEY: 'must-not-leak' },
  });
  assert.equal(env.LLM_PROVIDER, 'mock');
  assert.equal(env.VOICE_PROVIDER, 'mock');
  assert.equal(env.RECORDING_PROVIDER, 'mock');
  assert.equal(env.OPENAI_API_KEY, '');
  assert.equal(env.GEMINI_API_KEY, '');
  assert.equal(env.MAIL_MODE, 'dry_run');
  assert.equal(env.AI_CASE_BUDGET_USD, '8');
  assert.equal(env.AI_DAILY_BUDGET_USD, '40');
  assert.equal(env.AI_MONTHLY_BUDGET_USD, '160');
  assert.equal(env.HOST, '127.0.0.1');
  assert.equal(env.PORT, '3002');
});

test('snapshot allowlist excludes local databases, env files, git metadata, logs and build output', () => {
  for (const forbidden of ['data', '.env', '.env.local', '.git', '.next', 'output', 'tmp']) {
    assert.equal(SNAPSHOT_ENTRIES.includes(forbidden as never), false, forbidden);
  }
  assert.equal(SNAPSHOT_ENTRIES.includes('app'), true);
  assert.equal(SNAPSHOT_ENTRIES.includes('lib'), true);
  assert.equal(SNAPSHOT_ENTRIES.includes('server.ts'), true);

  const source = mkdtempSync(join(tmpdir(), 'aeconn-shared-source-'));
  for (const entry of SNAPSHOT_ENTRIES) {
    const target = join(source, entry);
    if (['app', 'lib', 'public'].includes(entry)) {
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, 'fixture.txt'), entry);
    } else {
      writeFileSync(target, entry);
    }
  }
  mkdirSync(join(source, 'node_modules'));
  mkdirSync(join(source, 'data'));
  writeFileSync(join(source, 'data', 'private.sqlite'), 'private');
  writeFileSync(join(source, '.env.local'), 'OPENAI_API_KEY=secret');
  mkdirSync(join(source, '.git'));
  const snapshot = join(source, 'output', 'shared-demo', 'test-run', 'app');
  createSharedDemoSnapshot(source, snapshot);
  assert.equal(existsSync(join(snapshot, 'app', 'fixture.txt')), true);
  assert.equal(existsSync(join(snapshot, 'node_modules')), true);
  assert.equal(existsSync(join(snapshot, 'data')), false);
  assert.equal(existsSync(join(snapshot, '.env.local')), false);
  assert.equal(existsSync(join(snapshot, '.git')), false);
});

test('every seeded account gets a distinct password while credential file exposes advisors only', () => {
  const root = mkdtempSync(join(tmpdir(), 'aeconn-shared-demo-'));
  const databasePath = join(root, 'demo.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec('CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, password_hash TEXT, doc TEXT); CREATE TABLE auth_sessions (id TEXT); CREATE TABLE voice_tokens (token_hash TEXT);');
  const users = [
    ['advisor-1', 'advisor1@aeconn.example', 'advisor'],
    ['advisor-2', 'advisor2@aeconn.example', 'advisor'],
    ['reviewer-1', 'charles@aeconn.example', 'reviewer'],
    ['admin-1', 'admin@aeconn.example', 'admin'],
  ];
  for (const [id, email, role] of users) database.prepare('INSERT INTO users VALUES(?,?,?,?)').run(id, email, 'old-hash', JSON.stringify({ role }));
  database.close();

  const rotated = rotateSharedDemoAccounts(databasePath);
  assert.equal(rotated.allAccounts.length, 4);
  assert.equal(new Set(rotated.allAccounts.map((item) => item.password)).size, 4);
  assert.ok(rotated.allAccounts.every((item) => item.password.length >= 16));
  assert.deepEqual(rotated.testerCredentials.map((item) => item.email).sort(), ['advisor1@aeconn.example', 'advisor2@aeconn.example']);
  const rotatedDatabase = new DatabaseSync(databasePath, { readOnly: true });
  const hashes = rotatedDatabase.prepare('SELECT password_hash FROM users ORDER BY id').all() as Array<{ password_hash: string }>;
  rotatedDatabase.close();
  assert.equal(new Set(hashes.map((item) => item.password_hash)).size, 4);
  assert.ok(hashes.every((item) => item.password_hash !== 'old-hash'));

  const credentialsPath = join(root, 'tester-credentials.json');
  writePrivateJson(credentialsPath, rotated.testerCredentials);
  const file = readFileSync(credentialsPath, 'utf8');
  assert.doesNotMatch(file, /charles@|admin@/);
  assert.doesNotMatch(file, new RegExp(rotated.allAccounts.find((item) => item.role === 'reviewer')!.password));
  assert.doesNotMatch(file, new RegExp(rotated.allAccounts.find((item) => item.role === 'admin')!.password));
});
