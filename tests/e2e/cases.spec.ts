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

test('案例回收站支持还原、确认彻底删除、失败重试和稳定编号', async ({ page, context }) => {
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

  const nav=page.getByRole('navigation',{name:'主导航'});
  await expect(nav.getByRole('button')).toHaveText(['客户','复核','设置','已删除案例']);
  await nav.getByRole('button',{name:'已删除案例'}).click();
  let trashCard=page.getByRole('article',{name:thirdCaseName,exact:true});
  await expect(trashCard).toBeVisible();
  await expect(trashCard).toContainText('删除于');
  await page.getByLabel('搜索已删除案例').fill('不存在的合成名称');
  await expect(page.getByText('没有匹配的案例')).toBeVisible();
  await page.getByLabel('搜索已删除案例').fill('');
  await trashCard.getByRole('button',{name:'还原',exact:true}).click();
  await expect(page.getByRole('heading',{name:thirdCaseName,exact:true})).toBeVisible();
  await expect(caseList.getByText(thirdCaseName,{exact:true})).toBeVisible();

  const mirror=await context.newPage();
  await mirror.goto('/');
  await mirror.locator('.case-item').filter({hasText:thirdCaseName}).click();
  await expect(mirror.getByRole('heading',{name:thirdCaseName,exact:true})).toBeVisible();
  await page.getByRole('button',{name:'删除当前案例'}).click();
  await page.getByRole('dialog',{name:'删除当前案例？'}).getByRole('button',{name:'移除案例'}).click();
  await expect(mirror.getByRole('heading',{name:`${clientName}（1）`,exact:true})).toBeVisible();
  await mirror.close();
  await nav.getByRole('button',{name:'已删除案例'}).click();
  trashCard=page.getByRole('article',{name:thirdCaseName,exact:true});
  await page.screenshot({path:join(validationDir,'trash-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await expect(trashCard).toBeVisible();
  await expect.poll(async()=>(await trashCard.getByRole('button',{name:'彻底删除',exact:true}).boundingBox())?.width).toBeGreaterThan(125);
  await expect.poll(async()=>(await trashCard.getByRole('button',{name:'彻底删除',exact:true}).boundingBox())?.height).toBeLessThan(65);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:join(validationDir,'trash-mobile.png')});
  await trashCard.getByRole('button',{name:'彻底删除',exact:true}).click();
  let purgeDialog=page.getByRole('dialog',{name:'彻底删除案例？'});
  await expect(purgeDialog).toContainText(thirdCaseName);
  await expect(purgeDialog.getByRole('button',{name:'确认彻底删除'})).toBeDisabled();
  await purgeDialog.getByLabel('请输入“永久删除”确认').fill('删除');
  await expect(purgeDialog.getByRole('button',{name:'确认彻底删除'})).toBeDisabled();
  await purgeDialog.getByRole('button',{name:'取消'}).click();
  await expect(trashCard).toBeVisible();

  let blockPurge=true;
  await page.route('**/api/action',async route=>{
    const body=route.request().postDataJSON() as {action?:string};
    if(body.action==='purgeCase'&&blockPurge){blockPurge=false;await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'合成测试：删除暂未完成，请重试。'})});return;}
    await route.continue();
  });
  await trashCard.getByRole('button',{name:'彻底删除',exact:true}).click();
  purgeDialog=page.getByRole('dialog',{name:'彻底删除案例？'});
  await purgeDialog.getByLabel('请输入“永久删除”确认').fill('永久删除');
  await expect(purgeDialog.getByRole('button',{name:'确认彻底删除'})).toBeEnabled();
  await page.screenshot({path:join(validationDir,'trash-confirm-mobile.png')});
  await purgeDialog.getByRole('button',{name:'确认彻底删除'}).click();
  await expect(page.getByRole('status')).toContainText('合成测试：删除暂未完成，请重试。');
  await expect(purgeDialog).toBeVisible();
  await expect(trashCard).toBeVisible();
  await purgeDialog.getByRole('button',{name:'确认彻底删除'}).click();
  await expect(purgeDialog).toHaveCount(0);
  await expect(trashCard).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('历史资料已彻底删除');
  await page.reload();
  await nav.getByRole('button',{name:'已删除案例'}).click();
  await expect(page.getByRole('article',{name:thirdCaseName,exact:true})).toHaveCount(0);
  await page.setViewportSize({width:1440,height:900});
  await nav.getByRole('button',{name:'客户',exact:true}).click();
  await page.getByRole('button',{name:'新案例',exact:true}).click();
  await expect(page.getByRole('heading',{name:`${clientName}（3）`,exact:true})).toBeVisible();
  await expect(caseList.getByText(`${clientName}（1）`,{exact:true})).toBeVisible();
  await expect(caseList.getByText(thirdCaseName,{exact:true})).toHaveCount(0);
  expect(paidApiRequests).toEqual([]);
});
