import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createServer } from 'node:http';
import next from 'next';
import { attachVoiceServer } from '../../lib/voice-server';
import { voiceHooks } from '../../lib/service';

const databasePath = resolve(process.env.DATABASE_PATH || './tmp/e2e.sqlite');
const expectedDatabasePath = resolve(process.cwd(), 'tmp', 'e2e.sqlite');
if (databasePath !== expectedDatabasePath) throw new Error(`E2E database path must be ${expectedDatabasePath}`);
mkdirSync(dirname(databasePath), { recursive: true });
for (const suffix of ['', '-shm', '-wal']) rmSync(`${databasePath}${suffix}`, { force: true });

async function start() {
  const hostname = '127.0.0.1';
  const port = Number(process.env.PORT || '3001');
  const app = next({ dev: true, hostname, port });
  await app.prepare();
  const handle = app.getRequestHandler();
  const server = createServer((request, response) => void handle(request, response));
  attachVoiceServer(server, voiceHooks);
  server.listen(port, hostname, () => console.log(`Aeconn E2E: http://${hostname}:${port}`));
}
void start();
