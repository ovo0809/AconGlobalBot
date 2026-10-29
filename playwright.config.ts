import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 12_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3001',
    browserName: 'chromium',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npx tsx tests/e2e/start.ts',
    url: 'http://127.0.0.1:3001',
    timeout: 120_000,
    reuseExistingServer: false,
    env: {
      HOST: '127.0.0.1',
      PORT: '3001',
      DATABASE_PATH: './tmp/e2e.sqlite',
      DEMO_PASSWORD: 'AeconnDemo!2026',
      MAIL_MODE: 'dry_run',
      LLM_PROVIDER: 'mock',
      VOICE_PROVIDER: 'mock',
      RECORDING_PROVIDER: 'mock',
    },
  },
});
