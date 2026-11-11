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

test('案例排序支持更新、建档和姓名，搜索及当前案例保持不变',async({page})=>{
  const records:StubCase[]=[
    {...cases[0],clientName:'Carol',createdAt:'2026-10-03T00:00:00Z',updatedAt:'2026-10-05T10:00:00+08:00'},
    {...cases[1],clientName:'Alice',createdAt:'2026-10-01T00:00:00Z',updatedAt:'2026-10-05T03:00:00Z'},
    {...cases[2],clientName:'Bob',createdAt:'2026-10-02T00:00:00Z',updatedAt:'2026-10-04T12:00:00Z'},
  ];
  let writes=0;
  await stubBootstrap(page,'advisor',records[0],records);
  await page.route('**/api/action',route=>{writes++;return route.fulfill({json:{ok:true}});});
  await page.setViewportSize({width:1440,height:900});await page.goto('/');
  const sort=page.getByRole('combobox',{name:'案例排序'});
  const names=caseList(page).locator('.case-copy b');
  await expect(sort).toHaveValue('updated_desc');
  await expect(names).toHaveText(['Alice','Carol','Bob']);
  for(const [value,expected] of [
    ['updated_asc',['Bob','Carol','Alice']],['created_desc',['Carol','Bob','Alice']],
    ['created_asc',['Alice','Bob','Carol']],['name',['Alice','Bob','Carol']],
  ] as const){
    await sort.selectOption(value);await expect(names).toHaveText([...expected]);
    await expect(caseList(page).locator('.selected .case-copy b')).toHaveText('Carol');
    await expect(page.locator('.client-identity b')).toHaveText('Carol');
    if(value.startsWith('created'))await expect(caseList(page).locator('.selected time')).toHaveAttribute('datetime',records[0].createdAt);
  }
  await page.getByPlaceholder('搜索客户或案例').fill('al');await expect(names).toHaveText(['Alice']);
  await sort.selectOption('updated_asc');await expect(names).toHaveText(['Alice']);
  await expect(page.locator('.directory-summary')).toContainText('1 份案例');
  await page.getByPlaceholder('搜索客户或案例').fill('');await expect(names).toHaveText(['Bob','Carol','Alice']);
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(sort).toHaveValue('updated_asc');await expect(names).toHaveText(['Bob','Carol','Alice']);
  expect(writes).toBe(0);
});

test('手机复核列表的排序与复核范围独立且不溢出',async({page})=>{
  const records=cases.map((record,index)=>({...record,updatedAt:`2026-10-${String(20+index).padStart(2,'0')}T12:00:00Z`}));
  await stubBootstrap(page,'reviewer',records[1],records);
  await page.setViewportSize({width:360,height:640});await page.goto('/');
  const sort=page.getByRole('combobox',{name:'案例排序'});
  await expect(caseList(page).getByRole('button')).toHaveCount(1);
  await sort.selectOption('updated_asc');
  await page.getByLabel('复核范围').selectOption('all');
  await expect(caseList(page).locator('.case-copy b')).toHaveText(records.slice(1).map(record=>record.clientName));
  await expect(sort).toHaveValue('updated_asc');
  await sort.selectOption('updated_desc');
  await expect(caseList(page).locator('.case-copy b')).toHaveText(records.slice(1).reverse().map(record=>record.clientName));
  await expect(sort).toBeInViewport();
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  const screenshots=join(validationDir,'case-sort');mkdirSync(screenshots,{recursive:true});
  await page.screenshot({path:join(screenshots,'reviewer-mobile.png')});
});

test('报告长标题与复核操作在桌面和手机可读可达，提交保留原动作',async({page})=>{
  const record={...cases[1],clientName:'长期照护与退休现金流规划客户（合成）'};
  const payload=bootstrap('reviewer',record,[record]);
  payload.reports[0].sections=[
    {title:'一、客户画像',body:'客户希望提前安排退休后的长期照护，并减少家人的照护压力。具体预算和启动时间尚待核实。'},
    {title:'二、四类初步方向',body:'现阶段优先了解照护安排和退休现金流，其他方向资料不足，交由顾问确认。'},
    {title:'三、证据与理由',body:'本页面使用合成资料验证显示与操作，不代表业务审核结论。'},
    {title:'四、限制与缺失',body:'预算金额、现有保障与照护安排待核实。'},
    {title:'五、下次问题',body:'您希望优先在家接受照护，还是考虑专业机构？'},
    {title:'六、交接摘要',body:'请结合客户原话核对上述需求，再记录复核意见。'},
  ];
  const submissions:unknown[]=[];
  await page.route('**/api/bootstrap*',route=>route.fulfill({json:payload}));
  await page.route('**/api/action',route=>{submissions.push(route.request().postDataJSON());return route.fulfill({json:{ok:true}});});
  const screenshots=join(validationDir,'ui-polish');mkdirSync(screenshots,{recursive:true});
  for(const viewport of [{width:1440,height:1000},{width:1024,height:900},{width:768,height:900},{width:390,height:844},{width:360,height:640}]){
    await page.setViewportSize(viewport);await page.goto('/');
    if(viewport.width<=760)await caseList(page).getByRole('button').click();
    await expect(page.getByRole('heading',{name:payload.reports[0].title})).toBeVisible();
    await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
    await expect.poll(()=>page.locator('.workspace-body').evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
    if(viewport.width<=760){
      const title=await page.locator('.workspace-header h1').boundingBox();
      const status=await page.locator('.workspace-header .status').boundingBox();
      expect(title).not.toBeNull();expect(status).not.toBeNull();
      expect(title!.x+title!.width).toBeLessThanOrEqual(status!.x+1);
    }
    await page.getByRole('link',{name:'预览 PDF'}).scrollIntoViewIfNeeded();
    await expect(page.getByRole('link',{name:'预览 PDF'})).toBeInViewport();
    await page.screenshot({path:join(screenshots,`report-${viewport.width}.png`)});
    const reason=page.getByLabel('复核理由／备注');
    const confirm=page.getByRole('button',{name:'确认复核',exact:true});
    await expect(confirm).toBeDisabled();
    await reason.fill('合成界面验证：保留现有复核动作与理由。');
    await confirm.scrollIntoViewIfNeeded();
    await expect(confirm).toBeEnabled();await expect(confirm).toBeInViewport();
    for(const name of ['退回补问','记录修改','确认复核']){
      const box=await page.getByRole('button',{name,exact:true}).boundingBox();
      expect(box).not.toBeNull();expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x+box!.width).toBeLessThanOrEqual(viewport.width+1);
    }
    await page.screenshot({path:join(screenshots,`review-${viewport.width}.png`)});
  }
  await page.getByRole('button',{name:'确认复核',exact:true}).click();
  await expect.poll(()=>submissions.length).toBe(1);
  expect(submissions[0]).toMatchObject({action:'review',caseId:record.id,decision:'approved',reason:'合成界面验证：保留现有复核动作与理由。'});
});

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
