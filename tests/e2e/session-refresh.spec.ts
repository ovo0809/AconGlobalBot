import { expect, test, type Page } from '@playwright/test';

function bootstrap() {
  return {
    csrf:'session-refresh-csrf',mode:'advisor',
    user:{id:'reviewer-refresh',name:'Charles',email:'reviewer@example.invalid',role:'reviewer',orgId:'org-refresh',emailVerified:true},
    clients:[],cases:[],activeCase:null,messages:[],facts:[],reports:[],notifications:[],reviews:[],
    capabilities:{analysis:'mock',interview:'mock',voice:'mock',voiceConfigured:false,mail:'dry-run'},demo:true,
  };
}

function deferred() {
  let resolve!:()=>void;
  const promise=new Promise<void>(done=>{resolve=done;});
  return {promise,resolve};
}

for(const failBootstrap of [false,true]){
  test(`entering client mode clears private DOM in every tab before bootstrap ${failBootstrap?'fails':'finishes'}`,async({page,context})=>{
    const release=deferred();let entered=false,checks=0;
    const record={id:'boundary-case',clientId:'boundary-client',ownerAgentId:'boundary-advisor',assignedReviewerId:'reviewer-refresh',status:'draft',entry:null,reportVersion:0,createdAt:'2026-10-31T00:00:00Z',updatedAt:'2026-10-31T00:00:00Z',clientName:'合成权限边界客户'};
    const advisor={...bootstrap(),user:{...bootstrap().user,id:record.ownerAgentId,role:'advisor'},cases:[record],activeCase:record,
      clients:[{id:record.clientId,name:record.clientName,state:'CA',language:'中文',ownerAgentId:record.ownerAgentId}],
      messages:[{id:'private-message',caseId:record.id,sessionId:'advisor-note',role:'user',text:'仅顾问可见的合成历史',final:true}]};
    await context.route('**/api/bootstrap*',async route=>{
      if(!entered)return route.fulfill({json:advisor});
      checks++;await release.promise;
      return route.fulfill(failBootstrap?{status:503,json:{error:'synthetic bootstrap failure'}}:{json:{...bootstrap(),mode:'client',user:null,clientSession:{id:'boundary-interview',state:'active',entry:null}}});
    });
    await context.route('**/api/action',async route=>{
      expect(route.request().postDataJSON().action).toBe('enterClient');entered=true;
      await route.fulfill({json:{ok:true,caseId:record.id}});
    });
    await page.goto('/');await expect(page.locator('.case-sidebar')).toBeVisible();
    const mirror=await context.newPage();await mirror.goto('/');await expect(mirror.locator('.case-sidebar')).toBeVisible();
    await page.getByRole('button',{name:'开始客户访谈'}).click();
    try{
      await expect.poll(()=>checks).toBeGreaterThanOrEqual(1);
      for(const tab of [page,mirror]){
        await expect(tab.locator('.case-sidebar')).toHaveCount(0);
        await expect(tab.getByText('仅顾问可见的合成历史',{exact:true})).toHaveCount(0);
        await expect(tab.getByText('正在恢复安全会话…')).toBeVisible();
      }
    }finally{release.resolve();}
    for(const tab of [page,mirror]){
      if(failBootstrap)await expect(tab.getByRole('button',{name:'重新连接'})).toBeVisible();
      else await expect(tab.getByText('受限客户模式')).toBeVisible();
      await expect(tab.locator('.case-sidebar')).toHaveCount(0);
    }
    await mirror.close();
  });
}

async function openDraft(page:Page) {
  await page.route('**/api/materials*',route=>route.fulfill({json:{items:[],provider:'mock',configured:true}}));
  await page.goto('/');
  await page.getByRole('button',{name:'资料库',exact:true}).click();
  await page.getByLabel('资料名称').fill('私有未提交草稿');
}

test('session verification masks the mounted workspace until the latest check completes',async({page})=>{
  const first=deferred(),second=deferred();
  let pending=false,checks=0;
  await page.route('**/api/bootstrap*',async route=>{
    if(pending){checks+=1;await(checks===1?first:second).promise;}
    await route.fulfill({json:bootstrap()});
  });
  await openDraft(page);
  pending=true;
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect.poll(()=>checks).toBe(1);
  await expect(page.locator('input[value="私有未提交草稿"]')).toHaveCount(1);
  await expect(page.locator('.material-library')).toBeHidden();
  await expect(page.getByText('正在恢复安全会话…')).toBeVisible();
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect.poll(()=>checks).toBe(2);
  const firstResponse=page.waitForResponse('**/api/bootstrap*');
  first.resolve();await firstResponse;
  await expect(page.locator('.material-library')).toBeHidden();
  second.resolve();
  await expect(page.getByLabel('资料名称')).toHaveValue('私有未提交草稿');
  await expect(page.getByLabel('资料名称')).toBeVisible();
});

test('failed verification clears the private draft and retry restores the authenticated workspace',async({page})=>{
  let failed=false;
  await page.route('**/api/bootstrap*',route=>route.fulfill(failed?{status:503,json:{error:'synthetic unavailable'}}:{json:bootstrap()}));
  await openDraft(page);
  failed=true;
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('button',{name:'重新连接'})).toBeVisible();
  await expect(page.locator('.material-library')).toHaveCount(0);
  await expect(page.locator('input[value="私有未提交草稿"]')).toHaveCount(0);
  failed=false;
  await page.getByRole('button',{name:'重新连接'}).click();
  await page.getByRole('button',{name:'资料库',exact:true}).click();
  await expect(page.getByLabel('资料名称')).toHaveValue('');
});

test('an already scheduled report poll cannot finish or overwrite a pending session check',async({page})=>{
  const releaseCheck=deferred();
  let checking=false,checkStarted=false,pollFinished=false;
  const record={id:'refresh-case',clientId:'refresh-client',ownerAgentId:'advisor-refresh',assignedReviewerId:'reviewer-refresh',status:'pending_review',entry:'life',clientName:'合成轮询案例',reportVersion:0,createdAt:'2026-10-31T00:00:00Z',updatedAt:'2026-10-31T00:00:00Z'};
  await page.route('**/api/bootstrap*',async route=>{
    const data={...bootstrap(),cases:[record],activeCase:record,reportJob:{caseId:record.id,status:'generating',attempts:1,updatedAt:record.updatedAt}};
    if(checking&&!checkStarted){
      checkStarted=true;await releaseCheck.promise;
      await route.fulfill({json:{...bootstrap(),mode:'anonymous',user:null}});
    }else{
      await route.fulfill({json:data});
      if(checking)pollFinished=true;
    }
  });
  await openDraft(page);
  checking=true;
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect.poll(()=>checkStarted).toBe(true);
  await expect.poll(()=>pollFinished).toBe(true);
  await expect(page.getByText('正在恢复安全会话…')).toBeVisible();
  await expect(page.locator('.material-library')).toBeHidden();
  releaseCheck.resolve();
  await expect(page.getByRole('button',{name:'登录工作台'})).toBeVisible();
  await expect(page.locator('.material-library')).toHaveCount(0);
});

for(const change of ['reviewer','session','advisor','logout'] as const){
  test(`session verification discards the previous library draft on ${change} change`,async({page})=>{
    let changed=false;
    await page.route('**/api/bootstrap*',route=>{
      const data=bootstrap();
      if(changed){
        if(change==='reviewer')data.user={...data.user,id:'another-reviewer',name:'Other reviewer'};
        if(change==='session')data.csrf='replacement-session-csrf';
        if(change==='advisor')data.user={...data.user,role:'advisor'};
        if(change==='logout')data.mode='anonymous';
      }
      return route.fulfill({json:data});
    });
    await openDraft(page);
    changed=true;
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await expect(page.locator('.material-library')).toHaveCount(0);
    await expect(page.locator('input[value="私有未提交草稿"]')).toHaveCount(0);
    if(change==='reviewer'||change==='session'){
      await page.getByRole('button',{name:'资料库',exact:true}).click();
      await expect(page.getByLabel('资料名称')).toHaveValue('');
    }else if(change==='advisor'){
      await expect(page.getByRole('heading',{name:'我的客户',exact:false})).toBeVisible();
      await expect(page.getByRole('button',{name:'资料库',exact:true})).toHaveCount(0);
    }else await expect(page.getByRole('button',{name:'登录工作台'})).toBeVisible();
  });
}
