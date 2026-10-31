import { randomBytes, scryptSync } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const SHARED_DEMO_PORT = 3002;
export const SNAPSHOT_ENTRIES = [
  'app',
  'lib',
  'public',
  'server.ts',
  'next.config.ts',
  'next-env.d.ts',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
] as const;

const SYSTEM_ENV_KEYS = [
  'COMSPEC',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'Path',
  'PATH',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'SystemDrive',
  'SystemRoot',
  'TEMP',
  'TMP',
  'WINDIR',
] as const;

export interface SharedDemoCredential {
  email: string;
  password: string;
  role: 'advisor';
}

export interface RotatedAccount {
  email: string;
  password: string;
  role: string;
}

export function createSharedDemoPassword(): string {
  return randomBytes(24).toString('base64url');
}

export function hashSharedDemoPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}

export function createSharedDemoEnvironment(options: {
  databasePath: string;
  publicOrigin?: string;
  bootstrapPassword: string;
  base?: Record<string, string | undefined>;
}): NodeJS.ProcessEnv {
  const source = options.base ?? process.env;
  const safe: Record<string, string | undefined> = {};
  for (const key of SYSTEM_ENV_KEYS) {
    if (source[key]) safe[key] = source[key];
  }
  return {
    ...safe,
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(SHARED_DEMO_PORT),
    DATABASE_PATH: resolve(options.databasePath),
    HTTPS_PROXY_ORIGIN: options.publicOrigin ?? '',
    ALLOW_NETWORK_DEMO: 'false',
    DEMO_PASSWORD: options.bootstrapPassword,
    SHARE_DEMO_MODE: 'mock',
    LLM_PROVIDER: 'mock',
    VOICE_PROVIDER: 'mock',
    RECORDING_PROVIDER: 'mock',
    OPENAI_API_KEY: '',
    GEMINI_API_KEY: '',
    MAIL_MODE: 'dry_run',
    AI_CASE_BUDGET_USD: '8',
    AI_DAILY_BUDGET_USD: '40',
    AI_MONTHLY_BUDGET_USD: '160',
  };
}

export function createSharedDemoSnapshot(sourceRoot: string, snapshotRoot: string): void {
  const source = resolve(sourceRoot);
  const target = resolve(snapshotRoot);
  const relativeTarget = relative(resolve(source, 'output', 'shared-demo'), target);
  if (!relativeTarget || relativeTarget.startsWith('..') || isAbsolute(relativeTarget)) {
    throw new Error('Shared Demo snapshot must be created under output/shared-demo/.');
  }
  mkdirSync(target, { recursive: true });
  for (const entry of SNAPSHOT_ENTRIES) {
    const from = join(source, entry);
    if (!existsSync(from)) {
      if (entry === 'public') continue;
      throw new Error(`Required Shared Demo source is missing: ${entry}`);
    }
    cpSync(from, join(target, entry), { recursive: true, errorOnExist: true, force: false });
  }
  const sourceModules = join(source, 'node_modules');
  if (!existsSync(sourceModules)) throw new Error('Run npm ci before starting the Shared Demo.');
  symlinkSync(sourceModules, join(target, 'node_modules'), 'junction');
}

export function rotateSharedDemoAccounts(databasePath: string): {
  testerCredentials: SharedDemoCredential[];
  allAccounts: RotatedAccount[];
} {
  const database = new DatabaseSync(resolve(databasePath));
  try {
    const rows = database.prepare('SELECT id, email, doc FROM users ORDER BY id').all() as Array<{
      id: string;
      email: string;
      doc: string;
    }>;
    if (!rows.length) throw new Error('Shared Demo database did not seed any users.');
    const allAccounts: RotatedAccount[] = [];
    database.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        const user = JSON.parse(row.doc) as { role?: string };
        const password = createSharedDemoPassword();
        database.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashSharedDemoPassword(password), row.id);
        allAccounts.push({ email: row.email, password, role: String(user.role ?? '') });
      }
      database.exec('DELETE FROM auth_sessions; DELETE FROM voice_tokens;');
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    const testerCredentials = allAccounts
      .filter((account): account is RotatedAccount & { role: 'advisor' } => account.role === 'advisor')
      .map(({ email, password }) => ({ email, password, role: 'advisor' as const }));
    if (testerCredentials.length !== 2) throw new Error('Shared Demo requires exactly two seeded advisor accounts.');
    if (new Set(allAccounts.map((account) => account.password)).size !== allAccounts.length) {
      throw new Error('Every Shared Demo account must have a distinct password.');
    }
    return { testerCredentials, allAccounts };
  } finally {
    database.close();
  }
}

export function writePrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(resolve(path), `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
}

export function writeSharedDemoInvitations(directory:string,publicUrl:string,credentials:SharedDemoCredential[]):void {
  mkdirSync(directory,{recursive:true});
  credentials.forEach((credential,index)=>{
    const content=[`# Aeconn Demo 测试邀请（顾问 ${index+1}）`,'',`打开 [Aeconn 共享模拟 Demo](${publicUrl})`,'',`账号：${credential.email}`,'',`密码：${credential.password}`,'',
      '请只把这份邀请发给对应测试者。两个账号的案例分开；共用同一账号的人会看到相同案例。','',
      '这是模拟测试版，请只输入虚构资料。使用文字完成访谈；真实 AI 和连续语音未启用，邮件只预览。','',
      '建议体验：新建虚构客户 → 开始客户访谈 → 选择入口并文字回答 → 结束 → 查看内部报告和 PDF；也可以测试删除、还原和彻底删除案例。','',
      '邀请人的电脑与共享服务需保持运行和联网。临时服务重启后请使用新邀请。',''].join('\n');
    writeFileSync(join(directory,`测试邀请-顾问${index+1}.md`),content,{encoding:'utf8',mode:0o600});
  });
}

export function assertCredentialFileIsAdvisorOnly(path: string): SharedDemoCredential[] {
  const credentials = JSON.parse(readFileSync(resolve(path), 'utf8')) as SharedDemoCredential[];
  if (credentials.length !== 2 || credentials.some((item) => item.role !== 'advisor')) {
    throw new Error(`${basename(path)} must contain exactly two advisor credentials.`);
  }
  return credentials;
}
