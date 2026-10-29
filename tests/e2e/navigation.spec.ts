import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const createdAt='2026-10-28T03:00:00.000Z';
const updatedAt='2026-10-28T08:00:00.000Z';
const validationDir=join(process.cwd(),'tmp','validation');

type Role='advisor'|'reviewer';
type StubCase={id:string;clientId:string;ownerAgentId:string;status:string;entry:'life';createdAt:string;updatedAt:string;assignedReviewerId:string|null;reportVersion:number;clientName:string};

const cases:StubCase[]=[
  {id:'case-draft',clientId:'client-draft',ownerAgentId:'advisor-1',status:'draft',entry:'life',createdAt,updatedAt,assignedReviewerId:null,reportVersion:1,clientName:'草稿客户'},
  {id:'case-pending',clientId:'client-pending',ownerAgentId:'advisor-1',status:'pending_review',entry:'life',createdAt,updatedAt,assignedReviewerId:'charles',reportVersion:1,clientName:'待复核客户'},
  {id:'case-reviewed',clientId:'client-reviewed',ownerAgentId:'advisor-1',status:'reviewed',entry:'life',createdAt,updatedAt,assignedReviewerId:'charles',reportVersion:1,clientName:'已复核客户'},
  {id:'case-returned',clientId:'client-returned',ownerAgentId:'advisor-1',status:'returned',entry:'life',createdAt,updatedAt,assignedReviewerId:'charles',reportVersion:1,clientName:'退回客户'},
  {id:'case-regenerated',clientId:'client-regenerated',ownerAgentId:'advisor-1',status:'needs_report',entry:'life',createdAt,updatedAt,assignedReviewerId:'charles',reportVersion:1,clientName:'已交接待重生成客户'},
];

function clientFor(record:StubCase) {
  return {id:record.clientId,name:record.clientName,birthday:'1985-06-15',gender:'女性',phone:'+12025550100',email:`${record.clientId}@example.invalid`,maritalStatus:'已婚',state:'CA',language:'普通话',ownerAgentId:'advisor-1',consentStatus:'synthetic_demo',createdAt};
}

function reportFor(record:StubCase) {
  return {
    caseId:record.id,clientId:record.clientId,version:1,snapshotId:`snapshot-${record.id}`,
    reviewStatus:record.status==='reviewed'?'reviewed':record.status==='returned'?'returned':'draft',createdAt,ruleVersion:'demo_unapproved_v1',provider:'mock',
    title:`${record.clientName}内部报告`,summary:`${record.clientName}的合成报告摘要。`,sections:[{title:'案例摘要',body:`${record.clientName}的合成报告内容。`}],fullText:'合成报告正文',analyses:[],facts:[],stale:record.status==='needs_report',
    recipientFingerprint:`recipient-${record.id}`,recipients:[],pdfUrl:`/api/report?caseId=${record.id}&version=1&format=pdf`,pdfReady:true,
  };
}

function bootstrap(role:Role,activeCase:StubCase|null,records:StubCase[]=cases) {
  return {
    csrf:'test-csrf',mode:'advisor',
    user:role==='advisor'
      ? {id:'advisor-1',name:'林顾问',email:'advisor1@aeconn.example',role:'advisor',orgId:'org-demo',emailVerified:false}
      : {id:'charles',name:'Charles',email:'charles@aeconn.example',role:'reviewer',orgId:'org-demo',emailVerified:true},
    clients:records.map(clientFor),cases:records,deletedCases:[],activeCase,
    messages:[],facts:[],reports:activeCase?[reportFor(activeCase)]:[],notifications:[],reviews:[],
    capabilities:{analysis:'mock（模拟分析）',interview:'模拟访谈',voice:'实时语音未配置',voiceConfigured:false,mail:'dry-run（未发送）'},demo:true,
  };
}

function anonymousBootstrap() {
  return {
    csrf:'anonymous-csrf',mode:'anonymous',user:null,clients:[],cases:[],activeCase:null,
    messages:[],facts:[],reports:[],notifications:[],reviews:[],
    capabilities:{analysis:'mock（模拟分析）',voice:'实时语音未配置',voiceConfigured:false,mail:'dry-run（未发送）'},demo:true,
  };
}

async function stubBootstrap(page:Page,role:Role,initialCase:StubCase|null,records:StubCase[]=cases) {
  await page.route('**/api/bootstrap*',route=>{
    const requested=new URL(route.request().url()).searchParams.get('caseId');
    const active=requested?records.find(record=>record.id===requested)??null:initialCase;
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(bootstrap(role,active,records))});
  });
}

function caseList(page:Page) { return page.locator('.case-list'); }

function deferred() {
  let resolve!:()=>void;
  const promise=new Promise<void>(done=>{resolve=done;});
  return {promise,resolve};
}

test('顾问的客户与复核是不同列表，复核范围保留已交接历史',async({page})=>{
  await stubBootstrap(page,'advisor',cases[0]);
  await page.setViewportSize({width:1440,height:900});
  await page.goto('/');

  await expect(page.getByRole('heading',{name:'我的客户'})).toBeVisible();
  for(const record of cases)await expect(caseList(page).getByText(record.clientName,{exact:true})).toBeVisible();
  await page.getByPlaceholder('搜索客户或案例').fill('草稿客户');
  await expect(caseList(page).getByText('草稿客户',{exact:true})).toBeVisible();
  await expect(caseList(page).getByText('待复核客户',{exact:true})).toHaveCount(0);

  await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'复核',exact:true}).click();
  await expect(page.getByRole('heading',{name:'待 Charles 复核'})).toBeVisible();
  await expect(page.getByLabel('复核范围')).toHaveValue('pending');
  await expect(page.getByPlaceholder('搜索客户或案例')).toHaveValue('');
  await expect(caseList(page).getByText('待复核客户',{exact:true})).toBeVisible();
  await expect(caseList(page).getByRole('button')).toHaveCount(1);
  await expect(page.getByRole('heading',{name:'待复核客户内部报告'})).toBeVisible();
  const submitted=page.getByRole('button',{name:'已提交，等待 Charles 复核',exact:true});
  await expect(submitted).toBeVisible();
  await expect(submitted).toBeDisabled();
  await expect(page.getByRole('button',{name:'新建客户'})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'新案例',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'删除当前案例'})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'开始客户访谈'})).toHaveCount(0);
  await expect(page.getByLabel('复核理由／备注')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'确认复核'})).toHaveCount(0);
  mkdirSync(validationDir,{recursive:true});
  await page.screenshot({path:join(validationDir,'review-nav-desktop.png'),fullPage:true});

  await page.getByLabel('复核范围').selectOption('all');
  await expect(page.getByRole('heading',{name:'已交接案例'})).toBeVisible();
  await expect(caseList(page).getByText('草稿客户',{exact:true})).toHaveCount(0);
  for(const record of cases.filter(item=>item.assignedReviewerId))await expect(caseList(page).getByText(record.clientName,{exact:true})).toBeVisible();
  await caseList(page).getByText('已复核客户',{exact:true}).click();
  await expect(page.getByRole('heading',{name:'已复核客户内部报告'})).toBeVisible();

  await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'客户',exact:true}).click();
  await expect(page.getByRole('heading',{name:'我的客户'})).toBeVisible();
  for(const record of cases)await expect(caseList(page).getByText(record.clientName,{exact:true})).toBeVisible();
});

test('复核空队列不会继续显示客户页的旧案例详情',async({page})=>{
  const noPending=cases.filter(record=>record.status!=='pending_review');
  await stubBootstrap(page,'advisor',noPending[0],noPending);
  await page.goto('/');
  await expect(page.getByRole('heading',{name:'草稿客户内部报告'})).toHaveCount(0);
  await page.getByRole('button',{name:/内部报告/}).click();
  await expect(page.getByRole('heading',{name:'草稿客户内部报告'})).toBeVisible();

  await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'复核',exact:true}).click();
  await expect(page.getByText('暂无待复核案例',{exact:true})).toBeVisible();
  await expect(page.getByText('在“客户”的内部报告中提交 Charles 复核后，案例会出现在这里。',{exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'草稿客户内部报告'})).toHaveCount(0);
  await expect(page.locator('.report-view')).toHaveCount(0);
});

test('移动端进入复核先显示队列；Charles 可切换查看已交接历史',async({page})=>{
  await stubBootstrap(page,'advisor',cases[0]);
  await page.setViewportSize({width:390,height:844});
  await page.goto('/');
  await caseList(page).getByText('草稿客户',{exact:true}).click();
  await expect(page.getByRole('heading',{name:'草稿客户',exact:true})).toBeVisible();
  await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'复核',exact:true}).click();
  await expect(page.getByRole('heading',{name:'待 Charles 复核'})).toBeVisible();
  await expect(caseList(page).getByText('待复核客户',{exact:true})).toBeVisible();
  await expect(page.locator('.case-sidebar')).toBeVisible();
  await expect(page.locator('.workspace')).not.toHaveClass(/mobile-show/);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  mkdirSync(validationDir,{recursive:true});
  await page.screenshot({path:join(validationDir,'review-nav-mobile.png')});

  const reviewerPage=await page.context().newPage();
  await reviewerPage.setViewportSize({width:390,height:844});
  await stubBootstrap(reviewerPage,'reviewer',cases[2]);
  await reviewerPage.goto('/');
  await expect(reviewerPage.getByRole('heading',{name:'待我复核'})).toBeVisible();
  await expect(caseList(reviewerPage).getByText('待复核客户',{exact:true})).toBeVisible();
  await expect(caseList(reviewerPage).getByText('已复核客户',{exact:true})).toHaveCount(0);
  await expect(reviewerPage.getByRole('heading',{name:'已复核客户内部报告'})).toHaveCount(0);
  await caseList(reviewerPage).getByText('待复核客户',{exact:true}).click();
  await expect(reviewerPage.getByRole('heading',{name:'待复核客户内部报告'})).toBeVisible();
  await expect(reviewerPage.getByLabel('复核理由／备注')).toBeVisible();
  await reviewerPage.getByRole('button',{name:'返回案例列表'}).click();
  await reviewerPage.getByLabel('复核范围').selectOption('all');
  await expect(reviewerPage.getByRole('heading',{name:'已交接案例'})).toBeVisible();
  await expect(caseList(reviewerPage).getByText('已复核客户',{exact:true})).toBeVisible();
  await expect(caseList(reviewerPage).getByText('退回客户',{exact:true})).toBeVisible();
  await expect(caseList(reviewerPage).getByText('已交接待重生成客户',{exact:true})).toBeVisible();
  await reviewerPage.close();
});

test('较晚返回的复核响应不能覆盖已经切回的客户案例',async({page})=>{
  const pendingStarted=deferred();
  const releasePending=deferred();
  const pendingFinished=deferred();
  await page.route('**/api/bootstrap*',async route=>{
    const requested=new URL(route.request().url()).searchParams.get('caseId');
    if(requested==='case-pending'){
      pendingStarted.resolve();
      await releasePending.promise;
    }
    const active=requested?cases.find(record=>record.id===requested)??null:cases[0];
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(bootstrap('advisor',active))});
    if(requested==='case-pending')pendingFinished.resolve();
  });
  await page.goto('/');
  const nav=page.getByRole('navigation',{name:'主导航'});
  await nav.getByRole('button',{name:'复核',exact:true}).click();
  await pendingStarted.promise;
  await nav.getByRole('button',{name:'客户',exact:true}).click();
  await expect(page.getByRole('heading',{name:'我的客户'})).toBeVisible();
  await expect(page.locator('.workspace-header h1')).toHaveText('草稿客户');
  await expect(caseList(page).locator('.case-item.selected')).toContainText('草稿客户');

  releasePending.resolve();
  await pendingFinished.promise;
  await expect(page.getByRole('heading',{name:'我的客户'})).toBeVisible();
  await expect(page.getByLabel('复核范围')).toHaveCount(0);
  await expect(page.locator('.workspace-header h1')).toHaveText('草稿客户');
  await expect(caseList(page).locator('.case-item.selected')).toContainText('草稿客户');
  for(const record of cases)await expect(caseList(page).getByText(record.clientName,{exact:true})).toBeVisible();
});

test('移动端旧的选案响应结束后仍停留在复核队列',async({page})=>{
  const selectionStarted=deferred();
  const releaseSelection=deferred();
  const selectionFinished=deferred();
  await page.route('**/api/bootstrap*',async route=>{
    const requested=new URL(route.request().url()).searchParams.get('caseId');
    if(requested==='case-reviewed'){
      selectionStarted.resolve();
      await releaseSelection.promise;
    }
    const active=requested?cases.find(record=>record.id===requested)??null:cases[0];
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(bootstrap('advisor',active))});
    if(requested==='case-reviewed')selectionFinished.resolve();
  });
  await page.setViewportSize({width:390,height:844});
  await page.goto('/');
  await caseList(page).getByText('已复核客户',{exact:true}).click();
  await selectionStarted.promise;
  await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'复核',exact:true}).click();
  await expect(page.getByRole('heading',{name:'待 Charles 复核'})).toBeVisible();
  await expect(caseList(page).getByText('待复核客户',{exact:true})).toBeVisible();
  await expect(page.locator('.case-sidebar')).toBeVisible();
  await expect(page.locator('.workspace')).not.toHaveClass(/mobile-show/);

  releaseSelection.resolve();
  await selectionFinished.promise;
  await expect(page.getByRole('heading',{name:'待 Charles 复核'})).toBeVisible();
  await expect(page.locator('.case-sidebar')).toBeVisible();
  await expect(page.locator('.workspace')).not.toHaveClass(/mobile-show/);
  await expect(caseList(page).locator('.case-item.selected')).toContainText('待复核客户');
});

test('首次匿名会话完成前的页面事件共用同一请求和 CSRF 会话',async({page})=>{
  const initialStarted=deferred();
  const releaseInitial=deferred();
  let anonymousRequests=0;
  let loggedIn=false;
  let loginHeaders:{csrf?:string;cookie?:string}|undefined;

  await page.route('**/api/bootstrap*',async route=>{
    if(loggedIn){
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(bootstrap('advisor',cases[0]))});
      return;
    }
    anonymousRequests+=1;
    initialStarted.resolve();
    await releaseInitial.promise;
    await route.fulfill({
      status:200,
      headers:{'content-type':'application/json','set-cookie':'aeconn_session=anonymous-token; HttpOnly; SameSite=Strict; Path=/'},
      body:JSON.stringify(anonymousBootstrap()),
    });
  });
  await page.route('**/api/action',async route=>{
    const headers=route.request().headers();
    loginHeaders={csrf:headers['x-csrf-token'],cookie:headers.cookie};
    loggedIn=true;
    await route.fulfill({
      status:200,
      headers:{'content-type':'application/json','set-cookie':'aeconn_session=advisor-token; HttpOnly; SameSite=Strict; Path=/'},
      body:JSON.stringify({ok:true}),
    });
  });

  const navigation=page.goto('/');
  await initialStarted.promise;
  await page.evaluate(()=>{
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new PageTransitionEvent('pageshow'));
  });
  await page.waitForTimeout(100);
  expect(anonymousRequests).toBe(1);
  releaseInitial.resolve();
  await navigation;
  await expect(page.getByRole('button',{name:'登录工作台'})).toBeVisible();

  await page.getByRole('button',{name:'登录工作台'}).click();
  await expect(page.getByRole('heading',{name:'我的客户'})).toBeVisible();
  expect(loginHeaders?.csrf).toBe('anonymous-csrf');
  expect(loginHeaders?.cookie).toContain('aeconn_session=anonymous-token');
});
