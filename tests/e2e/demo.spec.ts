import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

test.describe.configure({ mode: 'serial' });
const screenshots = join(process.cwd(), 'docs', 'screenshots');
const clientName = `合成验收客户-${Date.now().toString().slice(-6)}`;

async function login(page: Page, email: string) {
  await page.goto('/');
  await page.getByLabel('工作邮箱').fill(email);
  await page.getByLabel('密码').fill('AeconnDemo!2026');
  await page.getByRole('button', { name: '登录工作台' }).click();
  await expect(page.getByRole('button', { name: '退出' })).toBeVisible();
}

async function logout(page: Page) {
  await page.getByRole('button', { name: '退出' }).click();
  await expect(page.getByRole('button', { name: '登录工作台' })).toBeVisible();
}

async function hideDevelopmentChrome(page: Page) {
  await page.evaluate(() => document.querySelectorAll('nextjs-portal').forEach(element => element.remove()));
}

test('顾问建档、受限访谈、报告与 dry-run 通知完整流程', async ({ page }) => {
  mkdirSync(screenshots, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, 'advisor1@aeconn.example');
  await expect(page.getByText('合成数据', { exact: true }).first()).toBeVisible();
  await hideDevelopmentChrome(page);
  await page.screenshot({ path: join(screenshots, 'advisor-desktop-1440x900.png') });

  await page.getByRole('button', { name: '新建客户' }).click();
  const dialog = page.getByRole('dialog', { name: '建立客户档案' });
  await dialog.getByLabel('姓名 *').fill(clientName);
  await dialog.getByLabel('生日 *').fill('1986-06-18');
  await dialog.getByLabel('性别 *').selectOption({ label: '女性' });
  await dialog.getByLabel('电话号码 *').fill('+1 415 555 0199');
  await dialog.getByLabel('邮箱 *').fill(`synthetic-${Date.now()}@example.com`);
  await dialog.getByLabel('婚姻状态 *').selectOption({ label: '已婚' });
  await dialog.getByRole('button', { name: '建立档案与案例' }).click();
  await expect(page.getByRole('heading', { name: clientName })).toBeVisible();

  const mirror = await page.context().newPage();
  await mirror.goto('/');
  await expect(mirror.locator('.case-sidebar')).toBeVisible();

  await page.getByRole('button', { name: '开始客户访谈' }).click();
  await expect(page.getByText('受限客户模式')).toBeVisible();
  await expect(page.locator('.case-sidebar')).toHaveCount(0);
  await expect(page.locator('.report-view')).toHaveCount(0);
  await expect(page.getByText('company@aeconn.example')).toHaveCount(0);
  await expect(mirror.getByText('受限客户模式')).toBeVisible();
  await expect(mirror.locator('.case-sidebar')).toHaveCount(0);

  const restricted = await page.evaluate(async () => {
    const bootstrap = await fetch('/api/bootstrap?caseId=made-up', { cache: 'no-store' }).then(response => response.json());
    const report = await fetch('/api/report?caseId=made-up&version=1&format=pdf');
    return { mode: bootstrap.mode, user: bootstrap.user, clients: bootstrap.clients.length, facts: bootstrap.facts.length, reports: bootstrap.reports.length, reportStatus: report.status };
  });
  expect(restricted).toEqual({ mode: 'client', user: null, clients: 0, facts: 0, reports: 0, reportStatus: 403 });

  await page.getByRole('button', { name: /人寿/ }).click();
  await expect(page.getByText('您最希望解决什么问题？大约计划什么时候开始？')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await hideDevelopmentChrome(page);
  await page.screenshot({ path: join(screenshots, 'client-mobile-390x844.png') });

  await page.getByLabel('文字回答').fill('希望十年内为家人准备保障，并规划退休。');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('哪些家人依赖您的收入？如果收入停止，家庭有哪些责任？')).toBeVisible();
  await page.getByRole('button', { name: '暂停访谈' }).click();
  await expect(page.getByText('访谈已暂停', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('访谈已暂停', { exact: true })).toBeVisible();
  await expect(page.locator('.case-sidebar')).toHaveCount(0);
  await page.getByRole('button', { name: '恢复访谈' }).click();
  await expect(page.getByText('访谈已暂停', { exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: '结束对话' }).click();
  await expect(page.getByRole('heading', { name: '请将手机交还给顾问' })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole('heading', { name: '访谈记录' })).toBeVisible({ timeout: 30_000 });
  await expect(mirror.locator('.case-sidebar')).toBeVisible({ timeout: 30_000 });
  await mirror.close();
  await expect(page.locator('.report-view')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /内部报告 v1/ })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: /内部报告/ }).click();
  await expect(page.getByText('演示规则，待业务审核')).toBeVisible();
  await expect(page.getByRole('link', { name: '预览 PDF' })).toHaveAttribute('href', /format=pdf/);
  await page.getByRole('button', { name: '提交 Charles 复核' }).click();
  await page.getByRole('button', { name: '通知预览' }).click();
  await expect(page.getByText('当前仅预览，不会实际发送')).toBeVisible();
  await page.getByRole('button', { name: '确认发送（仅预览）' }).click();
  await expect(page.getByText('company@aeconn.example')).toBeVisible();
  await expect(page.getByText('dry_run').first()).toBeVisible();
});

test('Charles 复核与管理员配置保持角色边界', async ({ page }) => {
  await login(page, 'charles@aeconn.example');
  await expect(page.getByRole('heading', { name: clientName })).toBeVisible();
  await page.getByRole('button', { name: /内部报告/ }).click();
  await page.getByLabel('复核理由／备注').fill('已核对事实来源与缺失项，允许进入人工后续流程。');
  await page.getByRole('button', { name: '确认复核' }).click();
  await expect(page.getByText('复核已完成')).toBeVisible();
  await logout(page);

  await login(page, 'admin@aeconn.example');
  await expect(page.getByRole('heading', { name: '账户与发送策略' })).toBeVisible();
  await expect(page.getByText('管理员无业务资料权限')).toBeVisible();
  await expect(page.getByText(clientName)).toHaveCount(0);
  await page.getByLabel('未复核草稿发送策略').selectOption('reviewed_only');
  await page.getByRole('button', { name: '保存配置' }).click();
  await expect(page.getByLabel('未复核草稿发送策略')).toHaveValue('reviewed_only');
});

test('多标签页进入客户模式后同步清除已缓存的内部报告', async ({ page, context }) => {
  await login(page, 'advisor1@aeconn.example');
  await page.getByRole('button', { name: /内部报告/ }).click();
  await expect(page.getByText('演示规则，待业务审核')).toBeVisible();

  const secondTab = await context.newPage();
  await secondTab.goto('/');
  await secondTab.getByRole('button', { name: /内部报告/ }).click();
  await expect(secondTab.getByText('演示规则，待业务审核')).toBeVisible();

  await page.getByRole('button', { name: '新案例' }).click();
  await expect(page.locator('.workspace-header .status')).toHaveText('尚未访谈');
  await page.getByRole('button', { name: '开始客户访谈' }).click();
  await expect(page.getByText('受限客户模式')).toBeVisible();
  await expect(secondTab.getByText('受限客户模式')).toBeVisible();
  await expect(secondTab.getByText('演示规则，待业务审核')).toHaveCount(0);
  await expect(secondTab.locator('.report-view')).toHaveCount(0);

  await page.getByRole('button', { name: /人寿/ }).click();
  await page.getByRole('button', { name: '结束对话' }).click();
  await expect(page.getByRole('heading', { name: '访谈记录' })).toBeVisible({ timeout: 30_000 });
  await expect(secondTab.locator('.case-sidebar')).toBeVisible({ timeout: 30_000 });
  await secondTab.reload();
  await expect(secondTab.locator('.report-view')).toHaveCount(0);
  await secondTab.close();
});
