import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const clientName = `Mike-${Date.now().toString().slice(-6)}`;

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('工作邮箱').fill('advisor1@aeconn.example');
  await page.getByLabel('密码').fill('AeconnDemo!2026');
  await page.getByRole('button', { name: '登录工作台' }).click();
  await expect(page.getByRole('button', { name: '退出' })).toBeVisible();
}

async function createClient(page: Page) {
  await page.getByRole('button', { name: '新建客户' }).click();
  const dialog = page.getByRole('dialog', { name: '建立客户档案' });
  await dialog.getByLabel('姓名 *').fill(clientName);
  await dialog.getByLabel('生日 *').fill('1988-03-12');
  await dialog.getByLabel('性别 *').selectOption({ label: '男性' });
  await dialog.getByLabel('电话号码 *').fill('+1 415 555 0128');
  await dialog.getByLabel('邮箱 *').fill(`${clientName.toLowerCase()}@example.com`);
  await dialog.getByLabel('婚姻状态 *').selectOption({ label: '已婚' });
  await dialog.getByRole('button', { name: '建立档案与案例' }).click();
  await expect(page.getByRole('heading', { name: clientName, exact: true })).toBeVisible();
}

test('同一客户案例递增编号，取消与确认软删除保持正确选择', async ({ page }) => {
  const paidApiRequests: string[] = [];
  page.on('request', request => {
    if (/api\.openai\.com|generativelanguage\.googleapis\.com/.test(request.url())) paidApiRequests.push(request.url());
  });

  await login(page);
  await expect(page.getByText('合成数据', { exact: true }).first()).toBeVisible();
  await createClient(page);

  await page.getByRole('button', { name: '新案例', exact: true }).click();
  await expect(page.getByRole('heading', { name: `${clientName}（1）`, exact: true })).toBeVisible();
  await page.getByRole('button', { name: '新案例', exact: true }).click();
  const thirdCaseName = `${clientName}（2）`;
  await expect(page.getByRole('heading', { name: thirdCaseName, exact: true })).toBeVisible();

  const caseList = page.locator('.case-list');
  await expect(caseList.getByText(clientName, { exact: true })).toBeVisible();
  await expect(caseList.getByText(`${clientName}（1）`, { exact: true })).toBeVisible();
  await expect(caseList.getByText(thirdCaseName, { exact: true })).toBeVisible();
  const validationDir = join(process.cwd(), 'tmp', 'validation');
  mkdirSync(validationDir, { recursive: true });
  await page.screenshot({ path: join(validationDir, 'case-controls.png'), fullPage: true });

  await page.getByRole('button', { name: '删除当前案例' }).click();
  let deleteDialog = page.getByRole('dialog', { name: '删除当前案例？' });
  await expect(deleteDialog).toContainText(`此操作会将“${thirdCaseName}”从案例列表移除，历史资料会保留。`);
  await deleteDialog.getByRole('button', { name: '取消' }).click();
  await expect(deleteDialog).toHaveCount(0);
  await expect(page.getByRole('heading', { name: thirdCaseName, exact: true })).toBeVisible();
  await expect(caseList.getByText(thirdCaseName, { exact: true })).toBeVisible();

  await page.getByRole('button', { name: '删除当前案例' }).click();
  deleteDialog = page.getByRole('dialog', { name: '删除当前案例？' });
  await deleteDialog.getByRole('button', { name: '移除案例' }).click();
  await expect(page.getByRole('heading', { name: `${clientName}（1）`, exact: true })).toBeVisible();
  await expect(caseList.getByText(thirdCaseName, { exact: true })).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('案例已从列表移除，历史资料仍然保留。');
  expect(paidApiRequests).toEqual([]);
});
